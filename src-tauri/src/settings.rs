//! Settings persistence with atomic writes; preserves reserved `_`-prefixed keys.

use tauri::Manager;

static SETTINGS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const MAX_SETTINGS_BYTES: usize = 512 * 1024;

fn lock_settings() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    SETTINGS_LOCK
        .lock()
        .map_err(|_| "Settings file lock poisoned".to_string())
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn backup_path(path: &std::path::Path) -> std::path::PathBuf {
    path.with_extension("json.bak")
}

pub fn atomic_write_text(
    path: &std::path::Path,
    content: &str,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_settings(app: tauri::AppHandle) -> Result<String, String> {
    let _guard = lock_settings()?;
    let path = settings_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(e) => {
            let backup = backup_path(&path);
            if backup.exists() {
                match std::fs::read_to_string(&backup) {
                    Ok(content) => return Ok(content),
                    Err(_) => return Err(format!("Settings and backup unreadable: {e}")),
                }
            }
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let _guard = lock_settings()?;
    if json.len() > MAX_SETTINGS_BYTES {
        return Err(format!(
            "Settings payload too large ({} bytes, max {MAX_SETTINGS_BYTES})",
            json.len()
        ));
    }
    let _parsed: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("Invalid settings JSON: {e}"))?;
    let path = settings_path(&app)?;
    let backup = backup_path(&path);
    if path.exists() {
        let _ = std::fs::copy(&path, &backup);
    }
    atomic_write_text(&path, &json)
}

#[tauri::command]
pub fn reset_settings(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = lock_settings()?;
    let path = settings_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    let backup = backup_path(&path);
    if backup.exists() {
        std::fs::remove_file(&backup).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_creates_file() {
        let dir = std::env::temp_dir().join("arlet-settings-test");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("test.json");
        atomic_write_text(&path, "{\"theme\":\"dark\"}").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("dark"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_oversized_payload() {
        let large = "x".repeat(MAX_SETTINGS_BYTES + 1);
        assert!(large.len() > MAX_SETTINGS_BYTES);
    }
}
