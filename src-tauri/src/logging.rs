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
    let truncated = &entry[..MAX_LOG_ENTRY_BYTES];
    let boundary = truncated
        .char_indices()
        .last()
        .map(|(i, _)| i)
        .unwrap_or(MAX_LOG_ENTRY_BYTES);
    format!("{}… [truncated]", &entry[..boundary])
}

fn redact_sensitive(text: &str) -> String {
    let patterns = [
        "eyJ",  // JWT prefix (base64 of `{"` )
    ];
    let mut result = text.to_string();
    for pattern in patterns {
        if let Some(start) = result.find(pattern) {
            let end = result[start..]
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',')
                .map(|i| start + i)
                .unwrap_or(result.len());
            result.replace_range(start..end, "[REDACTED]");
        }
    }
    result
}

#[tauri::command]
pub fn append_local_log(app: tauri::AppHandle, entry: String) -> Result<(), String> {
    let state = app.state::<LogFileLock>();
    let _guard = state.0.lock().map_err(|_| "Log lock poisoned".to_string())?;
    let path = log_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let Ok(metadata) = std::fs::metadata(&path) {
        if metadata.len() > MAX_LOG_FILE_BYTES {
            let _ = std::fs::remove_file(&path);
        }
    }
    let safe_entry = redact_sensitive(&truncate_entry(&entry));
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

#[tauri::command]
pub fn clear_logs(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<LogFileLock>();
    let _guard = state.0.lock().map_err(|_| "Log lock poisoned".to_string())?;
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

    #[test]
    fn redact_jwt_tokens() {
        let text = "Authorization: Bearer eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.payload";
        let result = redact_sensitive(text);
        assert!(result.contains("[REDACTED]"));
        assert!(!result.contains("eyJ"));
    }

    #[test]
    fn redact_preserves_normal_text() {
        let text = "GET /v1/catalog/us/songs status=200";
        assert_eq!(redact_sensitive(text), text);
    }
}
