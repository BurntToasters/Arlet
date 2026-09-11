use serde::Serialize;

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

#[tauri::command]
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

const TOKEN_ENV_KEYS: [&str; 2] = ["MUSICKIT_DEVELOPER_TOKEN", "VITE_MUSICKIT_DEVELOPER_TOKEN"];

pub fn developer_token_from_lookup<F>(lookup: F) -> Result<String, String>
where
    F: Fn(&str) -> Option<String>,
{
    if !cfg!(debug_assertions) {
        return Err("MusicKit developer tokens are not served in release builds.".to_string());
    }
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

pub fn developer_token_from_env() -> Result<String, String> {
    developer_token_from_lookup(|key| std::env::var(key).ok())
}

#[tauri::command]
pub fn get_developer_token() -> Result<String, String> {
    developer_token_from_env()
}

#[cfg(windows)]
fn windows_display_build() -> Option<String> {
    use std::process::Command;
    let script = "$v=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'; \"$($v.DisplayVersion) build $($v.CurrentBuild).$($v.UBR)\"";
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
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

    #[test]
    fn debug_reads_musickit_developer_token() {
        let token = super::developer_token_from_lookup(|key| {
            (key == "MUSICKIT_DEVELOPER_TOKEN").then(|| " jwt-from-env ".to_string())
        })
        .expect("token");
        assert_eq!(token, "jwt-from-env");
    }

    #[test]
    fn debug_accepts_legacy_vite_token_alias() {
        let token = super::developer_token_from_lookup(|key| {
            (key == "VITE_MUSICKIT_DEVELOPER_TOKEN").then(|| "legacy-jwt".to_string())
        })
        .expect("token");
        assert_eq!(token, "legacy-jwt");
    }

    #[test]
    fn missing_token_does_not_echo_secrets() {
        let err = super::developer_token_from_lookup(|_| None).unwrap_err();
        assert!(err.contains("MUSICKIT_DEVELOPER_TOKEN"));
        assert!(!err.contains("jwt"));
    }
}
