//! MusicKit developer-token checks shared by `build.rs` (release embedding)
//! and the runtime token command. Error text never includes the token.

pub const TOKEN_ENV: &str = "MUSICKIT_DEVELOPER_TOKEN";
/// Read by `build.rs`; the runtime uses the literal in `option_env!`.
#[allow(dead_code)]
pub const EMBEDDED_TOKEN_ENV: &str = "ARLET_MUSICKIT_DEVELOPER_TOKEN";
#[allow(dead_code)]
pub const SKIP_EMBED_ENV: &str = "ARLET_SKIP_MUSICKIT_TOKEN";
/// A release must leave users at least this long before the token expires.
#[allow(dead_code)] // Used by build.rs.
pub const MIN_EMBED_REMAINING_SECONDS: u64 = 30 * 24 * 60 * 60;

fn decode_base64url(segment: &str) -> Option<Vec<u8>> {
    let mut bits = 0u32;
    let mut bit_count = 0;
    let mut out = Vec::with_capacity(segment.len() * 3 / 4);
    for byte in segment.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        bits = (bits << 6) | u32::from(value);
        bit_count += 6;
        if bit_count >= 8 {
            bit_count -= 8;
            out.push((bits >> bit_count) as u8);
            bits &= (1 << bit_count) - 1;
        }
    }
    Some(out)
}

fn decode_json_segment(segment: &str, name: &str) -> Result<serde_json::Value, String> {
    let bytes = decode_base64url(segment)
        .ok_or_else(|| format!("MusicKit developer token {name} is not base64url"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| format!("MusicKit developer token {name} is not JSON"))
}

/// Validates JWT shape, ES256 header, and a numeric `exp`; returns `exp`.
pub fn token_expiry(token: &str) -> Result<u64, String> {
    let segments: Vec<&str> = token.trim().split('.').collect();
    if segments.len() != 3 || segments.iter().any(|segment| segment.is_empty()) {
        return Err("MusicKit developer token must be a three-part JWT".to_string());
    }
    let header = decode_json_segment(segments[0], "header")?;
    if header.get("alg").and_then(serde_json::Value::as_str) != Some("ES256") {
        return Err("MusicKit developer token must use ES256".to_string());
    }
    if decode_base64url(segments[2]).is_none() {
        return Err("MusicKit developer token signature is not base64url".to_string());
    }
    decode_json_segment(segments[1], "payload")?
        .get("exp")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "MusicKit developer token needs an integer exp claim".to_string())
}

/// Origin of the bundled frontend in release builds: Tauri 2 on Windows with
/// `useHttpsScheme` off. Dev builds run on `http://localhost:5173` instead.
#[allow(dead_code)] // Used by build.rs.
pub const RELEASE_ORIGIN: &str = "http://tauri.localhost";

#[allow(dead_code)] // Used by build.rs.
#[derive(Debug)]
pub struct EmbedCheck {
    pub exp: u64,
}

/// Release builds refuse tokens that expire within the minimum window or
/// carry any `origin` claim: Apple accepts an origin-restricted token for
/// catalog requests from `http://tauri.localhost` but answers every
/// `/v1/me` (library) request with 403.
#[allow(dead_code)] // Used by build.rs.
pub fn validate_for_embed(token: &str, now: u64) -> Result<EmbedCheck, String> {
    let exp = token_expiry(token)?;
    if exp < now.saturating_add(MIN_EMBED_REMAINING_SECONDS) {
        let days_left = exp.saturating_sub(now) / 86_400;
        return Err(format!(
            "MusicKit developer token expires in {days_left} day(s); release builds need at least {} days. Mint a new token.",
            MIN_EMBED_REMAINING_SECONDS / 86_400
        ));
    }
    let payload = decode_json_segment(token.trim().split('.').nth(1).unwrap_or(""), "payload")?;
    if payload.get("origin").is_some() {
        return Err(
            "MusicKit developer token has an origin claim; Apple then refuses library (/v1/me) requests with 403. Mint the release token without MUSICKIT_TOKEN_ORIGINS."
                .to_string(),
        );
    }
    Ok(EmbedCheck { exp })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000;

    fn b64url(bytes: &[u8]) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = chunk
                .iter()
                .enumerate()
                .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
            for i in 0..=chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            }
        }
        out
    }

    fn jwt(header: &str, payload: &str) -> String {
        format!(
            "{}.{}.{}",
            b64url(header.as_bytes()),
            b64url(payload.as_bytes()),
            b64url(b"signature-bytes")
        )
    }

    fn es256(payload: &str) -> String {
        jwt(r#"{"alg":"ES256","kid":"ABC123"}"#, payload)
    }

    // Failure modes: empty or whitespace token; wrong segment count; invalid
    // base64url; non-JSON header/payload; non-ES256 algorithm; missing,
    // fractional, or negative `exp`; already expired; expiring inside the
    // release window; error text that echoes the token.
    #[test]
    fn rejects_malformed_tokens() {
        let bad = [
            String::new(),
            "   ".to_string(),
            "a.b".to_string(),
            "a.b.c.d".to_string(),
            "!!!.???.***".to_string(),
            format!("{}.{}.", b64url(b"{}"), b64url(b"{}")),
            jwt("not json", r#"{"exp":1}"#),
            jwt(r#"{"alg":"ES256"}"#, "not json"),
            jwt(r#"{"alg":"HS256"}"#, &format!(r#"{{"exp":{}}}"#, NOW * 2)),
            jwt(r#"{"kid":"x"}"#, &format!(r#"{{"exp":{}}}"#, NOW * 2)),
            es256(r#"{"iss":"TEAM"}"#),
            es256(r#"{"exp":"soon"}"#),
            es256(r#"{"exp":1.5}"#),
            es256(r#"{"exp":-5}"#),
        ];
        for token in bad {
            assert!(token_expiry(&token).is_err(), "accepted: {token:?}");
        }
    }

    #[test]
    fn accepts_es256_token_and_returns_expiry() {
        let token = es256(&format!(
            r#"{{"iss":"TEAM","iat":{NOW},"exp":{}}}"#,
            NOW + 99
        ));
        assert_eq!(token_expiry(&token).unwrap(), NOW + 99);
        assert_eq!(token_expiry(&format!("  {token}\n")).unwrap(), NOW + 99);
    }

    #[test]
    fn embed_requires_minimum_remaining_lifetime() {
        let expired = es256(&format!(r#"{{"exp":{}}}"#, NOW - 1));
        let soon = es256(&format!(
            r#"{{"exp":{}}}"#,
            NOW + MIN_EMBED_REMAINING_SECONDS - 1
        ));
        let ok = es256(&format!(
            r#"{{"exp":{}}}"#,
            NOW + MIN_EMBED_REMAINING_SECONDS
        ));
        assert!(validate_for_embed(&expired, NOW).is_err());
        assert!(validate_for_embed(&soon, NOW).is_err());
        assert_eq!(
            validate_for_embed(&ok, NOW).unwrap().exp,
            NOW + MIN_EMBED_REMAINING_SECONDS
        );
    }

    fn with_origin(origin: &str) -> String {
        es256(&format!(r#"{{"exp":{},"origin":{origin}}}"#, NOW * 2))
    }

    // Failure modes: any `origin` claim, including exactly the release app,
    // makes Apple refuse every /v1/me library request with 403 (0.1.0 draft).
    #[test]
    fn embed_rejects_every_origin_claim() {
        for origin in [
            r#"["http://tauri.localhost"]"#,
            r#""http://tauri.localhost""#,
            r#"[]"#,
            r#"[42]"#,
            r#"["http://localhost:5173"]"#,
            r#"["https://tauri.localhost"]"#,
            r#"["http://tauri.localhost","http://localhost:5173"]"#,
            r#"["http://tauri.localhost","http://127.0.0.1:5173"]"#,
            r#"["http://tauri.localhost/"]"#,
        ] {
            assert!(
                validate_for_embed(&with_origin(origin), NOW).is_err(),
                "accepted origin claim {origin}"
            );
        }
    }

    #[test]
    fn embed_accepts_a_token_without_origin_claim() {
        let open = validate_for_embed(&es256(&format!(r#"{{"exp":{}}}"#, NOW * 2)), NOW)
            .expect("unrestricted token accepted");
        assert_eq!(open.exp, NOW * 2);
    }

    // Failure mode: the app's real origin drifts (https scheme or a
    // localhost-server plugin) and MusicKit storage and sign-in move with it.
    #[test]
    fn release_origin_matches_tauri_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = &config["app"]["windows"][0];
        assert_eq!(main["label"], "main");
        assert_ne!(main["useHttpsScheme"], serde_json::json!(true));
        let cargo = include_str!("../Cargo.toml");
        assert!(!cargo.contains("tauri-plugin-localhost"));
        assert_eq!(RELEASE_ORIGIN, "http://tauri.localhost");
    }

    #[test]
    fn errors_never_echo_the_token() {
        let soon = es256(&format!(r#"{{"exp":{}}}"#, NOW + 10));
        let alg = jwt(r#"{"alg":"HS256"}"#, r#"{"exp":1}"#);
        for token in [soon.as_str(), alg.as_str(), "secretvalue.x.y"] {
            let error = validate_for_embed(token, NOW).unwrap_err();
            for segment in token.split('.').filter(|s| s.len() > 2) {
                assert!(!error.contains(segment), "leaked {segment}: {error}");
            }
        }
    }
}
