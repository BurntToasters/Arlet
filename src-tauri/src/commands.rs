use serde::Serialize;

#[derive(Serialize)]
pub struct AppInfo {
    pub version: String,
    pub tauri_version: String,
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
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn app_info_serializes() {
        let info = super::AppInfo {
            version: "0.1.0".to_string(),
            tauri_version: "2.0.0".to_string(),
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("0.1.0"));
    }
}
