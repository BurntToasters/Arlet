//! Local-only playback queue snapshot, restored paused after restart.

use serde_json::Value;
use tauri::Manager;

static SESSION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const MAX_SESSION_BYTES: usize = 256 * 1024;
const MAX_SESSION_ITEMS: usize = 500;
pub const PLAYBACK_SESSION_SCHEMA_VERSION: u64 = 1;

fn lock_session() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    SESSION_LOCK
        .lock()
        .map_err(|_| "Playback session lock poisoned".to_string())
}

fn session_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("playback-session.json"))
}

fn backup_path(path: &std::path::Path) -> std::path::PathBuf {
    path.with_extension("json.bak")
}

fn validate_session_json(json: &str) -> Result<(), String> {
    if json.len() > MAX_SESSION_BYTES {
        return Err(format!(
            "Playback session too large ({} bytes, max {MAX_SESSION_BYTES})",
            json.len()
        ));
    }
    let value: Value =
        serde_json::from_str(json).map_err(|e| format!("Invalid playback session JSON: {e}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "Invalid playback session JSON: expected an object".to_string())?;
    if object.get("schemaVersion").and_then(Value::as_u64) != Some(PLAYBACK_SESSION_SCHEMA_VERSION)
    {
        return Err("Invalid playback session JSON: unsupported schemaVersion".to_string());
    }
    let items = object
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "Invalid playback session JSON: \"items\" must be an array".to_string())?;
    if items.len() > MAX_SESSION_ITEMS {
        return Err(format!(
            "Too many playback items ({} entries, max {MAX_SESSION_ITEMS})",
            items.len()
        ));
    }
    Ok(())
}

/// Returns the first copy that validates: the main file, then the backup.
fn select_session(main: Option<&str>, backup: Option<&str>) -> Option<String> {
    [main, backup]
        .into_iter()
        .flatten()
        .find(|text| validate_session_json(text).is_ok())
        .map(str::to_string)
}

/// Oversized or unreadable files count as missing, so a bad file never blocks startup.
fn read_capped(path: &std::path::Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if metadata.len() > MAX_SESSION_BYTES as u64 {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn read_session_text(path: &std::path::Path) -> Option<String> {
    let main = read_capped(path);
    let backup = read_capped(&backup_path(path));
    select_session(main.as_deref(), backup.as_deref())
}

fn write_session_text(path: &std::path::Path, json: &str) -> Result<(), String> {
    validate_session_json(json)?;
    // Only a valid current file may replace the backup, so a corrupt save
    // never erases the last good copy.
    if read_capped(path).is_some_and(|content| validate_session_json(&content).is_ok()) {
        let _ = std::fs::copy(path, backup_path(path));
    }
    crate::settings::atomic_write_text(path, json)
}

fn remove_session_files(path: &std::path::Path) {
    for file in [path.to_path_buf(), backup_path(path)] {
        if file.exists() {
            let _ = std::fs::remove_file(&file);
        }
    }
}

#[tauri::command]
pub fn load_playback_session(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let _guard = lock_session()?;
    Ok(read_session_text(&session_path(&app)?))
}

#[tauri::command]
pub fn save_playback_session(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let _guard = lock_session()?;
    write_session_text(&session_path(&app)?, &json)
}

#[tauri::command]
pub fn delete_playback_session(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = lock_session()?;
    remove_session_files(&session_path(&app)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_doc(items: usize) -> String {
        let entries = (0..items)
            .map(|index| format!(r#"{{"id":"song-{index}","title":"T","artistName":"A"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            r#"{{"schemaVersion":{PLAYBACK_SESSION_SCHEMA_VERSION},"items":[{entries}],"index":0,"positionSeconds":0,"savedAt":1}}"#
        )
    }

    #[test]
    fn valid_session_passes_validation() {
        assert!(validate_session_json(&session_doc(0)).is_ok());
        assert!(validate_session_json(&session_doc(3)).is_ok());
    }

    #[test]
    fn invalid_shapes_are_rejected() {
        for bad in [
            "not json",
            "[]",
            "42",
            r#"{"items":[]}"#,
            r#"{"schemaVersion":2,"items":[]}"#,
            r#"{"schemaVersion":1}"#,
            r#"{"schemaVersion":1,"items":{}}"#,
            r#"{"schemaVersion":1,"items":"oops"}"#,
        ] {
            assert!(validate_session_json(bad).is_err(), "accepted: {bad}");
        }
    }

    #[test]
    fn oversize_payload_is_rejected() {
        let padding = "x".repeat(MAX_SESSION_BYTES);
        let payload = format!(r#"{{"schemaVersion":1,"items":[],"pad":"{padding}"}}"#);
        assert!(validate_session_json(&payload).is_err());
    }

    #[test]
    fn more_than_max_items_is_rejected() {
        assert!(validate_session_json(&session_doc(MAX_SESSION_ITEMS)).is_ok());
        assert!(validate_session_json(&session_doc(MAX_SESSION_ITEMS + 1)).is_err());
    }

    #[test]
    fn corrupt_main_falls_back_to_valid_backup() {
        let good = session_doc(2);
        assert_eq!(
            select_session(Some("{broken"), Some(&good)).as_deref(),
            Some(good.as_str())
        );
    }

    #[test]
    fn valid_main_wins_over_backup() {
        let main = session_doc(1);
        let backup = session_doc(2);
        assert_eq!(
            select_session(Some(&main), Some(&backup)).as_deref(),
            Some(main.as_str())
        );
    }

    #[test]
    fn corrupt_main_and_backup_load_nothing() {
        assert_eq!(select_session(Some("nope"), Some("[1,2]")), None);
        assert_eq!(select_session(None, None), None);
    }
}
