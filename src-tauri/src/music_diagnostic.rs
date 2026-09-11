use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

pub const WINDOW_LABEL: &str = "music-diagnostic";
pub const DIAGNOSTIC_URL: &str = "https://music.apple.com/";
pub const AUTO_OPEN_ENV: &str = "ARLET_OPEN_MUSIC_DIAGNOSTIC";

pub fn should_auto_open_music_diagnostic(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1"))
}

/// Opens Apple's site in a separate webview with zero Tauri IPC.
/// Do not inject scripts or scrape the page; this is a DRM-runtime probe only.
#[tauri::command]
pub fn open_music_diagnostic(app: AppHandle) -> Result<String, String> {
    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        existing.set_focus().map_err(|err| err.to_string())?;
        return Ok("focused".to_string());
    }

    let url = Url::parse(DIAGNOSTIC_URL).map_err(|err| err.to_string())?;
    WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::External(url))
        .title("Arlet — music.apple.com diagnostic (unprivileged)")
        .inner_size(1100.0, 800.0)
        .resizable(true)
        .build()
        .map_err(|err| err.to_string())?;
    Ok("opened".to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn diagnostic_url_is_https_apple_music() {
        let url = url::Url::parse(super::DIAGNOSTIC_URL).unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("music.apple.com"));
    }

    #[test]
    fn diagnostic_window_label_is_stable() {
        assert_eq!(super::WINDOW_LABEL, "music-diagnostic");
    }

    #[test]
    fn auto_open_env_is_opt_in() {
        assert!(!super::should_auto_open_music_diagnostic(None));
        assert!(!super::should_auto_open_music_diagnostic(Some("")));
        assert!(!super::should_auto_open_music_diagnostic(Some("true")));
        assert!(super::should_auto_open_music_diagnostic(Some("1")));
        assert!(super::should_auto_open_music_diagnostic(Some(" 1 ")));
    }

    #[test]
    fn diagnostic_capability_has_zero_permissions() {
        let raw = include_str!("../capabilities/music-diagnostic.json");
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        assert_eq!(value["identifier"], "music-diagnostic");
        assert_eq!(value["windows"][0], "music-diagnostic");
        assert_eq!(value["local"], false);
        let permissions = value["permissions"].as_array().expect("permissions array");
        assert!(permissions.is_empty());
    }

    #[test]
    fn default_capability_does_not_cover_diagnostic_window() {
        let raw = include_str!("../capabilities/default.json");
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        let windows = value["windows"].as_array().expect("windows array");
        assert_eq!(windows, &vec![serde_json::json!("main")]);
        assert!(windows.iter().all(|window| window != "music-diagnostic"));
    }
}
