//! Rolling local diagnostics log.

use std::io::Write;
use std::sync::Mutex;
use tauri::Manager;

pub struct LogFileLock(pub Mutex<()>);

const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LOG_ENTRY_BYTES: usize = 8 * 1024;
const LOG_FILE_NAME: &str = "arlet.log";

fn log_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_log_dir().map_err(|e| e.to_string())
}

fn log_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(log_dir(app)?.join(LOG_FILE_NAME))
}

fn truncate_entry(entry: &str) -> String {
    if entry.len() <= MAX_LOG_ENTRY_BYTES {
        return entry.to_string();
    }
    // Slicing inside a multibyte char panics, and release builds abort.
    let mut boundary = MAX_LOG_ENTRY_BYTES;
    while !entry.is_char_boundary(boundary) {
        boundary -= 1;
    }
    format!("{}… [truncated]", &entry[..boundary])
}

/// Keys that label opaque (non-JWT) tokens, matched case-insensitively.
const TOKEN_KEYS: [&str; 9] = [
    "music-user-token",
    "music_user_token",
    "musicusertoken",
    "media-user-token",
    "media_user_token",
    "mediausertoken",
    "developer-token",
    "developer_token",
    "developertoken",
];

fn is_value_end(c: char) -> bool {
    c.is_whitespace() || matches!(c, '"' | '\'' | '&' | ',' | ';' | '}')
}

fn redact_keyed_tokens(text: &str) -> String {
    let mut result = text.to_string();
    for key in TOKEN_KEYS {
        let mut search_from = 0;
        // ASCII lowercasing keeps byte offsets aligned with `result`.
        while let Some(found) = result.to_ascii_lowercase()[search_from..].find(key) {
            let key_end = search_from + found + key.len();
            let rest = &result[key_end..];
            let separator = rest
                .char_indices()
                .find(|(_, c)| !matches!(c, '"' | '\'' | ':' | '=') && !c.is_whitespace())
                .map(|(i, _)| i)
                .unwrap_or(rest.len());
            let has_assignment = rest[..separator].contains([':', '=']);
            let value_start = key_end + separator;
            let value_end = result[value_start..]
                .find(is_value_end)
                .map(|i| value_start + i)
                .unwrap_or(result.len());
            if has_assignment && value_end > value_start {
                result.replace_range(value_start..value_end, "[REDACTED]");
                search_from = value_start + "[REDACTED]".len();
            } else {
                search_from = key_end;
            }
        }
    }
    result
}

fn redact_sensitive(text: &str) -> String {
    let patterns = [
        "eyJ", // JWT prefix (base64 of `{"` )
    ];
    let mut result = redact_keyed_tokens(text);
    for pattern in patterns {
        // Loop: one entry can carry several tokens (dev token + user token).
        while let Some(start) = result.find(pattern) {
            let end = result[start..]
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',')
                .map(|i| start + i)
                .unwrap_or(result.len());
            result.replace_range(start..end, "[REDACTED]");
        }
    }
    result
}

#[tauri::command(async)]
pub fn append_local_log(app: tauri::AppHandle, entry: String) -> Result<(), String> {
    let state = app.state::<LogFileLock>();
    let _guard = state
        .0
        .lock()
        .map_err(|_| "Log lock poisoned".to_string())?;
    let path = log_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let Ok(metadata) = std::fs::metadata(&path) {
        if metadata.len() > MAX_LOG_FILE_BYTES {
            // Keep one rotated file so the history before a crash survives.
            let rotated = path.with_extension("log.1");
            let _ = std::fs::remove_file(&rotated);
            if std::fs::rename(&path, &rotated).is_err() {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    // Embedded line breaks would let one entry forge further log lines.
    let safe_entry = redact_sensitive(&truncate_entry(&entry))
        .replace('\r', "\\r")
        .replace('\n', "\\n");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{safe_entry}").map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_log_dir(app: tauri::AppHandle) -> Result<String, String> {
    log_dir(&app).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command(async)]
pub fn clear_logs(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<LogFileLock>();
    let _guard = state
        .0
        .lock()
        .map_err(|_| "Log lock poisoned".to_string())?;
    let path = log_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_entry_preserves_short() {
        let short = "hello world";
        assert_eq!(truncate_entry(short), short);
    }

    #[test]
    fn truncate_entry_clips_long() {
        let long = "a".repeat(MAX_LOG_ENTRY_BYTES + 100);
        let result = truncate_entry(&long);
        assert!(result.len() < long.len());
        assert!(result.ends_with("… [truncated]"));
    }

    // Failure modes: a multibyte char straddling the byte limit panics (and
    // aborts the release process); an all-multibyte entry never finds a
    // boundary; a clipped body exceeds the limit; an entry exactly at the
    // limit is clipped needlessly.
    #[test]
    fn truncate_entry_never_splits_multibyte_chars() {
        for prefix_len in 0..4 {
            let entry = format!(
                "{}{}",
                "a".repeat(prefix_len),
                "€".repeat(MAX_LOG_ENTRY_BYTES)
            );
            let result = truncate_entry(&entry);
            assert!(result.ends_with("… [truncated]"));
            let body = result.trim_end_matches("… [truncated]");
            assert!(body.len() <= MAX_LOG_ENTRY_BYTES);
        }
    }

    #[test]
    fn truncate_entry_keeps_entry_at_exact_limit() {
        let exact = "a".repeat(MAX_LOG_ENTRY_BYTES);
        assert_eq!(truncate_entry(&exact), exact);
    }

    #[test]
    fn redact_jwt_tokens() {
        let text = "Authorization: Bearer eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.payload";
        let result = redact_sensitive(text);
        assert!(result.contains("[REDACTED]"));
        assert!(!result.contains("eyJ"));
    }

    #[test]
    fn redact_all_jwt_tokens_in_entry() {
        let text = "dev=eyJkZXYtdG9rZW4 user=eyJ1c2VyLXRva2Vu";
        let result = redact_sensitive(text);
        assert!(!result.contains("eyJ"));
        assert_eq!(result.matches("[REDACTED]").count(), 2);
    }

    // Failure mode: Music User Tokens are not JWTs, so header, query, and
    // JSON-keyed values slipped past the eyJ rule.
    #[test]
    fn redact_music_user_token_by_key() {
        let token = "AqmL0f7xY2/Zp+Q9wR3kT8vN1bC4dE6gH5jK7mP0sU2yW==";
        for text in [
            format!("Music-User-Token: {token}"),
            format!("media-user-token={token}&l=en"),
            format!(r#"{{"musicUserToken":"{token}"}}"#),
            format!("developerToken = '{token}'"),
        ] {
            let result = redact_sensitive(&text);
            assert!(!result.contains(token), "leaked in {result}");
            assert!(result.contains("[REDACTED]"));
        }
    }

    #[test]
    fn redact_preserves_normal_text() {
        let text = "GET /v1/catalog/us/songs status=200";
        assert_eq!(redact_sensitive(text), text);
    }
}
