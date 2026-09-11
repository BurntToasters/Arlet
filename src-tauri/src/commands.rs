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
        debug: cfg!(debug_assertions),
    })
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
            debug: true,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("0.1.0"));
        assert!(json.contains("webview_version"));
    }
}
