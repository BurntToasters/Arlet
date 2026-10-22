//! System tray: playback commands, Show, and Quit. Shown while the `trayIcon`
//! setting is on, which also makes closing the window hide to the tray. The
//! playback items reuse the SMTC `windows-media-control` event so the
//! frontend has one path for both.

use crate::{auth_popup, settings, window_state, windows_media};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

const TRAY_ID: &str = "arlet-tray";
const ID_PLAY_PAUSE: &str = "tray-play-pause";
const ID_NEXT: &str = "tray-next";
const ID_PREVIOUS: &str = "tray-previous";
const ID_SHOW: &str = "tray-show";
const ID_QUIT: &str = "tray-quit";
const APP_NAME: &str = "Arlet";
/// Windows keeps tray tooltips to 128 units including the terminating NUL.
const TOOLTIP_MAX_UNITS: usize = 127;
/// Last tooltip set, so a rebuilt tray keeps showing the current song.
static TOOLTIP: Mutex<String> = Mutex::new(String::new());

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

/// True while the tray icon exists.
pub fn is_installed() -> bool {
    INSTALLED.load(Ordering::SeqCst)
}

/// Restores a hidden or minimized main window and brings it forward.
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(auth_popup::MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        // An E2E background launch shows the window without taking focus.
        if !crate::background_launch::enabled() {
            let _ = window.set_focus();
        }
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

/// Sent to the page before Arlet exits, so it can save the queue position.
pub const BEFORE_QUIT_EVENT: &str = "arlet-before-quit";
/// Longest wait for the page to confirm it saved; a dead page never answers.
const QUIT_SAVE_TIMEOUT: Duration = Duration::from_millis(1500);
static QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);
static QUIT_READY: AtomicBool = AtomicBool::new(false);

/// Quits after the page has saved. The page's own unload save is fire and
/// forget and is lost when the process exits first, so a quit while playing
/// used to drop up to 30 seconds of position.
pub fn request_quit(app: &AppHandle) {
    if QUIT_REQUESTED.swap(true, Ordering::SeqCst) {
        return;
    }
    QUITTING.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(auth_popup::MAIN_WINDOW_LABEL) {
        window_state::persist(&window.as_ref().window());
        // Quitting looks immediate while the page saves in the background.
        let _ = window.hide();
    }
    let asked = app
        .emit_to(auth_popup::MAIN_WINDOW_LABEL, BEFORE_QUIT_EVENT, ())
        .is_ok();
    let handle = app.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + QUIT_SAVE_TIMEOUT;
        while asked && !QUIT_READY.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        handle.exit(0);
    });
}

/// The page saved and Arlet may exit now.
#[tauri::command]
pub fn quit_ready() {
    QUIT_READY.store(true, Ordering::SeqCst);
}

fn quit(app: &AppHandle) {
    request_quit(app);
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

/// Tooltip for the current song. Cut to the Windows limit on a character
/// boundary, so a long title never reaches the OS overlong.
pub fn now_playing_tooltip(title: &str, artist: &str) -> String {
    let title = title.trim();
    let artist = artist.trim();
    let text = if title.is_empty() {
        APP_NAME.to_string()
    } else if artist.is_empty() {
        title.to_string()
    } else {
        format!("{title} — {artist}")
    };
    truncate_utf16(&text, TOOLTIP_MAX_UNITS)
}

/// Keeps the longest prefix of `text` that fits in `max_units` UTF-16 units.
fn truncate_utf16(text: &str, max_units: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > max_units {
            break;
        }
        end = index + ch.len_utf8();
    }
    text[..end].to_string()
}

fn current_tooltip() -> String {
    TOOLTIP
        .lock()
        .ok()
        .map(|text| text.clone())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| APP_NAME.to_string())
}

/// Shows the current song in the tray tooltip. Does nothing without a tray.
pub fn set_now_playing(app: &AppHandle, title: &str, artist: &str) {
    set_tooltip(app, now_playing_tooltip(title, artist));
}

/// Restores the plain app name once playback is cleared.
pub fn clear_now_playing(app: &AppHandle) {
    set_tooltip(app, APP_NAME.to_string());
}

fn set_tooltip(app: &AppHandle, text: String) {
    if let Ok(mut last) = TOOLTIP.lock() {
        *last = text.clone();
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(tray) = handle.tray_by_id(TRAY_ID) {
            if let Err(error) = tray.set_tooltip(Some(text)) {
                eprintln!("Unable to update the tray tooltip: {error}");
            }
        }
    });
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
        .tooltip(current_tooltip())
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
