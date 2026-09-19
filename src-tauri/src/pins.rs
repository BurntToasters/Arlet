//! Local-only playlist pins persisted next to settings.

use serde_json::Value;
use tauri::Manager;

static PINS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const MAX_PINS_BYTES: usize = 64 * 1024;
const MAX_PINS: usize = 100;
pub const PINS_SCHEMA_VERSION: u64 = 1;

fn lock_pins() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    PINS_LOCK
        .lock()
        .map_err(|_| "Pins file lock poisoned".to_string())
}

fn pins_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("pins.json"))
}

fn backup_path(path: &std::path::Path) -> std::path::PathBuf {
    path.with_extension("json.bak")
}

fn pins_entries(value: &Value) -> Result<&Vec<Value>, String> {
    if let Some(entries) = value.as_array() {
        return Ok(entries);
    }
    match value.as_object().and_then(|object| object.get("pins")) {
        Some(entries) => entries
            .as_array()
            .ok_or_else(|| "Invalid pins JSON: \"pins\" must be an array".to_string()),
        None => Err("Invalid pins JSON: \"pins\" must be an array".to_string()),
    }
}

fn validate_pins_json(json: &str) -> Result<(), String> {
    if json.len() > MAX_PINS_BYTES {
        return Err(format!(
            "Pins payload too large ({} bytes, max {MAX_PINS_BYTES})",
            json.len()
        ));
    }
    let value: Value =
        serde_json::from_str(json).map_err(|e| format!("Invalid pins JSON: {e}"))?;
    let pins = pins_entries(&value)?;
    if pins.len() > MAX_PINS {
        return Err(format!(
            "Too many pins ({} entries, max {MAX_PINS})",
            pins.len()
        ));
    }
    for pin in pins {
        let object = pin.as_object();
        let valid_id = object
            .and_then(|entry| entry.get("id")?.as_str())
            .map(|id| !id.is_empty())
            .unwrap_or(false);
        let valid_source = matches!(
            object.and_then(|entry| entry.get("source")?.as_str()),
            Some("library") | Some("catalog")
        );
        if !valid_id || !valid_source {
            return Err(
                "Invalid pins JSON: each pin needs a non-empty id and a library|catalog source"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn read_pins_text(path: &std::path::Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            if content.len() > MAX_PINS_BYTES {
                return Err(format!(
                    "Pins file too large ({} bytes, max {MAX_PINS_BYTES})",
                    content.len()
                ));
            }
            validate_pins_json(&content)?;
            Ok(content)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("[]".to_string()),
        Err(e) => Err(e.to_string()),
    }
}

fn write_pins_text(path: &std::path::Path, json: &str) -> Result<(), String> {
    validate_pins_json(json)?;
    let backup = backup_path(path);
    if path.exists() {
        let _ = std::fs::copy(path, &backup);
    }
    crate::settings::atomic_write_text(path, json)
}

fn remove_pins_files(path: &std::path::Path) {
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    let backup = backup_path(path);
    if backup.exists() {
        let _ = std::fs::remove_file(&backup);
    }
}

pub(crate) fn remove_pins_for_app(app: &tauri::AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        remove_pins_files(&dir.join("pins.json"));
    }
}

#[tauri::command]
pub fn load_pins(app: tauri::AppHandle) -> Result<String, String> {
    let _guard = lock_pins()?;
    read_pins_text(&pins_path(&app)?)
}

#[tauri::command]
pub fn save_pins(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let _guard = lock_pins()?;
    write_pins_text(&pins_path(&app)?, &json)
}

#[tauri::command]
pub fn delete_pins(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = lock_pins()?;
    remove_pins_files(&pins_path(&app)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scoped_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("arlet-pins-{name}-{}", std::process::id()))
    }

    fn pins_doc(ids: &[(&str, &str)]) -> String {
        let entries = ids
            .iter()
            .map(|(id, source)| format!(r#"{{"id":"{id}","source":"{source}"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        format!(r#"{{"schemaVersion":{PINS_SCHEMA_VERSION},"pins":[{entries}]}}"#)
    }

    #[test]
    fn valid_payloads_pass_validation() {
        assert!(validate_pins_json("[]").is_ok());
        assert!(validate_pins_json(r#"{"schemaVersion":1,"pins":[]}"#).is_ok());
        assert!(validate_pins_json(&pins_doc(&[("a", "library"), ("b", "catalog")])).is_ok());
    }

    #[test]
    fn invalid_shapes_are_rejected() {
        for bad in [
            "not json",
            "{}",
            r#"{"pins":{}}"#,
            r#"{"pins":[{"id":"","source":"library"}]}"#,
            r#"{"pins":[{"source":"library"}]}"#,
            r#"{"pins":[{"id":"a"}]}"#,
            r#"{"pins":[{"id":"a","source":"방"}]}"#,
            r#"{"pins":[{"id":"a","source":"library"},{"id":"","source":"catalog"}]}"#,
            r#"{"pins":"oops"}"#,
            "[42]",
        ] {
            assert!(validate_pins_json(bad).is_err(), "accepted: {bad}");
        }
    }

    #[test]
    fn oversize_payload_is_rejected() {
        let big_id = "x".repeat(MAX_PINS_BYTES);
        let payload = format!(r#"{{"pins":[{{"id":"{big_id}","source":"library"}}]}}"#);
        assert!(validate_pins_json(&payload).is_err());
    }

    #[test]
    fn more_than_max_pins_is_rejected() {
        let entries = (0..=MAX_PINS)
            .map(|index| format!(r#"{{"id":"pin-{index}","source":"library"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        let payload = format!(r#"{{"schemaVersion":1,"pins":[{entries}]}}"#);
        assert!(validate_pins_json(&payload).is_err());
        let fitting = (0..MAX_PINS)
            .map(|index| format!(r#"{{"id":"pin-{index}","source":"library"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        assert!(validate_pins_json(&format!(r#"{{"pins":[{fitting}]}}"#)).is_ok());
    }

    #[test]
    fn round_trip_save_and_load() {
        let dir = scoped_dir("round-trip");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("pins.json");
        let payload = pins_doc(&[("a", "library"), ("b", "catalog")]);
        write_pins_text(&path, &payload).unwrap();
        assert_eq!(read_pins_text(&path).unwrap(), payload);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_loads_empty_array() {
        let dir = scoped_dir("missing");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            read_pins_text(&dir.join("pins.json")).unwrap(),
            "[]".to_string()
        );
    }

    #[test]
    fn corrupt_file_fails_load() {
        let dir = scoped_dir("corrupt");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("pins.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "{oops").unwrap();
        assert!(read_pins_text(&path).is_err());
        std::fs::write(&path, r#"{"pins":[{"id":"a"}]}"#).unwrap();
        assert!(read_pins_text(&path).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_save_never_touches_disk() {
        let dir = scoped_dir("invalid-save");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("pins.json");
        assert!(write_pins_text(&path, r#"{"pins":[{"id":""}]}"#).is_err());
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_pins_on_missing_file_is_ok() {
        let dir = scoped_dir("delete-missing");
        let _ = std::fs::remove_dir_all(&dir);
        remove_pins_files(&dir.join("pins.json"));
        assert!(!dir.exists());
    }

    #[test]
    fn reset_sidecar_removal_clears_pins_files() {
        let dir = scoped_dir("reset");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("pins.json");
        write_pins_text(&path, &pins_doc(&[("a", "library")])).unwrap();
        write_pins_text(&path, &pins_doc(&[("b", "catalog")])).unwrap();
        assert!(backup_path(&path).exists());
        remove_pins_files(&path);
        assert!(!path.exists());
        assert!(!backup_path(&path).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
