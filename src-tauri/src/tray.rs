//! System tray: playback commands, Show, and Quit. Shown while the `trayIcon`
//! setting is on, which also makes closing the window hide to the tray. The
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
/// Set while the tray icon exists; without it a hidden window cannot return.
static INSTALLED: AtomicBool = AtomicBool::new(false);

/// Closing hides to the tray only while the tray is on and its icon exists,
/// and never during a tray Quit or a settings reset, which must really close.
pub fn hides_on_close(
    tray_icon: bool,
    tray_installed: bool,
    quitting: bool,
    reset_pending: bool,
) -> bool {
    tray_icon && tray_installed && !quitting && !reset_pending
}

pub fn should_hide_on_close() -> bool {
    hides_on_close(
        settings::tray_icon(),
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

/// Left-click hides a shown window and shows a hidden or minimized one.
pub fn toggle_hides(visible: bool, minimized: bool) -> bool {
    visible && !minimized
}

fn toggle_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(auth_popup::MAIN_WINDOW_LABEL) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    if toggle_hides(visible, minimized) {
        let _ = window.hide();
    } else {
        show_main_window(app);
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
            let _ = app.emit_to(
                auth_popup::MAIN_WINDOW_LABEL,
                "windows-media-control",
                control,
            );
        }
        Some(TrayAction::Next) => {
            let _ = app.emit_to(
                auth_popup::MAIN_WINDOW_LABEL,
                "windows-media-control",
                "next",
            );
        }
        Some(TrayAction::Previous) => {
            let _ = app.emit_to(
                auth_popup::MAIN_WINDOW_LABEL,
                "windows-media-control",
                "previous",
            );
        }
        Some(TrayAction::Show) => show_main_window(app),
        Some(TrayAction::Quit) => quit(app),
        None => {}
    }
}

/// Builds the tray icon unless it already exists, so a WebView2 recovery or
/// a repeated settings save never adds a duplicate.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        INSTALLED.store(true, Ordering::SeqCst);
        return Ok(());
    }
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
        // Left-click toggles the window; the menu opens on right-click only.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    INSTALLED.store(true, Ordering::SeqCst);
    Ok(())
}

/// Removes the tray icon. A window hidden in the tray is shown first, since
/// nothing could bring it back afterwards.
pub fn remove(app: &AppHandle) {
    INSTALLED.store(false, Ordering::SeqCst);
    show_main_window(app);
    let _ = app.remove_tray_by_id(TRAY_ID);
}

/// Applies the `trayIcon` setting on the main thread, where tray icons live.
pub fn apply(app: &AppHandle, enabled: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if enabled {
            if let Err(error) = install(&handle) {
                eprintln!("Unable to create the tray icon: {error}");
            }
        } else if INSTALLED.load(Ordering::SeqCst) {
            remove(&handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{hides_on_close, menu_action, play_pause_control, toggle_hides, TrayAction};

    fn hides(tray_icon: bool, installed: bool, quitting: bool, reset: bool) -> bool {
        hides_on_close(tray_icon, installed, quitting, reset)
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

    // Failure modes: with the tray on the app cannot be quit or the reset
    // restart hides; with the tray off closing hides with no icon.
    #[test]
    fn close_hides_only_while_enabled_and_not_quitting_or_resetting() {
        assert!(hides(true, true, false, false));
        assert!(!hides(false, true, false, false));
        assert!(!hides(true, false, false, false));
        assert!(!hides(true, true, true, false));
        assert!(!hides(true, true, false, true));
    }

    // Failure mode: left-click does not toggle the window.
    #[test]
    fn left_click_hides_only_a_shown_window() {
        assert!(toggle_hides(true, false));
        assert!(!toggle_hides(true, true));
        assert!(!toggle_hides(false, false));
        assert!(!toggle_hides(false, true));
    }
}
