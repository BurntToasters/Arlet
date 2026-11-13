use serde::{Deserialize, Serialize};

pub const MINIMUM_WINDOWS_BUILD: u32 = 19045;

pub fn supports_windows_build(build: u32) -> bool {
    build >= MINIMUM_WINDOWS_BUILD
}

/// The registry build is read first: `GetVersionExW` reports the real
/// build only while the app manifest declares Windows 10 support, and
/// otherwise claims 9200, which would refuse to start.
#[cfg(windows)]
pub fn current_windows_build() -> Option<u32> {
    if let Some(build) =
        read_current_version_string("CurrentBuild").and_then(|text| text.parse::<u32>().ok())
    {
        return Some(build);
    }
    use windows::Win32::System::SystemInformation::{GetVersionExW, OSVERSIONINFOEXW};
    let mut version = OSVERSIONINFOEXW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOEXW>() as u32,
        ..Default::default()
    };
    unsafe { GetVersionExW((&mut version as *mut OSVERSIONINFOEXW).cast()) }.ok()?;
    Some(version.dwBuildNumber)
}

/// Shows a blocking error dialog. Release builds have no console, so a
/// startup failure would otherwise exit without any message.
pub fn show_error_dialog(message: &str) {
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let text: Vec<u16> = message.encode_utf16().chain([0]).collect();
        let title: Vec<u16> = "Arlet".encode_utf16().chain([0]).collect();
        unsafe {
            let _ = MessageBoxW(
                Some(HWND(std::ptr::null_mut())),
                PCWSTR(text.as_ptr()),
                PCWSTR(title.as_ptr()),
                MB_OK | MB_ICONERROR,
            );
        }
    }
    eprintln!("{message}");
}

#[cfg(not(windows))]
pub fn current_windows_build() -> Option<u32> {
    None
}

pub fn ensure_supported_windows() -> Result<(), String> {
    #[cfg(windows)]
    {
        let build = current_windows_build()
            .ok_or_else(|| "Could not determine Windows build. Arlet requires Windows 10 22H2 (build 19045) or newer.".to_string())?;
        if !supports_windows_build(build) {
            return Err(format!(
                "Arlet requires Windows 10 22H2 (build 19045) or newer. Detected build {build}."
            ));
        }
    }
    Ok(())
}

#[derive(Serialize)]
pub struct AppInfo {
    pub version: String,
    pub tauri_version: String,
    /// Operating system from `std::env::consts::OS` (e.g. "windows").
    pub os: String,
    /// CPU architecture from `std::env::consts::ARCH` (e.g. "x86_64").
    pub arch: String,
    /// WebView2 runtime version, when queryable. `None` maps to JSON null.
    pub webview_version: Option<String>,
    /// Rust compiler version captured at build time, when available.
    pub rustc_version: Option<String>,
    /// Windows display/build string when running on Windows.
    pub windows_build: Option<String>,
    /// True for debug builds, false for release.
    pub debug: bool,
}

// `async` keeps the WebView2 and registry queries off the UI thread.
#[tauri::command(async)]
pub fn get_app_info(app: tauri::AppHandle) -> Result<AppInfo, String> {
    let version = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    Ok(AppInfo {
        version,
        tauri_version: tauri::VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        webview_version: tauri::webview_version().ok(),
        rustc_version: option_env!("ARLET_RUSTC_VERSION").map(str::to_string),
        windows_build: windows_display_build(),
        debug: cfg!(debug_assertions),
    })
}

const TOKEN_ENV_KEYS: [&str; 2] = [
    crate::token_policy::TOKEN_ENV,
    "VITE_MUSICKIT_DEVELOPER_TOKEN",
];

/// Debug builds read the token from `.env` at runtime. Release builds never
/// call this: they serve the hosted token (see `hosted_token`).
pub fn resolve_developer_token<F>(lookup: F) -> Result<String, String>
where
    F: Fn(&str) -> Option<String>,
{
    for key in TOKEN_ENV_KEYS {
        if let Some(value) = lookup(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }
    Err(
        "MUSICKIT_DEVELOPER_TOKEN is not set. Copy .env.example to .env and run npm run tauri:dev."
            .to_string(),
    )
}

/// Debug builds use `.env`; release builds wait for the hosted token. Both
/// branches compile in every profile, so neither is dead code.
#[tauri::command]
pub async fn get_developer_token(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::hosted_token::HostedTokenState>,
) -> Result<String, String> {
    if cfg!(debug_assertions) {
        return resolve_developer_token(|key| std::env::var(key).ok());
    }
    crate::hosted_token::token(&app, &state).await
}

/// The only page `open_support_page` opens. The command takes no input, so
/// web content that can invoke it cannot pick a different URL.
pub const SUPPORT_URL: &str = "https://rosie.run/support";

/// Runs ShellExecuteW on a blocking task, so a slow shell never freezes the UI.
async fn open_url_off_ui_thread(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_in_default_browser(&url))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn open_support_page() -> Result<(), String> {
    open_url_off_ui_thread(SUPPORT_URL.to_string()).await
}

/// Links the Settings › About section can open. The webview sends only one of
/// these names, so every URL is built here from fixed text and the version.
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AboutLink {
    Project,
    ReleaseNotes,
    License,
}

const PROJECT_URL: &str = "https://github.com/BurntToasters/Arlet";

/// Compile-time version from `Cargo.toml`, which `sync-version.js` keeps equal
/// to `tauri.conf.json` (the version the updater and installer report).
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Semver text only: digits, letters, dots, hyphens, and plus signs, starting
/// with a digit. Anything else would change the path or query of the URL.
fn is_plain_version(version: &str) -> bool {
    version.starts_with(|c: char| c.is_ascii_digit())
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
}

pub fn about_link_url(link: AboutLink, version: &str) -> Result<String, String> {
    match link {
        AboutLink::Project => Ok(PROJECT_URL.to_string()),
        AboutLink::ReleaseNotes => {
            if !is_plain_version(version) {
                return Err(format!("Unexpected app version {version:?}."));
            }
            Ok(format!("{PROJECT_URL}/releases/tag/v{version}"))
        }
        AboutLink::License => Ok(format!("{PROJECT_URL}/blob/main/LICENSE")),
    }
}

#[tauri::command]
pub async fn open_about_link(link: AboutLink) -> Result<(), String> {
    open_url_off_ui_thread(about_link_url(link, APP_VERSION)?).await
}

/// Longest Subscribe link `open_subscribe_link` accepts, in bytes.
pub const MAX_SUBSCRIBE_URL_BYTES: usize = 2048;

const HTTPS_PREFIX: &str = "https://";

/// Checks a MusicKit `subscribeURL` before it reaches the browser. Accepts
/// only an ASCII `https` link on `apple.com` or one of its subdomains, with no
/// credentials, no port (`:443` included), and no spaces or control
/// characters. Returns the normalized form that was checked, so a host written
/// in uppercase is opened in lowercase. Trailing-dot hosts (`apple.com.`) and
/// punycode or other non-ASCII hosts are refused rather than normalized.
pub fn subscribe_link_url(url: &str) -> Result<String, String> {
    if url.len() > MAX_SUBSCRIBE_URL_BYTES {
        return Err(format!(
            "Subscribe link is longer than {MAX_SUBSCRIBE_URL_BYTES} bytes."
        ));
    }
    if url.bytes().any(|b| b == b' ' || b.is_ascii_control()) {
        return Err("Subscribe link contains a space or control character.".to_string());
    }
    let has_https_prefix = url
        .get(..HTTPS_PREFIX.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(HTTPS_PREFIX));
    if !has_https_prefix {
        return Err("Subscribe link must be an https URL.".to_string());
    }
    // Checked on the raw text, before parsing: the URL parser would silently
    // drop a `:443` port and rewrite a `\` as `/`.
    let rest = &url[HTTPS_PREFIX.len()..];
    let authority = rest.split(['/', '?', '#', '\\']).next().unwrap_or("");
    if authority.contains('@') {
        return Err("Subscribe link must not include credentials.".to_string());
    }
    if authority.contains(':') {
        return Err("Subscribe link must not name a port.".to_string());
    }
    if !authority
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
    {
        return Err("Subscribe link host must be plain ASCII.".to_string());
    }
    let parsed =
        url::Url::parse(url).map_err(|_| "Subscribe link is not a valid URL.".to_string())?;
    let host = parsed.host_str().unwrap_or("");
    let on_apple = host == "apple.com" || host.ends_with(".apple.com");
    if parsed.scheme() != "https"
        || !on_apple
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Subscribe link must be an https link on apple.com.".to_string());
    }
    Ok(parsed.to_string())
}

/// Opens the MusicKit Subscribe link. The page supplies the URL, so it is
/// checked by `subscribe_link_url` and the normalized form is what gets opened.
#[tauri::command]
pub async fn open_subscribe_link(url: String) -> Result<(), String> {
    open_url_off_ui_thread(subscribe_link_url(&url)?).await
}

/// Name of the file, in the isolated E2E profile root, that E2E builds append
/// each would-be opened link to.
#[cfg(feature = "e2e")]
const E2E_OPENED_LINKS_FILE: &str = "opened-links.jsonl";

/// E2E builds record the link instead of opening it: one JSON line per call,
/// appended to the isolated profile root. No browser page opens.
#[cfg(feature = "e2e")]
fn open_in_default_browser(url: &str) -> Result<(), String> {
    use std::io::Write;
    let root = crate::app_paths::e2e_profile_root()?;
    let line = serde_json::json!({ "url": url }).to_string();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join(E2E_OPENED_LINKS_FILE))
        .map_err(|error| format!("Could not record the opened link: {error}"))?;
    writeln!(file, "{line}").map_err(|error| format!("Could not record the opened link: {error}"))
}

#[cfg(all(windows, not(feature = "e2e")))]
fn open_in_default_browser(url: &str) -> Result<(), String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &HSTRING::from(url),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW reports success with a value above 32.
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!(
            "Could not open the default browser (code {}).",
            result.0 as isize
        ))
    }
}

#[cfg(all(not(windows), not(feature = "e2e")))]
fn open_in_default_browser(_url: &str) -> Result<(), String> {
    Err("Opening the browser is supported on Windows only.".to_string())
}

pub fn beta_updater_target_for_arch(arch: &str) -> Result<String, String> {
    match arch {
        "x86_64" | "aarch64" => Ok(format!("windows-beta-{arch}-nsis")),
        other => Err(format!(
            "Beta updater is not published for architecture {other}."
        )),
    }
}

#[tauri::command]
pub fn get_beta_updater_target() -> Result<String, String> {
    beta_updater_target_for_arch(std::env::consts::ARCH)
}

#[cfg(windows)]
fn read_current_version_value(
    name: &str,
    flags: windows::Win32::System::Registry::REG_ROUTINE_FLAGS,
) -> Option<Vec<u8>> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE};
    let subkey = HSTRING::from(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
    let value = HSTRING::from(name);
    let mut buffer = vec![0u8; 256];
    let mut size = buffer.len() as u32;
    unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            &subkey,
            &value,
            flags,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
    }
    .ok()
    .ok()?;
    buffer.truncate(size as usize);
    Some(buffer)
}

#[cfg(windows)]
fn read_current_version_string(name: &str) -> Option<String> {
    use windows::Win32::System::Registry::RRF_RT_REG_SZ;
    let bytes = read_current_version_value(name, RRF_RT_REG_SZ)?;
    let wide: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .take_while(|unit| *unit != 0)
        .collect();
    let text = String::from_utf16_lossy(&wide).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// Registry read in-process; spawning PowerShell flashed a console window in
/// GUI-subsystem builds and stalled startup.
#[cfg(windows)]
fn windows_display_build() -> Option<String> {
    use windows::Win32::System::Registry::RRF_RT_REG_DWORD;
    let build = read_current_version_string("CurrentBuild")?;
    let display = read_current_version_string("DisplayVersion").unwrap_or_default();
    let ubr = read_current_version_value("UBR", RRF_RT_REG_DWORD)
        .and_then(|bytes| {
            bytes
                .get(..4)
                .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        })
        .unwrap_or(0);
    Some(format!("{display} build {build}.{ubr}").trim().to_string())
}

#[cfg(not(windows))]
fn windows_display_build() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn app_info_serializes() {
        let info = super::AppInfo {
            version: "0.1.0".to_string(),
            tauri_version: "2.0.0".to_string(),
            os: "windows".to_string(),
            arch: "x86_64".to_string(),
            webview_version: Some("152.0.0.0".to_string()),
            rustc_version: Some("rustc 1.88.0".to_string()),
            windows_build: Some("24H2 build 26100.1".to_string()),
            debug: true,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("0.1.0"));
        assert!(json.contains("webview_version"));
        assert!(json.contains("rustc_version"));
        assert!(json.contains("windows_build"));
    }

    fn env_token(key: &str) -> Option<String> {
        (key == "MUSICKIT_DEVELOPER_TOKEN").then(|| " jwt-from-env ".to_string())
    }

    #[test]
    fn debug_reads_musickit_developer_token() {
        let token = super::resolve_developer_token(env_token).expect("token");
        assert_eq!(token, "jwt-from-env");
    }

    #[test]
    fn debug_accepts_legacy_vite_token_alias() {
        let token = super::resolve_developer_token(|key| {
            (key == "VITE_MUSICKIT_DEVELOPER_TOKEN").then(|| "legacy-jwt".to_string())
        })
        .expect("token");
        assert_eq!(token, "legacy-jwt");
    }

    // Failure modes: an unset or whitespace-only variable is a missing token;
    // the error names the variable and never echoes a value.
    #[test]
    fn missing_token_does_not_echo_secrets() {
        let err = super::resolve_developer_token(|_| None).unwrap_err();
        assert!(err.contains("MUSICKIT_DEVELOPER_TOKEN"));
        assert!(!err.contains("jwt"));
        let blank = super::resolve_developer_token(|_| Some("   ".to_string())).unwrap_err();
        assert_eq!(blank, err);
    }

    #[test]
    fn beta_target_matches_published_windows_architectures() {
        assert_eq!(
            super::beta_updater_target_for_arch("x86_64").unwrap(),
            "windows-beta-x86_64-nsis"
        );
        assert_eq!(
            super::beta_updater_target_for_arch("aarch64").unwrap(),
            "windows-beta-aarch64-nsis"
        );
    }

    #[test]
    fn beta_target_rejects_unpublished_architectures() {
        assert!(super::beta_updater_target_for_arch("x86").is_err());
    }

    // Failure mode: the support link is pointed at a non-HTTPS or different
    // host by an edit; the command itself takes no URL input.
    #[test]
    fn support_url_is_the_https_support_page() {
        assert_eq!(super::SUPPORT_URL, "https://rosie.run/support");
    }

    // Failure modes: a link resolves to a different repository or to a
    // non-HTTPS URL; an unknown or URL-shaped value deserializes into a link;
    // a version with path or query characters is spliced into the release
    // tag URL; an empty or missing version still produces a release URL.
    #[test]
    fn about_link_urls_are_fixed_project_urls() {
        use super::AboutLink;
        assert_eq!(
            super::about_link_url(AboutLink::Project, "0.3.0").unwrap(),
            "https://github.com/BurntToasters/Arlet"
        );
        assert_eq!(
            super::about_link_url(AboutLink::License, "0.3.0").unwrap(),
            "https://github.com/BurntToasters/Arlet/blob/main/LICENSE"
        );
        assert_eq!(
            super::about_link_url(AboutLink::ReleaseNotes, "0.3.0-beta.2").unwrap(),
            "https://github.com/BurntToasters/Arlet/releases/tag/v0.3.0-beta.2"
        );
    }

    #[test]
    fn about_link_release_notes_reject_non_version_text() {
        use super::AboutLink;
        for version in ["", "0.3.0/../../evil", "0.3.0?x=1", "0.3.0#frag", "v0.3.0"] {
            assert!(
                super::about_link_url(AboutLink::ReleaseNotes, version).is_err(),
                "accepted {version:?}"
            );
        }
    }

    #[test]
    fn about_link_deserializes_only_known_names() {
        use super::AboutLink;
        assert_eq!(
            serde_json::from_str::<AboutLink>("\"release_notes\"").unwrap(),
            AboutLink::ReleaseNotes
        );
        assert_eq!(
            serde_json::from_str::<AboutLink>("\"project\"").unwrap(),
            AboutLink::Project
        );
        assert!(serde_json::from_str::<AboutLink>("\"https://evil.example\"").is_err());
        assert!(serde_json::from_str::<AboutLink>("\"settings\"").is_err());
    }

    // Failure modes: the Subscribe link is opened over plain http, on a
    // lookalike host, with credentials, on an explicit port, past the length
    // cap, or from text that is not a URL at all.
    #[test]
    fn subscribe_link_refuses_http_scheme() {
        assert!(super::subscribe_link_url(
            "http://finance-app.itunes.apple.com/deeplink?p=subscribe"
        )
        .is_err());
    }

    #[test]
    fn subscribe_link_refuses_lookalike_hosts() {
        for url in [
            "https://apple.com.evil.test/",
            "https://evilapple.com/",
            "https://apple.com@evil.test/",
            "https://\u{0430}pple.com/",
            "https://apple.com./",
            "https://apple%2Ecom/",
            "https://apple.com.evil.test\\@apple.com/",
        ] {
            assert!(super::subscribe_link_url(url).is_err(), "accepted {url:?}");
        }
    }

    #[test]
    fn subscribe_link_refuses_userinfo_and_explicit_port() {
        for url in [
            "https://user:pass@finance-app.itunes.apple.com/",
            "https://finance-app.itunes.apple.com:8443/",
            "https://finance-app.itunes.apple.com:443/",
        ] {
            assert!(super::subscribe_link_url(url).is_err(), "accepted {url:?}");
        }
    }

    #[test]
    fn subscribe_link_refuses_urls_over_2048_bytes() {
        let base = "https://apple.com/?q=";
        let at_limit = format!("{base}{}", "a".repeat(2048 - base.len()));
        assert_eq!(at_limit.len(), 2048);
        assert!(super::subscribe_link_url(&at_limit).is_ok());
        let over = format!("{at_limit}a");
        assert!(super::subscribe_link_url(&over).is_err());
    }

    #[test]
    fn subscribe_link_refuses_non_url_text() {
        for text in [
            "",
            "finance-app.itunes.apple.com",
            "not a url",
            "javascript:alert(1)",
            " https://apple.com/",
            "https://apple.com/\n",
            "https://apple.com/ and more",
        ] {
            assert!(
                super::subscribe_link_url(text).is_err(),
                "accepted {text:?}"
            );
        }
    }

    #[test]
    fn subscribe_link_accepts_apple_https_links() {
        assert_eq!(
            super::subscribe_link_url("https://finance-app.itunes.apple.com/deeplink?p=subscribe")
                .unwrap(),
            "https://finance-app.itunes.apple.com/deeplink?p=subscribe"
        );
        assert_eq!(
            super::subscribe_link_url("https://apple.com/").unwrap(),
            "https://apple.com/"
        );
    }

    // Decision: host case is not a refusal. The host is lowercased in the
    // returned URL, so the opened link is the normalized form that was checked.
    #[test]
    fn subscribe_link_normalizes_uppercase_host() {
        assert_eq!(
            super::subscribe_link_url("https://FINANCE-APP.ITUNES.APPLE.COM/").unwrap(),
            "https://finance-app.itunes.apple.com/"
        );
    }

    #[test]
    fn windows_support_floor_is_build_19045() {
        assert!(!super::supports_windows_build(19044));
        assert!(super::supports_windows_build(19045));
        assert!(super::supports_windows_build(26100));
    }
}
