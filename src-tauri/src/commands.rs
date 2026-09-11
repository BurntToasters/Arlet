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
}
