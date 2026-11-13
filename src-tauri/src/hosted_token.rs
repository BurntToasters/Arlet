//! Release-build MusicKit developer token, fetched at runtime.
//!
//! Release binaries embed no token. `prefetch` (started from setup, before the
//! main window) and `token` (the `get_developer_token` command) share one
//! `HostedTokenState`. Each download is verified in order (size, JSON shape,
//! a minisign signature over a domain-separated payload, then the token
//! policy), cached byte for byte, and the cache is verified again on every
//! read, so an edited cache file is never served. Debug builds do no network.

// Failure modes (module-wide), each covered by a test below: a body over the
// 16 KiB cap; non-JSON or non-object bodies; a wrong `version`, missing or
// wrong-typed fields, and unknown fields; a signature by another key, over the
// bare JWT, or an updater-artifact signature replayed onto the token; a token
// edited after signing; a signature that is not base64 or not minisign text; a
// validly signed token that is expired, carries an origin claim, or is not
// ES256; an older signed file replacing a newer cache; a tampered, truncated,
// or stray-temp cache; a stalled, redirected, non-200, oversized, or
// unreachable server, with and without a cache; a non-HTTPS URL outside E2E
// builds; E2E variables read by an ordinary build; a malformed public key; and
// error text that echoes the token.

use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::token_policy::{self, PolicyError};
use crate::{app_paths, logging};

/// The only source an ordinary build ever downloads from.
pub const PRODUCTION_TOKEN_URL: &str =
    "https://music-api.arlet.rosiecdn.win/musickit/arlet-token.json";
/// Domain separation: a signature over the bare JWT, or over any updater
/// artifact, cannot verify against this prefix.
const SIGNED_PREFIX: &str = "arlet-musickit-developer-token-v1\n";
const FILE_VERSION: u64 = 1;
/// The hosted file is under 1 KB; anything past this cap is refused unread.
const MAX_FILE_BYTES: usize = 16 * 1024;
/// Total budget for one download, body included.
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const CACHE_FILE_NAME: &str = "musickit-token.json";
const USER_AGENT: &str = concat!("Arlet/", env!("CARGO_PKG_VERSION"));

/// E2E-only overrides. Ordinary builds never read these variables.
#[cfg(feature = "e2e")]
const E2E_TOKEN_URL_ENV: &str = "ARLET_E2E_TOKEN_URL";
#[cfg(feature = "e2e")]
const E2E_TOKEN_PUBKEY_ENV: &str = "ARLET_E2E_TOKEN_PUBKEY";

/// After a download fails, later calls serve the cache for this many seconds
/// instead of downloading again. A prefetch that just timed out is therefore
/// not repeated by the webview's first call, while Reconnect still retries.
const FAILED_FETCH_RETRY_SECS: u64 = 10;

/// Process-wide state. The async mutex is held across a download, so a command
/// call waits for an in-flight one.
#[derive(Default)]
pub struct HostedTokenState {
    attempts: tokio::sync::Mutex<Attempts>,
}

/// What this process has learned from its downloads. Guarded by the state lock.
#[derive(Default)]
struct Attempts {
    /// The token from this process's last successful download.
    fetched: Option<VerifiedToken>,
    /// When the last download that produced no valid token finished.
    failed_at: Option<u64>,
}

/// A token whose file passed every check. `bytes` is the signed file, verbatim.
#[derive(Clone)]
struct VerifiedToken {
    token: String,
    exp: u64,
    bytes: Vec<u8>,
}

impl fmt::Debug for VerifiedToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VerifiedToken")
            .field("exp", &self.exp)
            .finish_non_exhaustive()
    }
}

/// The outcome for one candidate file. Rejections carry no detail, so nothing
/// that could be logged can leak the token, the body, or the signature.
#[derive(Debug, Clone)]
enum Verdict {
    Valid(VerifiedToken),
    /// Correctly signed and well-formed, but past its expiry.
    Expired {
        exp: u64,
    },
    Rejected,
}

/// Why no token can be served. Only `Expired` may mention expiry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServeError {
    Expired,
    Unavailable,
}

impl ServeError {
    fn message(self) -> &'static str {
        match self {
            Self::Expired => {
                "Arlet's Apple Music access has expired. Restart Arlet to refresh it."
            }
            Self::Unavailable => {
                "Arlet could not download its Apple Music access token. Check your connection and try again."
            }
        }
    }
}

/// Why a source is unusable or a download could not finish. Values are only
/// compared in tests, so no field-level detail is carried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceError {
    InsecureUrl,
    PublicKey,
    CacheDir,
    Network,
    Status,
    TooLarge,
    Interrupted,
}

/// Where a token comes from and where it is cached.
struct Settings {
    url: String,
    public_key: PublicKey,
    cache_path: PathBuf,
    timeout: Duration,
    /// Plain HTTP to the loopback address. Only E2E builds and tests set it.
    allow_loopback_http: bool,
    /// Unix seconds. Tests substitute a fixed or stepped clock.
    clock: fn() -> u64,
}

impl Settings {
    /// Ordinary builds use the fixed production URL and the public key from
    /// tauri.conf.json. E2E builds may override both through `lookup`.
    fn for_build(
        config_public_key: &str,
        cache_path: PathBuf,
        lookup: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, SourceError> {
        let (url, public_key, allow_loopback_http) = build_source(config_public_key, lookup);
        validate_url(&url, allow_loopback_http)?;
        Ok(Self {
            url,
            public_key: decode_public_key(&public_key)?,
            cache_path,
            timeout: FETCH_TIMEOUT,
            allow_loopback_http,
            clock: unix_now,
        })
    }
}

/// (URL, base64 public key, loopback HTTP allowed) for this build.
#[cfg(feature = "e2e")]
fn build_source(
    config_public_key: &str,
    lookup: impl Fn(&str) -> Option<String>,
) -> (String, String, bool) {
    let override_value = |name: &str| {
        lookup(name)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let url = override_value(E2E_TOKEN_URL_ENV).unwrap_or_else(|| PRODUCTION_TOKEN_URL.to_string());
    let public_key =
        override_value(E2E_TOKEN_PUBKEY_ENV).unwrap_or_else(|| config_public_key.to_string());
    (url, public_key, true)
}

/// (URL, base64 public key, loopback HTTP allowed) for this build.
#[cfg(not(feature = "e2e"))]
fn build_source(
    config_public_key: &str,
    _lookup: impl Fn(&str) -> Option<String>,
) -> (String, String, bool) {
    (
        PRODUCTION_TOKEN_URL.to_string(),
        config_public_key.to_string(),
        false,
    )
}

/// Settings for the running app: the updater public key from tauri.conf.json
/// (`plugins.updater.pubkey`) and the cache under the local data directory.
fn settings_for_app(app: &AppHandle) -> Result<Settings, SourceError> {
    let config = app.config();
    let config_key = config
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let dir = app_paths::local_data_dir(app).map_err(|_| SourceError::CacheDir)?;
    Settings::for_build(config_key, dir.join(CACHE_FILE_NAME), |name| {
        std::env::var(name).ok()
    })
}

fn validate_url(url: &str, allow_loopback_http: bool) -> Result<(), SourceError> {
    let parsed = url::Url::parse(url).map_err(|_| SourceError::InsecureUrl)?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(SourceError::InsecureUrl);
    }
    match parsed.scheme() {
        "https" => Ok(()),
        "http" if allow_loopback_http && parsed.host_str() == Some("127.0.0.1") => Ok(()),
        _ => Err(SourceError::InsecureUrl),
    }
}

/// Decodes a key in the tauri.conf.json format: base64 of minisign text.
fn decode_public_key(base64_text: &str) -> Result<PublicKey, SourceError> {
    let bytes = STANDARD
        .decode(base64_text.trim())
        .map_err(|_| SourceError::PublicKey)?;
    let text = String::from_utf8(bytes).map_err(|_| SourceError::PublicKey)?;
    PublicKey::decode(&text).map_err(|_| SourceError::PublicKey)
}

/// The hosted file. `deny_unknown_fields` keeps the file to the fixed contract.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenFile {
    version: u64,
    token: String,
    /// Base64 of the `.sig` text that `tauri signer sign` writes.
    signature: String,
}

fn decode_signature(field: &str) -> Option<Signature> {
    let bytes = STANDARD.decode(field.trim()).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    Signature::decode(&text).ok()
}

/// Runs every check on a candidate file, in order: size, shape and version,
/// signature over the prefixed token, then the token policy.
fn verify_file(bytes: &[u8], public_key: &PublicKey, now: u64) -> Verdict {
    if bytes.len() > MAX_FILE_BYTES {
        return Verdict::Rejected;
    }
    let Ok(file) = serde_json::from_slice::<TokenFile>(bytes) else {
        return Verdict::Rejected;
    };
    if file.version != FILE_VERSION {
        return Verdict::Rejected;
    }
    let Some(signature) = decode_signature(&file.signature) else {
        return Verdict::Rejected;
    };
    let mut message = Vec::with_capacity(SIGNED_PREFIX.len() + file.token.len());
    message.extend_from_slice(SIGNED_PREFIX.as_bytes());
    message.extend_from_slice(file.token.as_bytes());
    if public_key.verify(&message, &signature, false).is_err() {
        return Verdict::Rejected;
    }
    match token_policy::validate_hosted(&file.token, now) {
        Ok(check) => Verdict::Valid(VerifiedToken {
            token: file.token,
            exp: check.exp,
            bytes: bytes.to_vec(),
        }),
        Err(PolicyError::Expired { exp }) => Verdict::Expired { exp },
        Err(PolicyError::Rejected(_)) => Verdict::Rejected,
    }
}

/// Reads and fully re-verifies the cache. A missing, oversized, symlinked, or
/// unreadable file is simply not a token.
fn read_cache(path: &Path, public_key: &PublicKey, now: u64) -> Verdict {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Verdict::Rejected;
    };
    if !metadata.is_file() {
        return Verdict::Rejected;
    }
    let Ok(file) = File::open(path) else {
        return Verdict::Rejected;
    };
    let mut bytes = Vec::new();
    // One byte past the cap, so an oversized file is detected, not read whole.
    if file
        .take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return Verdict::Rejected;
    }
    verify_file(&bytes, public_key, now)
}

/// A cache entry is replaced only by a file that expires no earlier, so an
/// older signed file cannot roll the cache back. A tampered, expired, or
/// missing cache has nothing to protect.
fn should_replace(fetched_exp: u64, cached: &Verdict) -> bool {
    match cached {
        Verdict::Valid(token) => fetched_exp >= token.exp,
        Verdict::Expired { exp } => fetched_exp >= *exp,
        Verdict::Rejected => true,
    }
}

/// Writes a temp file beside the cache, flushes it, then renames it over the
/// cache. An interrupted write leaves the old cache or a stray temp file, and
/// neither is ever read as the cache.
fn write_cache(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("cache path has no directory"))?;
    fs::create_dir_all(parent)?;
    let mut temp_name = path.file_name().unwrap_or_default().to_os_string();
    temp_name.push(".tmp");
    let temp = path.with_file_name(temp_name);
    let result = (|| {
        let mut file = File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// reqwest is built without a bundled crypto provider, as tauri-plugin-updater
/// does, so ring becomes the process default before the first client exists.
fn ensure_tls_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// One HTTPS GET within the total timeout. Redirects are not followed, cookies
/// are never sent, and only a 200 body up to the cap is returned.
async fn fetch(settings: &Settings) -> Result<Vec<u8>, SourceError> {
    validate_url(&settings.url, settings.allow_loopback_http)?;
    ensure_tls_provider();
    let mut builder = reqwest::Client::builder()
        .https_only(!settings.allow_loopback_http)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(settings.timeout)
        .user_agent(USER_AGENT);
    if settings.allow_loopback_http {
        // Loopback test and E2E servers must not be routed through a proxy.
        builder = builder.no_proxy();
    }
    let client = builder.build().map_err(|_| SourceError::Network)?;
    let mut response = client
        .get(&settings.url)
        .send()
        .await
        .map_err(|_| SourceError::Network)?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(SourceError::Status);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_FILE_BYTES as u64)
    {
        return Err(SourceError::TooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| SourceError::Interrupted)?
    {
        if body.len() + chunk.len() > MAX_FILE_BYTES {
            return Err(SourceError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Downloads and verifies, and caches the file if it is valid and no older
/// than the current cache.
async fn fetch_and_store(settings: &Settings, now: u64) -> Verdict {
    let Ok(bytes) = fetch(settings).await else {
        return Verdict::Rejected;
    };
    let verdict = verify_file(&bytes, &settings.public_key, now);
    if let Verdict::Valid(token) = &verdict {
        let cached = read_cache(&settings.cache_path, &settings.public_key, now);
        if should_replace(token.exp, &cached) {
            // A failed write only means the next launch downloads again.
            let _ = write_cache(&settings.cache_path, &token.bytes);
        }
    }
    verdict
}

/// Serves the candidate with the latest expiry that is still in the future.
/// Candidates that expire no later than `now` count as expired, and only
/// rejected or missing candidates mean the token is unavailable.
fn choose(now: u64, candidates: &[Verdict]) -> Result<VerifiedToken, ServeError> {
    let mut best: Option<&VerifiedToken> = None;
    let mut expired = false;
    for candidate in candidates {
        match candidate {
            Verdict::Valid(token) if token.exp > now => {
                if best.is_none_or(|current| token.exp > current.exp) {
                    best = Some(token);
                }
            }
            Verdict::Valid(_) | Verdict::Expired { .. } => expired = true,
            Verdict::Rejected => {}
        }
    }
    match best {
        Some(token) => Ok(token.clone()),
        None if expired => Err(ServeError::Expired),
        None => Err(ServeError::Unavailable),
    }
}

/// True when no failure is recent enough to block another download. A clock
/// that moved backwards also allows one.
fn retry_allowed(failed_at: Option<u64>, now: u64) -> bool {
    match failed_at {
        Some(failed) if now >= failed => now - failed >= FAILED_FETCH_RETRY_SECS,
        _ => true,
    }
}

impl HostedTokenState {
    /// Waits for any in-flight download. While this process has no successful
    /// download, it downloads again only once the retry window since the last
    /// failure has passed. Then serves the best of the fetched token and the
    /// verified cache.
    async fn serve(&self, settings: &Settings) -> Result<VerifiedToken, ServeError> {
        let now = (settings.clock)();
        let mut attempts = self.attempts.lock().await;
        let latest = match attempts.fetched.clone() {
            Some(token) => Verdict::Valid(token),
            None if !retry_allowed(attempts.failed_at, now) => Verdict::Rejected,
            None => {
                let verdict = fetch_and_store(settings, now).await;
                match &verdict {
                    Verdict::Valid(token) => attempts.fetched = Some(token.clone()),
                    Verdict::Expired { .. } | Verdict::Rejected => {
                        attempts.failed_at = Some((settings.clock)());
                    }
                }
                verdict
            }
        };
        let cached = read_cache(&settings.cache_path, &settings.public_key, now);
        choose(now, &[latest, cached])
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Serves the hosted token for `get_developer_token` (release builds). An
/// unavailable token is logged only in Debug Mode, by category only, and never
/// with the token, body, or signature.
pub async fn token(app: &AppHandle, state: &HostedTokenState) -> Result<String, String> {
    let outcome = match settings_for_app(app) {
        Ok(settings) => state.serve(&settings).await,
        Err(_) => Err(ServeError::Unavailable),
    };
    match outcome {
        Ok(verified) => Ok(verified.token),
        Err(error) => {
            // The native log is written regardless of Debug Mode, and reserved
            // for crashes and startup failures. An offline launch is neither.
            if crate::settings::debug_mode() {
                logging::write_native_log(&format!("MusicKit access token unavailable: {error:?}"));
            }
            Err(error.message().to_string())
        }
    }
}

/// Started from setup so the download overlaps startup. Debug builds return at
/// once and never touch the network.
pub async fn prefetch(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let state = app.state::<HostedTokenState>();
    let _ = token(&app, &state).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use serde_json::{json, Value};
    use std::fs;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    const NOW: u64 = 1_800_000_000;
    const FAR_FUTURE: u64 = 4_102_444_800;

    const VALID: &[u8] = include_bytes!("../tests/fixtures/hosted-token/valid-token.json");
    const OLDER: &[u8] = include_bytes!("../tests/fixtures/hosted-token/older-token.json");
    const EXPIRED: &[u8] = include_bytes!("../tests/fixtures/hosted-token/expired-token.json");
    const ORIGIN: &[u8] = include_bytes!("../tests/fixtures/hosted-token/origin-token.json");
    const HS256: &[u8] = include_bytes!("../tests/fixtures/hosted-token/hs256-token.json");
    const BARE_JWT: &[u8] =
        include_bytes!("../tests/fixtures/hosted-token/bare-jwt-signed-token.json");
    const ARTIFACT: &[u8] =
        include_bytes!("../tests/fixtures/hosted-token/artifact-signed-token.json");
    const OTHER_KEY: &[u8] = include_bytes!("../tests/fixtures/hosted-token/other-key-token.json");
    const PUBLIC_KEY_B64: &str = include_str!("../tests/fixtures/hosted-token/public-key.txt");

    fn pubkey() -> PublicKey {
        decode_public_key(PUBLIC_KEY_B64.trim()).expect("fixture public key")
    }

    fn verify(bytes: &[u8]) -> Verdict {
        verify_file(bytes, &pubkey(), NOW)
    }

    fn is_rejected(verdict: &Verdict) -> bool {
        matches!(verdict, Verdict::Rejected)
    }

    fn field(bytes: &[u8], name: &str) -> String {
        let value: Value = serde_json::from_slice(bytes).expect("fixture json");
        value[name].as_str().expect("fixture string").to_string()
    }

    fn edited(bytes: &[u8], edit: impl FnOnce(&mut Value)) -> Vec<u8> {
        let mut value: Value = serde_json::from_slice(bytes).expect("fixture json");
        edit(&mut value);
        serde_json::to_vec(&value).expect("re-encode fixture")
    }

    fn token(label: &str, exp: u64) -> VerifiedToken {
        VerifiedToken {
            token: label.to_string(),
            exp,
            bytes: Vec::new(),
        }
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("arlet-hosted-token-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn cache(&self) -> PathBuf {
            self.0.join("musickit-token.json")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A loopback server that accepts one connection, reads the request head,
    /// and then runs `script`. Returns the token URL it serves.
    fn script_server(script: impl FnOnce(&mut TcpStream) + Send + 'static) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().expect("local addr").port();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") && head.len() < 8192 {
                    match stream.read(&mut byte) {
                        Ok(1) => head.push(byte[0]),
                        _ => break,
                    }
                }
                script(&mut stream);
            }
        });
        format!("http://127.0.0.1:{port}/arlet-token.json")
    }

    fn http_reply(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
        let mut out =
            format!("HTTP/1.1 {status}\r\n{headers}Connection: close\r\n\r\n").into_bytes();
        out.extend_from_slice(body);
        out
    }

    fn reply_server(reply: Vec<u8>) -> String {
        script_server(move |stream| {
            let _ = stream.write_all(&reply);
        })
    }

    /// A URL on loopback with nothing listening, so connecting is refused.
    fn closed_url() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);
        format!("http://127.0.0.1:{port}/arlet-token.json")
    }

    fn fixed_now() -> u64 {
        NOW
    }

    static FAKE_NOW: AtomicU64 = AtomicU64::new(0);

    fn fake_now() -> u64 {
        FAKE_NOW.load(Ordering::SeqCst)
    }

    fn settings_for(url: &str, cache: &Path, timeout: Duration) -> Settings {
        Settings {
            url: url.to_string(),
            public_key: pubkey(),
            cache_path: cache.to_path_buf(),
            timeout,
            allow_loopback_http: true,
            clock: fixed_now,
        }
    }

    fn serve(settings: &Settings) -> Result<VerifiedToken, ServeError> {
        tauri::async_runtime::block_on(HostedTokenState::default().serve(settings))
    }

    /// A loopback host that counts each connection and never answers. Every
    /// connection is held open on its own thread, so the count keeps growing.
    fn counting_stall_server() -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().expect("local addr").port();
        let requests = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&requests);
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                counter.fetch_add(1, Ordering::SeqCst);
                thread::spawn(move || {
                    let _held = stream;
                    thread::sleep(Duration::from_secs(3));
                });
            }
        });
        (
            format!("http://127.0.0.1:{port}/arlet-token.json"),
            requests,
        )
    }

    // Failure modes: a body one byte over the cap; a body at the cap that is
    // otherwise valid is still accepted, so the cap is exact.
    #[test]
    fn size_cap_is_exact() {
        let mut at_cap = VALID.to_vec();
        at_cap.resize(MAX_FILE_BYTES, b' ');
        assert!(matches!(verify(&at_cap), Verdict::Valid(_)));
        let mut over = VALID.to_vec();
        over.resize(MAX_FILE_BYTES + 1, b' ');
        assert!(is_rejected(&verify(&over)));
        assert!(is_rejected(&verify(&vec![b'{'; MAX_FILE_BYTES + 1])));
    }

    // Failure modes: non-JSON bytes, invalid UTF-8, and JSON that is not an
    // object (array, number, null) are all rejected before any signature work.
    #[test]
    fn non_json_and_non_object_bodies_are_rejected() {
        for body in [&b"not json"[..], b"[]", b"7", b"null", b"\xff\xfe\xfd", b""] {
            assert!(is_rejected(&verify(body)), "accepted {body:?}");
        }
    }

    // Failure modes: a future or past format version, a string version, a
    // fractional version, and a missing version are all rejected.
    #[test]
    fn wrong_version_is_rejected() {
        for version in [json!(2), json!(0), json!("1"), json!(1.5)] {
            let bytes = edited(VALID, |value| value["version"] = version.clone());
            assert!(is_rejected(&verify(&bytes)), "accepted version {version}");
        }
        let missing = edited(VALID, |value| {
            value.as_object_mut().unwrap().remove("version");
        });
        assert!(is_rejected(&verify(&missing)));
    }

    // Failure modes: a missing token or signature, a non-string token or
    // signature, and an unknown extra field (the file contract is fixed).
    #[test]
    fn missing_wrong_typed_or_extra_fields_are_rejected() {
        let edits: [fn(&mut Value); 5] = [
            |value| {
                value.as_object_mut().unwrap().remove("token");
            },
            |value| {
                value.as_object_mut().unwrap().remove("signature");
            },
            |value| value["token"] = json!(5),
            |value| value["signature"] = Value::Null,
            |value| value["extra"] = json!("unexpected"),
        ];
        for edit in edits {
            assert!(is_rejected(&verify(&edited(VALID, edit))));
        }
    }

    // Failure modes: a signature made by a different key; a signature over the
    // bare JWT with no domain prefix; an updater-artifact signature replayed
    // onto the token; a token edited after signing; a signature that is not
    // base64; and base64 that decodes to something other than minisign text.
    #[test]
    fn forged_or_replayed_signatures_are_rejected() {
        assert!(is_rejected(&verify(OTHER_KEY)));
        assert!(is_rejected(&verify(BARE_JWT)));
        assert!(is_rejected(&verify(ARTIFACT)));
        let tampered = edited(VALID, |value| {
            let token = value["token"].as_str().unwrap().to_string();
            let mut chars: Vec<char> = token.chars().collect();
            let last = chars.len() - 1;
            chars[last] = if chars[last] == 'A' { 'B' } else { 'A' };
            value["token"] = Value::String(chars.into_iter().collect());
        });
        assert!(is_rejected(&verify(&tampered)));
        let not_base64 = edited(VALID, |value| {
            value["signature"] = json!("!!!not base64!!!")
        });
        assert!(is_rejected(&verify(&not_base64)));
        let not_minisign = edited(VALID, |value| {
            value["signature"] = json!(STANDARD.encode("hello"))
        });
        assert!(is_rejected(&verify(&not_minisign)));
    }

    // Failure modes: a validly signed token that has expired is reported as
    // Expired so the user sees the restart message, not a forgery error; a
    // validly signed token with an origin claim is rejected because Apple
    // refuses library requests for it; a validly signed HS256 token is rejected.
    #[test]
    fn signed_but_unusable_tokens_are_classified() {
        assert!(matches!(
            verify(EXPIRED),
            Verdict::Expired { exp: 1_000_000_000 }
        ));
        assert!(is_rejected(&verify(ORIGIN)));
        assert!(is_rejected(&verify(HS256)));
    }

    // Failure modes: a valid fixture verified with a different clock flips to
    // Expired exactly at its expiry; the policy clock is the supplied `now`.
    #[test]
    fn expiry_is_judged_against_the_supplied_clock() {
        assert!(matches!(
            verify_file(VALID, &pubkey(), FAR_FUTURE),
            Verdict::Expired { exp: FAR_FUTURE }
        ));
        assert!(matches!(
            verify_file(VALID, &pubkey(), FAR_FUTURE - 1),
            Verdict::Valid(_)
        ));
    }

    // Failure mode: the valid file's token or bytes are altered on the way
    // through verification, so the cache would store something other than what
    // was signed.
    #[test]
    fn valid_fixture_verifies_and_keeps_bytes_verbatim() {
        match verify(VALID) {
            Verdict::Valid(token) => {
                assert_eq!(token.token, field(VALID, "token"));
                assert_eq!(token.exp, FAR_FUTURE);
                assert_eq!(token.bytes, VALID);
            }
            other => panic!("expected a valid token, got {other:?}"),
        }
    }

    // Failure modes: a public key that is empty, not base64, base64 of a
    // truncated minisign key, or not minisign at all must verify nothing.
    #[test]
    fn public_key_must_be_a_minisign_key() {
        assert!(decode_public_key("").is_err());
        assert!(decode_public_key("!!!").is_err());
        assert!(decode_public_key(&STANDARD.encode("untrusted comment: x\nnot-a-key")).is_err());
        let text = STANDARD.decode(PUBLIC_KEY_B64.trim()).unwrap();
        assert!(decode_public_key(&STANDARD.encode(&text[..text.len() - 5])).is_err());
        assert!(decode_public_key(PUBLIC_KEY_B64.trim()).is_ok());
    }

    // Failure modes: a token URL that is plain HTTP to a non-loopback host, a
    // credentialed URL, a non-HTTP scheme, a localhost name instead of the
    // literal loopback address, or an unparseable string is refused, even when
    // plain HTTP to loopback is allowed.
    #[test]
    fn token_urls_must_be_https_unless_loopback_e2e() {
        assert!(validate_url(PRODUCTION_TOKEN_URL, false).is_ok());
        assert_eq!(
            validate_url(
                "http://music-api.arlet.rosiecdn.win/musickit/arlet-token.json",
                false
            ),
            Err(SourceError::InsecureUrl)
        );
        assert!(validate_url("http://127.0.0.1:8080/arlet-token.json", false).is_err());
        assert!(validate_url("http://127.0.0.1:8080/arlet-token.json", true).is_ok());
        assert!(validate_url("http://localhost:8080/arlet-token.json", true).is_err());
        assert!(validate_url("http://192.168.1.10:8080/arlet-token.json", true).is_err());
        assert!(validate_url("https://user:pass@music-api.arlet.rosiecdn.win/x", false).is_err());
        assert!(validate_url("ftp://127.0.0.1/arlet-token.json", true).is_err());
        assert!(validate_url("not a url", true).is_err());
    }

    // Failure mode: an ordinary release reads ARLET_E2E_TOKEN_URL or
    // ARLET_E2E_TOKEN_PUBKEY and serves an attacker-chosen or plain-HTTP source.
    #[cfg(not(feature = "e2e"))]
    #[test]
    fn ordinary_builds_ignore_e2e_overrides() {
        let dir = TempDir::new("ordinary-env");
        let settings = Settings::for_build(PUBLIC_KEY_B64.trim(), dir.cache(), |name| match name {
            "ARLET_E2E_TOKEN_URL" => Some("http://127.0.0.1:9/arlet-token.json".to_string()),
            "ARLET_E2E_TOKEN_PUBKEY" => Some("not-a-key".to_string()),
            _ => None,
        })
        .expect("ordinary settings");
        assert_eq!(settings.url, PRODUCTION_TOKEN_URL);
        assert!(!settings.allow_loopback_http);
        assert_eq!(settings.public_key, pubkey());
    }

    // Failure modes: an E2E build honors only loopback HTTP overrides; a
    // non-loopback HTTP override and an override public key that does not
    // decode are refused.
    #[cfg(feature = "e2e")]
    #[test]
    fn e2e_builds_accept_only_loopback_overrides() {
        fn env(url: &'static str, key: &'static str) -> impl Fn(&str) -> Option<String> {
            move |name| match name {
                "ARLET_E2E_TOKEN_URL" => Some(url.to_string()),
                "ARLET_E2E_TOKEN_PUBKEY" => Some(key.to_string()),
                _ => None,
            }
        }
        let dir = TempDir::new("e2e-env");
        let good = PUBLIC_KEY_B64.trim();
        let settings = Settings::for_build(
            good,
            dir.cache(),
            env("http://127.0.0.1:9/arlet-token.json", good),
        )
        .expect("loopback override");
        assert_eq!(settings.url, "http://127.0.0.1:9/arlet-token.json");
        assert!(settings.allow_loopback_http);
        assert!(Settings::for_build(
            good,
            dir.cache(),
            env("http://example.com/arlet-token.json", good)
        )
        .is_err());
        assert!(Settings::for_build(
            good,
            dir.cache(),
            env("http://127.0.0.1:9/arlet-token.json", "not-a-key")
        )
        .is_err());
    }

    // Failure modes: a lower expiry in a second candidate must not win; a
    // rejected candidate never wins; a tie keeps the first candidate (the one
    // fetched in this process).
    #[test]
    fn choose_serves_the_highest_valid_expiry() {
        let older = Verdict::Valid(token("older", NOW + 100));
        let newer = Verdict::Valid(token("newer", NOW + 200));
        assert_eq!(
            choose(NOW, &[older.clone(), newer.clone()]).unwrap().token,
            "newer"
        );
        assert_eq!(choose(NOW, &[newer, older]).unwrap().token, "newer");
        assert_eq!(
            choose(
                NOW,
                &[Verdict::Rejected, Verdict::Valid(token("only", NOW + 5))]
            )
            .unwrap()
            .token,
            "only"
        );
        assert_eq!(
            choose(
                NOW,
                &[
                    Verdict::Valid(token("first", NOW + 5)),
                    Verdict::Valid(token("second", NOW + 5))
                ]
            )
            .unwrap()
            .token,
            "first"
        );
    }

    // Failure modes: an expired candidate with nothing newer reports Expired;
    // nothing usable at all reports Unavailable; a valid token whose expiry has
    // passed by the time of the call is not served; an expired fetched token
    // does not hide a valid cached one.
    #[test]
    fn choose_reports_expiry_only_when_nothing_newer_is_usable() {
        assert_eq!(
            choose(NOW, &[Verdict::Expired { exp: NOW - 1 }, Verdict::Rejected]).unwrap_err(),
            ServeError::Expired
        );
        assert_eq!(
            choose(NOW + 20, &[Verdict::Valid(token("late", NOW + 10))]).unwrap_err(),
            ServeError::Expired
        );
        assert_eq!(
            choose(NOW, &[Verdict::Rejected, Verdict::Rejected]).unwrap_err(),
            ServeError::Unavailable
        );
        assert_eq!(choose(NOW, &[]).unwrap_err(), ServeError::Unavailable);
        assert_eq!(
            choose(
                NOW,
                &[
                    Verdict::Expired { exp: NOW - 1 },
                    Verdict::Valid(token("cache", NOW + 50))
                ]
            )
            .unwrap()
            .token,
            "cache"
        );
    }

    // Failure modes: changing the user-visible strings breaks the frontend's
    // expiry match; the unavailable text must never match /expired/i.
    #[test]
    fn user_facing_messages_match_the_contract() {
        assert_eq!(
            ServeError::Expired.message(),
            "Arlet's Apple Music access has expired. Restart Arlet to refresh it."
        );
        assert_eq!(
            ServeError::Unavailable.message(),
            "Arlet could not download its Apple Music access token. Check your connection and try again."
        );
        assert!(!ServeError::Unavailable
            .message()
            .to_ascii_lowercase()
            .contains("expired"));
    }

    // Failure modes: an older signed file replacing a newer cache moves the
    // cache backwards; a file equal in expiry must replace it; a cache that is
    // tampered or expired is replaced by any fresh file.
    #[test]
    fn replacement_never_moves_the_cache_backwards() {
        let cached = |exp: u64| Verdict::Valid(token("cached", exp));
        assert!(!should_replace(NOW + 99, &cached(NOW + 100)));
        assert!(should_replace(NOW + 100, &cached(NOW + 100)));
        assert!(should_replace(NOW + 101, &cached(NOW + 100)));
        assert!(should_replace(NOW + 1, &Verdict::Rejected));
        assert!(should_replace(NOW + 1, &Verdict::Expired { exp: NOW - 5 }));
    }

    // Failure modes: a stalled host and a body that never finishes both
    // count as the total 5 s budget; the body cap is exactly 16 KiB.
    #[test]
    fn fetch_budget_and_body_cap_match_the_contract() {
        assert_eq!(FETCH_TIMEOUT, Duration::from_secs(5));
        assert_eq!(MAX_FILE_BYTES, 16 * 1024);
    }

    // Failure modes: a server that replies with more than the cap; the body
    // must be refused while it is read rather than buffered whole.
    #[test]
    fn oversized_download_is_rejected_while_reading() {
        let dir = TempDir::new("oversized");
        let url = reply_server(http_reply("200 OK", "", &vec![b' '; MAX_FILE_BYTES + 4096]));
        let settings = settings_for(&url, &dir.cache(), FETCH_TIMEOUT);
        assert_eq!(
            tauri::async_runtime::block_on(fetch(&settings)),
            Err(SourceError::TooLarge)
        );
    }

    // Failure modes: a redirect is a failure and is never followed (the
    // target here is another closed loopback port, so a followed redirect would
    // surface as a network error instead of a status error); a 404 is a failure.
    #[test]
    fn redirects_and_error_statuses_are_failures() {
        let dir = TempDir::new("redirect");
        let target = closed_url();
        let redirect = reply_server(http_reply(
            "302 Found",
            &format!("Location: {target}\r\n"),
            b"",
        ));
        let settings = settings_for(&redirect, &dir.cache(), FETCH_TIMEOUT);
        assert_eq!(
            tauri::async_runtime::block_on(fetch(&settings)),
            Err(SourceError::Status)
        );
        let missing = reply_server(http_reply("404 Not Found", "", b"missing"));
        let settings = settings_for(&missing, &dir.cache(), FETCH_TIMEOUT);
        assert_eq!(
            tauri::async_runtime::block_on(fetch(&settings)),
            Err(SourceError::Status)
        );
    }

    // Failure modes: a stalled host with no cache is Unavailable and returns
    // within the timeout instead of hanging the launch path.
    #[test]
    fn stalled_host_without_cache_is_unavailable_within_the_timeout() {
        let dir = TempDir::new("stalled-empty");
        let url = script_server(|_| thread::sleep(Duration::from_secs(3)));
        let settings = settings_for(&url, &dir.cache(), Duration::from_millis(300));
        let started = Instant::now();
        assert_eq!(serve(&settings).unwrap_err(), ServeError::Unavailable);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    // Failure modes: a stalled host with a valid cache serves the cache rather
    // than failing the launch.
    #[test]
    fn stalled_host_with_cache_serves_the_cache() {
        let dir = TempDir::new("stalled-cache");
        fs::write(dir.cache(), VALID).unwrap();
        let url = script_server(|_| thread::sleep(Duration::from_secs(3)));
        let settings = settings_for(&url, &dir.cache(), Duration::from_millis(300));
        assert_eq!(serve(&settings).unwrap().token, field(VALID, "token"));
    }

    // Failure modes: after a prefetch whose download stalls, the webview's first
    // call repeats the 5 s download, so an offline launch waits twice. A call
    // inside the retry window must serve the cache, or report Unavailable when
    // there is none, with no new request. A call after the window must download
    // again, so Reconnect still recovers.
    #[test]
    fn failed_download_is_not_repeated_inside_the_retry_window() {
        let dir = TempDir::new("retry-window");
        fs::write(dir.cache(), VALID).unwrap();
        let (url, requests) = counting_stall_server();
        let mut settings = settings_for(&url, &dir.cache(), Duration::from_millis(300));
        settings.clock = fake_now;
        let state = HostedTokenState::default();

        FAKE_NOW.store(NOW, Ordering::SeqCst);
        let prefetch = tauri::async_runtime::block_on(state.serve(&settings));
        assert_eq!(prefetch.unwrap().token, field(VALID, "token"));
        assert_eq!(requests.load(Ordering::SeqCst), 1);

        FAKE_NOW.store(NOW + FAILED_FETCH_RETRY_SECS - 1, Ordering::SeqCst);
        let inside = tauri::async_runtime::block_on(state.serve(&settings));
        assert_eq!(inside.unwrap().token, field(VALID, "token"));
        assert_eq!(requests.load(Ordering::SeqCst), 1);

        FAKE_NOW.store(NOW + FAILED_FETCH_RETRY_SECS, Ordering::SeqCst);
        let after = tauri::async_runtime::block_on(state.serve(&settings));
        assert_eq!(after.unwrap().token, field(VALID, "token"));
        assert_eq!(requests.load(Ordering::SeqCst), 2);

        // Same window without a cache: Unavailable, and no request.
        fs::remove_file(dir.cache()).unwrap();
        let bare = HostedTokenState::default();
        FAKE_NOW.store(NOW + 100, Ordering::SeqCst);
        let first = tauri::async_runtime::block_on(bare.serve(&settings));
        assert_eq!(first.unwrap_err(), ServeError::Unavailable);
        assert_eq!(requests.load(Ordering::SeqCst), 3);
        FAKE_NOW.store(NOW + 101, Ordering::SeqCst);
        let second = tauri::async_runtime::block_on(bare.serve(&settings));
        assert_eq!(second.unwrap_err(), ServeError::Unavailable);
        assert_eq!(requests.load(Ordering::SeqCst), 3);
    }

    // Failure modes: an unreachable host with no cache is Unavailable, and the
    // message is the non-expired one.
    #[test]
    fn unreachable_host_without_cache_is_unavailable() {
        let dir = TempDir::new("unreachable");
        let settings = settings_for(&closed_url(), &dir.cache(), FETCH_TIMEOUT);
        assert_eq!(serve(&settings).unwrap_err(), ServeError::Unavailable);
    }

    // Failure modes: an unreachable host with a valid cache serves the cache.
    #[test]
    fn unreachable_host_serves_a_valid_cache() {
        let dir = TempDir::new("offline-cache");
        fs::write(dir.cache(), VALID).unwrap();
        let settings = settings_for(&closed_url(), &dir.cache(), FETCH_TIMEOUT);
        assert_eq!(serve(&settings).unwrap().token, field(VALID, "token"));
    }

    // Failure modes: an expired cache with the host unreachable reports Expired,
    // so the user is told to restart rather than told the download failed.
    #[test]
    fn expired_cache_with_unreachable_host_reports_expired() {
        let dir = TempDir::new("expired-cache");
        fs::write(dir.cache(), EXPIRED).unwrap();
        let settings = settings_for(&closed_url(), &dir.cache(), FETCH_TIMEOUT);
        assert_eq!(serve(&settings).unwrap_err(), ServeError::Expired);
    }

    // Failure modes: a freshly downloaded expired file with no cache reports
    // Expired and is never cached.
    #[test]
    fn expired_download_without_cache_reports_expired_and_is_not_cached() {
        let dir = TempDir::new("expired-download");
        let url = reply_server(http_reply("200 OK", "", EXPIRED));
        let settings = settings_for(&url, &dir.cache(), FETCH_TIMEOUT);
        assert_eq!(serve(&settings).unwrap_err(), ServeError::Expired);
        assert!(!dir.cache().exists());
    }

    // Failure modes: an expired download must not hide a valid cache.
    #[test]
    fn expired_download_does_not_hide_a_valid_cache() {
        let dir = TempDir::new("expired-over-cache");
        fs::write(dir.cache(), VALID).unwrap();
        let url = reply_server(http_reply("200 OK", "", EXPIRED));
        let settings = settings_for(&url, &dir.cache(), FETCH_TIMEOUT);
        assert_eq!(serve(&settings).unwrap().token, field(VALID, "token"));
        assert_eq!(fs::read(dir.cache()).unwrap(), VALID);
    }

    // Failure modes: a validly signed but older file (a replay of an earlier
    // token) must not replace a newer cache, and must not be served over it.
    #[test]
    fn older_download_cannot_replace_newer_cache() {
        let dir = TempDir::new("replay");
        fs::write(dir.cache(), VALID).unwrap();
        let url = reply_server(http_reply("200 OK", "", OLDER));
        let settings = settings_for(&url, &dir.cache(), FETCH_TIMEOUT);
        assert_eq!(serve(&settings).unwrap().token, field(VALID, "token"));
        assert_eq!(fs::read(dir.cache()).unwrap(), VALID);
    }

    // Failure modes: a newer download replaces an older cache, byte for byte.
    #[test]
    fn newer_download_replaces_older_cache() {
        let dir = TempDir::new("newer");
        fs::write(dir.cache(), OLDER).unwrap();
        let url = reply_server(http_reply("200 OK", "", VALID));
        let settings = settings_for(&url, &dir.cache(), FETCH_TIMEOUT);
        assert_eq!(serve(&settings).unwrap().token, field(VALID, "token"));
        assert_eq!(fs::read(dir.cache()).unwrap(), VALID);
    }

    // Failure modes: a cache file whose token was edited after signing is
    // never served, even when the host is unreachable.
    #[test]
    fn tampered_cache_is_never_served() {
        let dir = TempDir::new("tampered-cache");
        let tampered = edited(VALID, |value| {
            value["token"] = json!(format!("{}x", field(VALID, "token")));
        });
        fs::write(dir.cache(), &tampered).unwrap();
        assert!(is_rejected(&read_cache(&dir.cache(), &pubkey(), NOW)));
        let settings = settings_for(&closed_url(), &dir.cache(), FETCH_TIMEOUT);
        assert_eq!(serve(&settings).unwrap_err(), ServeError::Unavailable);
    }

    // Failure modes: a truncated cache (an interrupted write) is never served.
    #[test]
    fn truncated_cache_is_never_served() {
        let dir = TempDir::new("truncated-cache");
        fs::write(dir.cache(), &VALID[..VALID.len() / 2]).unwrap();
        let settings = settings_for(&closed_url(), &dir.cache(), FETCH_TIMEOUT);
        assert_eq!(serve(&settings).unwrap_err(), ServeError::Unavailable);
    }

    // Failure modes: a stray temp file left by an interrupted write is never
    // read as the cache; a successful later write replaces the cache through
    // the temp file and leaves no temp file behind.
    #[test]
    fn stray_temp_file_is_ignored_and_cleaned_up_by_the_next_write() {
        let dir = TempDir::new("stray-temp");
        let temp = dir.0.join("musickit-token.json.tmp");
        fs::write(&temp, VALID).unwrap();
        let settings = settings_for(&closed_url(), &dir.cache(), FETCH_TIMEOUT);
        assert_eq!(serve(&settings).unwrap_err(), ServeError::Unavailable);
        let url = reply_server(http_reply("200 OK", "", VALID));
        let settings = settings_for(&url, &dir.cache(), FETCH_TIMEOUT);
        assert_eq!(serve(&settings).unwrap().token, field(VALID, "token"));
        assert_eq!(fs::read(dir.cache()).unwrap(), VALID);
        assert!(!temp.exists());
    }

    // Failure modes: error and verdict text never echoes the token, its
    // signature, or the file bytes, including through Debug output.
    #[test]
    fn errors_never_echo_the_token() {
        let token = field(VALID, "token");
        let signature = field(VALID, "signature");
        let mut verdicts = vec![
            verify(VALID),
            verify(EXPIRED),
            verify(OTHER_KEY),
            verify(ORIGIN),
            verify(b"{}"),
        ];
        verdicts.push(verify(&edited(VALID, |value| value["version"] = json!(9))));
        for verdict in &verdicts {
            let debug = format!("{verdict:?}");
            assert!(!debug.contains(&token), "debug leaked token: {debug}");
            assert!(!debug.contains(&signature), "debug leaked signature");
        }
        for error in [ServeError::Expired, ServeError::Unavailable] {
            assert!(!error.message().contains(&token));
        }
    }
}
