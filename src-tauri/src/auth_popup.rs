//! MusicKit `authorize()` opens `authorize.music.apple.com` via `window.open`.
//! Tauri 2 denies webview popups unless `on_new_window` allows them.

use tauri::{webview::NewWindowResponse, App, Runtime, WebviewWindow, WebviewWindowBuilder};
use url::Url;

pub const MAIN_WINDOW_LABEL: &str = "main";

const ALLOWED_AUTH_HOSTS: &[&str] = &[
    "authorize.music.apple.com",
    "appleid.apple.com",
    "idmsa.apple.com",
    "gsa.apple.com",
    "account.apple.com",
];

/// Host-only check. Do not inspect query strings; they carry the developer JWT.
pub fn is_allowed_auth_popup_url(url: &Url) -> bool {
    if url.scheme() == "about" {
        return url.path() == "blank" || url.as_str() == "about:blank";
    }
    matches!(url.scheme(), "https")
        && url
            .host_str()
            .is_some_and(|host| ALLOWED_AUTH_HOSTS.contains(&host))
}

pub fn decide_new_window<R: Runtime>(url: Url) -> NewWindowResponse<R> {
    if is_allowed_auth_popup_url(&url) {
        NewWindowResponse::Allow
    } else {
        NewWindowResponse::Deny
    }
}

pub fn create_main_window(app: &App) -> Result<WebviewWindow, Box<dyn std::error::Error>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW_LABEL)
        .cloned()
        .ok_or("tauri.conf.json is missing a window with label \"main\"")?;
    Ok(WebviewWindowBuilder::from_config(app.handle(), &config)?
        .on_new_window(|url, _features| decide_new_window(url))
        .build()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(url: &str) -> Url {
        Url::parse(url).expect("url")
    }

    #[test]
    fn allows_musickit_authorize_host() {
        assert!(is_allowed_auth_popup_url(&parse(
            "https://authorize.music.apple.com/woa?a=eyJhbGciOiJFUzI1NiJ9.payload"
        )));
    }

    #[test]
    fn allows_apple_id_hosts() {
        assert!(is_allowed_auth_popup_url(&parse(
            "https://appleid.apple.com/auth/authorize"
        )));
        assert!(is_allowed_auth_popup_url(&parse(
            "https://idmsa.apple.com/appleauth/auth/signin"
        )));
        assert!(is_allowed_auth_popup_url(&parse("https://gsa.apple.com/")));
        assert!(is_allowed_auth_popup_url(&parse(
            "https://account.apple.com/"
        )));
    }

    #[test]
    fn allows_about_blank() {
        assert!(is_allowed_auth_popup_url(&parse("about:blank")));
    }

    #[test]
    fn denies_unrelated_https() {
        assert!(!is_allowed_auth_popup_url(&parse("https://example.com/")));
        assert!(!is_allowed_auth_popup_url(&parse(
            "https://music.apple.com/"
        )));
        assert!(!is_allowed_auth_popup_url(&parse("http://localhost:5173/")));
    }

    #[test]
    fn main_window_is_created_from_rust() {
        let raw = include_str!("../tauri.conf.json");
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        let window = &value["app"]["windows"][0];
        assert_eq!(window["label"], MAIN_WINDOW_LABEL);
        assert_eq!(window["create"], false);
    }
}
