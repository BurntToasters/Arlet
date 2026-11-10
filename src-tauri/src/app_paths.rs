//! App data paths with an isolated profile override for native E2E builds.

use std::path::PathBuf;
#[cfg(not(feature = "e2e"))]
use tauri::Manager;

#[cfg(feature = "e2e")]
const E2E_ROOT_ENV: &str = "ARLET_E2E_DATA_ROOT";
#[cfg(feature = "e2e")]
const E2E_MARKER: &str = ".arlet-e2e-profile.json";
#[cfg(not(feature = "e2e"))]
const APP_IDENTIFIER: &str = "run.rosie.arlet";

/// Returns the validated isolated root when this binary has the E2E feature.
/// Ordinary builds do not inspect or honor `ARLET_E2E_DATA_ROOT`.
#[cfg(feature = "e2e")]
pub fn e2e_profile_root() -> Result<PathBuf, String> {
    let root = std::env::var_os(E2E_ROOT_ENV)
        .ok_or_else(|| format!("{E2E_ROOT_ENV} is required by this E2E build"))?;
    let root = PathBuf::from(root);
    if !root.is_absolute() {
        return Err(format!("{E2E_ROOT_ENV} must be an absolute path"));
    }
    let root_metadata = std::fs::symlink_metadata(&root).map_err(|error| {
        format!(
            "unable to inspect {E2E_ROOT_ENV} {}: {error}",
            root.display()
        )
    })?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(format!(
            "{E2E_ROOT_ENV} must name a plain existing directory: {}",
            root.display()
        ));
    }

    let parent = root
        .parent()
        .ok_or_else(|| format!("{E2E_ROOT_ENV} has no parent directory"))?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(|error| {
        format!(
            "unable to resolve E2E profile parent {}: {error}",
            parent.display()
        )
    })?;
    let temp_dir = std::fs::canonicalize(std::env::temp_dir())
        .map_err(|error| format!("unable to resolve the system temp directory: {error}"))?;
    if canonical_parent != temp_dir {
        return Err(format!(
            "E2E profile must be a direct child of the system temp directory: {}",
            root.display()
        ));
    }

    let marker_path = root.join(E2E_MARKER);
    let marker_metadata = std::fs::symlink_metadata(&marker_path).map_err(|error| {
        format!(
            "E2E profile marker is unavailable at {}: {error}",
            marker_path.display()
        )
    })?;
    if !marker_metadata.is_file() || marker_metadata.file_type().is_symlink() {
        return Err(format!(
            "E2E profile marker is not a plain file: {}",
            marker_path.display()
        ));
    }
    let marker: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&marker_path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("E2E profile marker is invalid: {error}"))?;
    let root_text = root.to_string_lossy();
    let run_id = marker["runId"].as_str().unwrap_or_default();
    let owner_token = marker["ownerToken"].as_str().unwrap_or_default();
    let expected_name = format!("arlet-e2e-{run_id}");
    let uuid_bytes = run_id.as_bytes();
    let valid_uuid = uuid_bytes.len() == 36
        && uuid_bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| match index {
                8 | 13 | 18 | 23 => *byte == b'-',
                _ => byte.is_ascii_hexdigit(),
            });
    if marker["schemaVersion"].as_u64() != Some(1)
        || marker["root"].as_str() != Some(root_text.as_ref())
        || !valid_uuid
        || root.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str())
        || owner_token.len() != 64
        || !owner_token.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(format!(
            "E2E profile marker does not match {}",
            root.display()
        ));
    }
    Ok(root)
}

pub fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    {
        let _ = app;
        Ok(e2e_profile_root()?.join("data"))
    }
    #[cfg(not(feature = "e2e"))]
    {
        app.path().app_data_dir().map_err(|error| error.to_string())
    }
}

/// Runs an account-data clear through the E2E-only fault controller and trace.
/// Ordinary builds call the operation directly and ignore all E2E files.
pub(crate) fn run_account_data_clear<T>(
    app: &tauri::AppHandle,
    command: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    #[cfg(feature = "e2e")]
    {
        run_e2e_account_data_clear(app, command, operation)
    }
    #[cfg(not(feature = "e2e"))]
    {
        let _ = (app, command);
        operation()
    }
}

#[cfg(feature = "e2e")]
const ACCOUNT_CLEAR_FAULT_FILE: &str = "e2e-account-clear-fault.json";
#[cfg(feature = "e2e")]
const ACCOUNT_CLEAR_TRACE_FILE: &str = "e2e-account-clear-trace.jsonl";
#[cfg(feature = "e2e")]
const MAX_ACCOUNT_CLEAR_FAULT_BYTES: u64 = 1024;
#[cfg(feature = "e2e")]
const MAX_ACCOUNT_CLEAR_TRACE_BYTES: usize = 64 * 1024;
#[cfg(feature = "e2e")]
const MAX_ACCOUNT_CLEAR_TRACE_RECORDS: usize = 128;
#[cfg(feature = "e2e")]
static ACCOUNT_CLEAR_TRACE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(feature = "e2e")]
fn valid_account_clear_command(command: &str) -> bool {
    matches!(
        command,
        "library_cache_clear" | "delete_pins" | "delete_playback_session"
    )
}

#[cfg(feature = "e2e")]
fn account_clear_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?;
    let metadata = std::fs::symlink_metadata(&dir)
        .map_err(|_| "E2E account-data directory is unavailable.".to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("E2E account-data directory must be a plain directory.".to_string());
    }
    Ok(dir)
}

#[cfg(feature = "e2e")]
fn read_account_clear_fault(path: &std::path::Path) -> Result<Option<String>, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("E2E account-data fault control is unreadable.".to_string()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("E2E account-data fault control must be a plain file.".to_string());
    }
    if metadata.len() > MAX_ACCOUNT_CLEAR_FAULT_BYTES {
        return Err("E2E account-data fault control exceeds its size limit.".to_string());
    }
    let bytes = std::fs::read(path)
        .map_err(|_| "E2E account-data fault control is unreadable.".to_string())?;
    if bytes.len() as u64 > MAX_ACCOUNT_CLEAR_FAULT_BYTES {
        return Err("E2E account-data fault control exceeds its size limit.".to_string());
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "E2E account-data fault control is malformed.".to_string())?;
    let object = value
        .as_object()
        .filter(|object| object.len() == 1)
        .ok_or_else(|| "E2E account-data fault control is malformed.".to_string())?;
    let command = object
        .get("command")
        .and_then(serde_json::Value::as_str)
        .filter(|command| valid_account_clear_command(command))
        .ok_or_else(|| "E2E account-data fault control is malformed.".to_string())?;
    Ok(Some(command.to_string()))
}

#[cfg(feature = "e2e")]
fn read_account_clear_trace(path: &std::path::Path) -> Result<Vec<String>, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("E2E account-data trace is unreadable.".to_string()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("E2E account-data trace must be a plain file.".to_string());
    }
    if metadata.len() > MAX_ACCOUNT_CLEAR_TRACE_BYTES as u64 {
        return Err("E2E account-data trace exceeds its size limit.".to_string());
    }
    let text = std::fs::read_to_string(path)
        .map_err(|_| "E2E account-data trace is unreadable.".to_string())?;
    let mut lines = Vec::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let record: serde_json::Value = serde_json::from_str(line)
            .map_err(|_| "E2E account-data trace is malformed.".to_string())?;
        let object = record
            .as_object()
            .filter(|object| object.len() == 3)
            .ok_or_else(|| "E2E account-data trace is malformed.".to_string())?;
        let command = record.get("command").and_then(serde_json::Value::as_str);
        let outcome = record.get("outcome").and_then(serde_json::Value::as_str);
        if !command.is_some_and(valid_account_clear_command)
            || !matches!(
                outcome,
                Some("success")
                    | Some("failure")
                    | Some("injected_failure")
                    | Some("invalid_control")
            )
            || record
                .get("atUnixMs")
                .and_then(serde_json::Value::as_u64)
                .is_none()
            || !object.contains_key("command")
            || !object.contains_key("outcome")
            || !object.contains_key("atUnixMs")
        {
            return Err("E2E account-data trace is malformed.".to_string());
        }
        lines.push(line.to_string());
    }
    if lines.len() > MAX_ACCOUNT_CLEAR_TRACE_RECORDS {
        return Err("E2E account-data trace exceeds its record limit.".to_string());
    }
    Ok(lines)
}

#[cfg(feature = "e2e")]
fn append_account_clear_trace(
    path: &std::path::Path,
    command: &str,
    outcome: &str,
) -> Result<(), String> {
    let mut lines = read_account_clear_trace(path)?;
    let at_unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "E2E account-data trace clock is invalid.".to_string())?
        .as_millis() as u64;
    let record = serde_json::json!({
        "atUnixMs": at_unix_ms,
        "command": command,
        "outcome": outcome,
    });
    let serialized = serde_json::to_string(&record)
        .map_err(|_| "E2E account-data trace could not be encoded.".to_string())?;
    if serialized.len() + 1 > MAX_ACCOUNT_CLEAR_TRACE_BYTES {
        return Err("E2E account-data trace record exceeds its size limit.".to_string());
    }
    while lines.len() >= MAX_ACCOUNT_CLEAR_TRACE_RECORDS
        || lines.iter().map(|line| line.len() + 1).sum::<usize>() + serialized.len() + 1
            > MAX_ACCOUNT_CLEAR_TRACE_BYTES
    {
        if lines.is_empty() {
            return Err("E2E account-data trace could not be bounded.".to_string());
        }
        lines.remove(0);
    }
    lines.push(serialized);
    let mut text = lines.join("\n");
    text.push('\n');
    std::fs::write(path, text)
        .map_err(|_| "E2E account-data trace could not be written.".to_string())
}

#[cfg(feature = "e2e")]
fn run_e2e_account_data_clear<T>(
    app: &tauri::AppHandle,
    command: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if !valid_account_clear_command(command) {
        return Err("Unknown E2E account-data clear command.".to_string());
    }
    let _guard = ACCOUNT_CLEAR_TRACE_LOCK
        .lock()
        .map_err(|_| "E2E account-data trace lock is poisoned.".to_string())?;
    let dir = account_clear_data_dir(app)?;
    let fault = match read_account_clear_fault(&dir.join(ACCOUNT_CLEAR_FAULT_FILE)) {
        Ok(fault) => fault,
        Err(error) => {
            append_account_clear_trace(
                &dir.join(ACCOUNT_CLEAR_TRACE_FILE),
                command,
                "invalid_control",
            )?;
            return Err(error);
        }
    };
    if fault.as_deref() == Some(command) {
        append_account_clear_trace(
            &dir.join(ACCOUNT_CLEAR_TRACE_FILE),
            command,
            "injected_failure",
        )?;
        return Err(format!(
            "E2E injected account-data clear failure for {command}."
        ));
    }
    let result = operation();
    let outcome = if result.is_ok() { "success" } else { "failure" };
    append_account_clear_trace(&dir.join(ACCOUNT_CLEAR_TRACE_FILE), command, outcome)?;
    result
}

pub fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    {
        let _ = app;
        Ok(e2e_profile_root()?.join("data"))
    }
    #[cfg(not(feature = "e2e"))]
    {
        app.path()
            .app_config_dir()
            .map_err(|error| error.to_string())
    }
}

pub fn local_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    {
        let _ = app;
        Ok(e2e_profile_root()?.join("local"))
    }
    #[cfg(not(feature = "e2e"))]
    {
        app.path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())
    }
}

pub fn log_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    {
        let _ = app;
        Ok(e2e_profile_root()?.join("logs"))
    }
    #[cfg(not(feature = "e2e"))]
    {
        app.path().app_log_dir().map_err(|error| error.to_string())
    }
}

/// WebView2 persistent storage stays under the same marked E2E run root.
#[cfg(feature = "e2e")]
pub fn webview_data_dir() -> Result<Option<PathBuf>, String> {
    Ok(Some(e2e_profile_root()?.join("webview")))
}

/// Records the current E2E process in its unique profile for safe harness cleanup.
#[cfg(feature = "e2e")]
pub fn record_e2e_process_id() -> Result<(), String> {
    let root = e2e_profile_root()?;
    let marker: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join(E2E_MARKER)).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let started_at_unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let record = serde_json::json!({
        "pid": std::process::id(),
        "startedAtUnixMs": started_at_unix_ms,
        "runId": marker["runId"],
        "ownerToken": marker["ownerToken"],
    });
    std::fs::write(
        root.join("app.pid"),
        serde_json::to_vec(&record).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// Early startup logs have no `AppHandle`; E2E logs must never fall back to a
/// real LOCALAPPDATA directory when the explicit isolated root is invalid.
pub fn native_log_dir() -> Option<PathBuf> {
    #[cfg(feature = "e2e")]
    {
        e2e_profile_root().ok().map(|root| root.join("logs"))
    }

    #[cfg(not(feature = "e2e"))]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(|local| PathBuf::from(local).join(APP_IDENTIFIER).join("logs"))
    }
}
