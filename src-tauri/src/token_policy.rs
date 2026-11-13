//! MusicKit developer-token checks. Release builds run `validate_hosted` on
//! the signed hosted file (see `hosted_token`); debug builds read `.env` and
//! only need `token_expiry`. Error text never includes the token.

pub const TOKEN_ENV: &str = "MUSICKIT_DEVELOPER_TOKEN";

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
/// The tests check it against tauri.conf.json.
#[cfg(test)]
pub const RELEASE_ORIGIN: &str = "http://tauri.localhost";

/// A hosted token that passed the policy checks.
#[derive(Debug, PartialEq, Eq)]
pub struct HostedCheck {
    pub exp: u64,
}

/// Why a hosted token is refused. `Expired` is separate so the caller can tell
/// the user to restart instead of treating the file as bad.
#[derive(Debug, PartialEq, Eq)]
pub enum PolicyError {
    Expired { exp: u64 },
    Rejected(String),
}

impl std::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Expired { .. } => f.write_str("MusicKit developer token has expired"),
            Self::Rejected(message) => f.write_str(message),
        }
    }
}

/// Policy for a hosted token: a bare, unexpired ES256 JWT with no `origin`
/// claim. Apple accepts an origin-restricted token for catalog requests but
/// refuses `/v1/me` (library) requests, even from `http://tauri.localhost`:
/// 0.1.0 shipped one and cannot load libraries. Any `origin` key is refused,
/// whatever its value.
pub fn validate_hosted(token: &str, now: u64) -> Result<HostedCheck, PolicyError> {
    if token.is_empty() || token.trim() != token {
        return Err(PolicyError::Rejected(
            "MusicKit developer token must not have surrounding whitespace".to_string(),
        ));
    }
    let exp = token_expiry(token).map_err(PolicyError::Rejected)?;
    let payload = decode_json_segment(token.split('.').nth(1).unwrap_or(""), "payload")
        .map_err(PolicyError::Rejected)?;
    if payload.get("origin").is_some() {
        return Err(PolicyError::Rejected(
            "MusicKit developer token has an origin claim; Apple then refuses library (/v1/me) requests."
                .to_string(),
        ));
    }
    if exp <= now {
        return Err(PolicyError::Expired { exp });
    }
    Ok(HostedCheck { exp })
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
    // fractional, or negative `exp`.
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

    // Failure modes: a token that expires exactly now or earlier is reported as
    // Expired rather than as a generic rejection; a token expiring soon is still
    // accepted, because hosted tokens have no minimum remaining lifetime.
    #[test]
    fn hosted_policy_accepts_any_unexpired_token() {
        let soon = es256(&format!(r#"{{"exp":{}}}"#, NOW + 1));
        let boundary = es256(&format!(r#"{{"exp":{NOW}}}"#));
        let expired = es256(&format!(r#"{{"exp":{}}}"#, NOW - 1));
        assert_eq!(validate_hosted(&soon, NOW).unwrap().exp, NOW + 1);
        assert_eq!(
            validate_hosted(&boundary, NOW),
            Err(PolicyError::Expired { exp: NOW })
        );
        assert_eq!(
            validate_hosted(&expired, NOW),
            Err(PolicyError::Expired { exp: NOW - 1 })
        );
    }

    fn with_origin(origin: &str) -> String {
        es256(&format!(r#"{{"exp":{},"origin":{origin}}}"#, NOW * 2))
    }

    // Failure mode: the hosted file carries an origin-restricted token, including
    // one scoped exactly to the app origin; Apple refuses its library calls. Any
    // origin key, even with a null or empty value, is refused.
    #[test]
    fn hosted_policy_rejects_every_origin_claim() {
        for origin in [
            r#"["http://tauri.localhost"]"#,
            r#""http://tauri.localhost""#,
            r#"[]"#,
            r#"[42]"#,
            r#"null"#,
            r#"false"#,
            r#""""#,
            r#"{}"#,
            r#"["http://localhost:5173"]"#,
            r#"["https://tauri.localhost"]"#,
            r#"["http://tauri.localhost","http://localhost:5173"]"#,
            r#"["http://tauri.localhost","http://127.0.0.1:5173"]"#,
            r#"["http://tauri.localhost/"]"#,
        ] {
            assert!(
                validate_hosted(&with_origin(origin), NOW).is_err(),
                "accepted origin claim {origin}"
            );
        }
    }

    #[test]
    fn hosted_policy_accepts_a_token_without_origin_claim() {
        let open = validate_hosted(&es256(&format!(r#"{{"exp":{}}}"#, NOW * 2)), NOW)
            .expect("unrestricted token accepted");
        assert_eq!(open.exp, NOW * 2);
    }

    // Failure modes: whitespace around the token would make the served string
    // differ from the exact text that was signed.
    #[test]
    fn hosted_policy_requires_a_bare_token() {
        let token = es256(&format!(r#"{{"exp":{}}}"#, NOW * 2));
        for padded in [
            format!(" {token}"),
            format!("{token}\n"),
            format!("\t{token}"),
        ] {
            assert!(
                matches!(validate_hosted(&padded, NOW), Err(PolicyError::Rejected(_))),
                "accepted padded token"
            );
        }
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

    // Failure mode: a policy error for an expired, malformed, or origin-scoped
    // token echoes the token or its segments into text that may be logged.
    #[test]
    fn errors_never_echo_the_token() {
        let expired = es256(&format!(r#"{{"exp":{}}}"#, NOW - 10));
        let alg = jwt(r#"{"alg":"HS256"}"#, r#"{"exp":1}"#);
        let origin = with_origin(r#"["http://tauri.localhost"]"#);
        for token in [
            expired.as_str(),
            alg.as_str(),
            origin.as_str(),
            "secretvalue.x.y",
        ] {
            let error = validate_hosted(token, NOW).unwrap_err().to_string();
            for segment in token.split('.').filter(|s| s.len() > 2) {
                assert!(!error.contains(segment), "leaked {segment}: {error}");
            }
        }
    }
}
