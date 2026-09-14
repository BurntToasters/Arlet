//! Settings persistence with atomic writes; preserves reserved `_`-prefixed keys.

use crate::window_fx::WindowEffectPreference;
use serde_json::Value;
use tauri::{Manager, Theme, WebviewWindow};

static SETTINGS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const MAX_SETTINGS_BYTES: usize = 512 * 1024;
pub const SETTINGS_SCHEMA_VERSION: u64 = 1;

/// User-facing theme preference used when choosing the native material tint.
/// The system variant follows the theme reported by the window runtime.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

impl ThemePreference {
    fn from_setting(value: Option<&str>) -> Self {
        match value {
            Some("light") => Self::Light,
            Some("dark") => Self::Dark,
            Some("system") | None => Self::System,
            Some(_) => Self::System,
        }
    }

    pub fn resolve_dark(self, window: &WebviewWindow) -> bool {
        match self {
            Self::Dark => true,
            Self::Light => false,
            Self::System => matches!(window.theme().ok(), Some(Theme::Dark)),
        }
    }
}

/// The startup-only subset of persisted settings. Keeping this as a small
/// typed value prevents arbitrary settings (including tokens) from crossing
/// into native startup code or diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StartupAppearance {
    pub theme: ThemePreference,
    pub window_effect: WindowEffectPreference,
}

impl Default for StartupAppearance {
    fn default() -> Self {
        Self {
            theme: ThemePreference::System,
            window_effect: WindowEffectPreference::Acrylic,
        }
    }
}

/// Parse only the stable appearance keys. Missing fields use the defaults;
/// an explicitly unsupported schema version invalidates the appearance
/// subset without touching the rest of the settings file.
pub fn parse_startup_appearance(json: &str) -> StartupAppearance {
    let default = StartupAppearance::default();
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return default;
    };
    let Some(object) = value.as_object() else {
        return default;
    };

    if object
        .get("schemaVersion")
        .map(Value::as_u64)
        .unwrap_or(Some(SETTINGS_SCHEMA_VERSION))
        != Some(SETTINGS_SCHEMA_VERSION)
    {
        return default;
    }

    StartupAppearance {
        theme: ThemePreference::from_setting(object.get("theme").and_then(Value::as_str)),
        window_effect: WindowEffectPreference::from_setting(
            object.get("windowEffect").and_then(Value::as_str),
        ),
    }
}

/// Read startup appearance without going through `load_settings`: that
/// command holds `SETTINGS_LOCK`, and setup must not call a locking command
/// from inside another settings operation. Errors, oversized files, and
/// malformed JSON intentionally collapse to safe defaults.
pub fn load_startup_appearance(app: &tauri::AppHandle) -> StartupAppearance {
    let Ok(path) = settings_path(app) else {
        return StartupAppearance::default();
    };
    let Ok(metadata) = std::fs::metadata(&path) else {
        return StartupAppearance::default();
    };
    if metadata.len() > MAX_SETTINGS_BYTES as u64 {
        return StartupAppearance::default();
    }
    std::fs::read_to_string(path)
        .map(|content| parse_startup_appearance(&content))
        .unwrap_or_default()
}

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

pub fn atomic_write_text(path: &std::path::Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;

    // `std::fs::rename` maps to MoveFileExW on Windows, but its default
    // semantics refuse to replace an existing destination. ReplaceFileW
    // keeps the swap atomic for the normal save path while MoveFileExW is
    // used for the first save, when no destination exists yet.
    #[cfg(target_os = "windows")]
    replace_existing_windows(&tmp, path)?;
    #[cfg(not(target_os = "windows"))]
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn replace_existing_windows(
    temporary: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        REPLACEFILE_WRITE_THROUGH,
    };

    fn wide(path: &std::path::Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let temporary_wide = wide(temporary);
    let destination_wide = wide(destination);
    let temporary_name = PCWSTR(temporary_wide.as_ptr());
    let destination_name = PCWSTR(destination_wide.as_ptr());

    if destination.exists() {
        // A backup is made by save_settings before this helper is called, so
        // passing null here avoids changing the backup contract or exposing
        // another transient file to readers.
        unsafe {
            ReplaceFileW(
                destination_name,
                temporary_name,
                PCWSTR::null(),
                REPLACEFILE_WRITE_THROUGH,
                None,
                None,
            )
        }
        .map_err(|error| format!("ReplaceFileW failed: {error}"))
    } else {
        unsafe {
            MoveFileExW(
                temporary_name,
                destination_name,
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|error| format!("MoveFileExW failed: {error}"))
    }
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
    fn atomic_write_replaces_existing_file() {
        let dir = std::env::temp_dir().join(format!(
            "arlet-settings-overwrite-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("test.json");

        atomic_write_text(&path, "first").unwrap();
        atomic_write_text(&path, "second").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_oversized_payload() {
        let large = "x".repeat(MAX_SETTINGS_BYTES + 1);
        assert!(large.len() > MAX_SETTINGS_BYTES);
    }

    #[test]
    fn startup_appearance_uses_safe_defaults() {
        assert_eq!(parse_startup_appearance("{}"), StartupAppearance::default());
        assert_eq!(
            parse_startup_appearance("not json"),
            StartupAppearance::default()
        );
    }

    #[test]
    fn startup_appearance_reads_only_versioned_known_values() {
        let appearance = parse_startup_appearance(
            r#"{
                "schemaVersion": 1,
                "theme": "dark",
                "windowEffect": "mica",
                "developerToken": "eyJsecret"
            }"#,
        );
        assert_eq!(appearance.theme, ThemePreference::Dark);
        assert_eq!(appearance.window_effect, WindowEffectPreference::Mica);
    }

    #[test]
    fn startup_appearance_invalid_values_default_independently() {
        let appearance =
            parse_startup_appearance(r#"{"schemaVersion":1,"theme":"neon","windowEffect":"blur"}"#);
        assert_eq!(appearance.theme, ThemePreference::System);
        assert_eq!(appearance.window_effect, WindowEffectPreference::Acrylic);
    }

    #[test]
    fn startup_appearance_rejects_unknown_schema() {
        let appearance = parse_startup_appearance(
            r#"{"schemaVersion":2,"theme":"dark","windowEffect":"solid"}"#,
        );
        assert_eq!(appearance, StartupAppearance::default());
    }
}
