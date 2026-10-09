//! System tray: playback commands, Show, and Quit. Built once in setup; the
//! playback items reuse the SMTC `windows-media-control` event so the
//! frontend has one path for both.

use crate::{auth_popup, settings, window_state, windows_media};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

const TRAY_ID: &str = "arlet-tray";
const ID_PLAY_PAUSE: &str = "tray-play-pause";
const ID_NEXT: &str = "tray-next";
const ID_PREVIOUS: &str = "tray-previous";
const ID_SHOW: &str = "tray-show";
const ID_QUIT: &str = "tray-quit";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayAction {
    PlayPause,
    Next,
    Previous,
    Show,
    Quit,
}

pub fn menu_action(id: &str) -> Option<TrayAction> {
    match id {
        ID_PLAY_PAUSE => Some(TrayAction::PlayPause),
        ID_NEXT => Some(TrayAction::Next),
        ID_PREVIOUS => Some(TrayAction::Previous),
        ID_SHOW => Some(TrayAction::Show),
        ID_QUIT => Some(TrayAction::Quit),
        _ => None,
    }
}

/// The SMTC control a Play/Pause toggle sends: pause while playing, else play.
pub fn play_pause_control(playing: bool) -> &'static str {
    if playing {
        "pause"
    } else {
        "play"
    }
}

/// Set before a tray Quit so the close handler lets the window close.
static QUITTING: AtomicBool = AtomicBool::new(false);
/// Set once the tray icon exists; without it a hidden window cannot return.
static INSTALLED: AtomicBool = AtomicBool::new(false);

/// Close-to-tray only applies while the tray can restore the window, and
/// never during a tray Quit or a settings reset, which must really close it.
pub fn hides_on_close(
    close_to_tray: bool,
    tray_installed: bool,
    quitting: bool,
    reset_pending: bool,
) -> bool {
    close_to_tray && tray_installed && !quitting && !reset_pending
}

pub fn should_hide_on_close() -> bool {
    hides_on_close(
        settings::close_to_tray(),
        INSTALLED.load(Ordering::SeqCst),
        QUITTING.load(Ordering::SeqCst),
        settings::reset_pending(),
    )
}

/// Restores a hidden or minimized main window and brings it forward.
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(auth_popup::MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(auth_popup::MAIN_WINDOW_LABEL) {
        window_state::persist(&window.as_ref().window());
    }
    app.exit(0);
}

fn handle_menu(app: &AppHandle, id: &str) {
    match menu_action(id) {
        Some(TrayAction::PlayPause) => {
            let control = play_pause_control(windows_media::is_playing());
            let _ = app.emit("windows-media-control", control);
        }
        Some(TrayAction::Next) => {
            let _ = app.emit("windows-media-control", "next");
        }
        Some(TrayAction::Previous) => {
            let _ = app.emit("windows-media-control", "previous");
        }
        Some(TrayAction::Show) => show_main_window(app),
        Some(TrayAction::Quit) => quit(app),
        None => {}
    }
}

/// Builds the tray icon. The icon is created once here; WebView2 recovery
/// reloads the page without calling this again, so no duplicate appears.
pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let play_pause = MenuItem::with_id(app, ID_PLAY_PAUSE, "Play/Pause", true, None::<&str>)?;
    let next = MenuItem::with_id(app, ID_NEXT, "Next", true, None::<&str>)?;
    let previous = MenuItem::with_id(app, ID_PREVIOUS, "Previous", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let show = MenuItem::with_id(app, ID_SHOW, "Show Arlet", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, ID_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&play_pause, &next, &previous, &separator, &show, &quit_item],
    )?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Arlet")
        .menu(&menu)
        // Left click shows the window; the menu opens on right click only.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    INSTALLED.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{hides_on_close, menu_action, play_pause_control, TrayAction};

    fn hides(close_to_tray: bool, installed: bool, quitting: bool, reset: bool) -> bool {
        hides_on_close(close_to_tray, installed, quitting, reset)
    }

    // Failure mode: tray items route to the wrong command or unknown ids
    // trigger an action.
    #[test]
    fn menu_ids_map_to_actions() {
        assert_eq!(menu_action("tray-play-pause"), Some(TrayAction::PlayPause));
        assert_eq!(menu_action("tray-next"), Some(TrayAction::Next));
        assert_eq!(menu_action("tray-previous"), Some(TrayAction::Previous));
        assert_eq!(menu_action("tray-show"), Some(TrayAction::Show));
        assert_eq!(menu_action("tray-quit"), Some(TrayAction::Quit));
        assert_eq!(menu_action("tray-unknown"), None);
        assert_eq!(menu_action(""), None);
    }

    #[test]
    fn play_pause_item_sends_the_opposite_of_playback_state() {
        assert_eq!(play_pause_control(true), "pause");
        assert_eq!(play_pause_control(false), "play");
    }

    // Failure modes: close-to-tray leaves the app impossible to quit, or
    // breaks the reset-settings restart.
    #[test]
    fn close_hides_only_while_enabled_and_not_quitting_or_resetting() {
        assert!(hides(true, true, false, false));
        assert!(!hides(false, true, false, false));
        assert!(!hides(true, false, false, false));
        assert!(!hides(true, true, true, false));
        assert!(!hides(true, true, false, true));
    }
}
