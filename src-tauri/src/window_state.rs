//! Remembers the main window's size, position, and maximized state across
//! launches. `reset_settings` deletes the file and blocks further writes, so a
//! reset starts from the default window.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const FILE_NAME: &str = "window-state.json";
const MAX_FILE_BYTES: u64 = 4 * 1024;
/// Matches `minWidth`/`minHeight` in tauri.conf.json (logical px at 100%).
const MIN_WIDTH: u32 = 500;
const MIN_HEIGHT: u32 = 480;
/// At least this much of the window must land on a monitor to be reachable.
const MIN_VISIBLE: i32 = 120;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// Latest known geometry, written once when the main window closes.
#[derive(Default)]
pub struct WindowStateCache(pub Mutex<Option<WindowState>>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

fn overlap(a: i32, a_len: u32, b: i32, b_len: u32) -> i64 {
    let start = i64::from(a.max(b));
    let end = (i64::from(a) + i64::from(a_len)).min(i64::from(b) + i64::from(b_len));
    (end - start).max(0)
}

/// Returns the state to apply, or `None` when it would be off-screen or
/// unusable. Sizes are clamped between the minimum and the monitor.
pub fn usable_state(state: WindowState, monitors: &[Rect]) -> Option<WindowState> {
    if state.width == 0 || state.height == 0 {
        return None;
    }
    // Clamp first: a tiny saved size is still a usable position once it is
    // grown to the minimum.
    monitors.iter().find_map(|monitor| {
        let clamped = WindowState {
            width: state.width.clamp(MIN_WIDTH, monitor.width.max(MIN_WIDTH)),
            height: state
                .height
                .clamp(MIN_HEIGHT, monitor.height.max(MIN_HEIGHT)),
            ..state
        };
        let visible = overlap(clamped.x, clamped.width, monitor.x, monitor.width)
            >= i64::from(MIN_VISIBLE)
            && overlap(clamped.y, clamped.height, monitor.y, monitor.height)
                >= i64::from(MIN_VISIBLE);
        visible.then_some(clamped)
    })
}

pub fn parse_state(text: &str) -> Option<WindowState> {
    serde_json::from_str(text).ok()
}

fn state_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(FILE_NAME))
}

/// Deletes the saved geometry (settings reset).
pub fn remove_saved_state(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(path) = state_path(app) {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn monitor_rects(window: &WebviewWindow) -> Vec<Rect> {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            Rect {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
            }
        })
        .collect()
}

/// Applies the saved geometry to the still-hidden main window.
pub fn restore(window: &WebviewWindow) {
    let app = window.app_handle();
    let Some(path) = state_path(app) else { return };
    let Ok(metadata) = std::fs::metadata(&path) else {
        return;
    };
    if metadata.len() > MAX_FILE_BYTES {
        return;
    }
    let Some(saved) = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| parse_state(&text))
    else {
        return;
    };
    let Some(state) = usable_state(saved, &monitor_rects(window)) else {
        return;
    };
    let _ = window.set_size(PhysicalSize::new(state.width, state.height));
    let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
    if state.maximized {
        let _ = window.maximize();
    }
    if let Some(cache) = app.try_state::<WindowStateCache>() {
        if let Ok(mut current) = cache.0.lock() {
            *current = Some(state);
        }
    }
}

/// Records the window's geometry after a move or resize. Minimized windows
/// report off-screen coordinates and are skipped; while maximized only the
/// flag changes, so un-maximizing later returns to the last normal size.
pub fn record(window: &tauri::Window) {
    if window.is_minimized().unwrap_or(true) {
        return;
    }
    let Some(cache) = window.app_handle().try_state::<WindowStateCache>() else {
        return;
    };
    let Ok(mut current) = cache.0.lock() else {
        return;
    };
    let maximized = window.is_maximized().unwrap_or(false);
    if maximized {
        if let Some(state) = current.as_mut() {
            state.maximized = true;
        }
        return;
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    *current = Some(WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: false,
    });
}

/// Writes the last recorded geometry when the main window closes, unless a
/// settings reset is pending.
pub fn persist(window: &tauri::Window) {
    if crate::settings::reset_pending() {
        return;
    }
    let app = window.app_handle();
    let Some(state) = app
        .try_state::<WindowStateCache>()
        .and_then(|cache| cache.0.lock().ok().and_then(|current| *current))
    else {
        return;
    };
    let (Some(path), Ok(json)) = (state_path(app), serde_json::to_string(&state)) else {
        return;
    };
    if let Err(error) = crate::settings::atomic_write_text(&path, &json) {
        eprintln!("Unable to save window state: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };

    fn state(x: i32, y: i32, width: u32, height: u32) -> WindowState {
        WindowState {
            x,
            y,
            width,
            height,
            maximized: false,
        }
    }

    // Failure modes: a window restored onto a disconnected monitor (or the
    // -32000 minimized coordinates) is unreachable; a tiny or giant saved
    // size breaks the layout; a corrupt file must fall back to the default.
    #[test]
    fn off_screen_positions_fall_back_to_default() {
        assert_eq!(
            usable_state(state(-32000, -32000, 1000, 700), &[MONITOR]),
            None
        );
        assert_eq!(usable_state(state(3000, 100, 1000, 700), &[MONITOR]), None);
        assert_eq!(usable_state(state(1850, 100, 1000, 700), &[MONITOR]), None);
        assert_eq!(usable_state(state(100, 100, 1000, 700), &[]), None);
    }

    #[test]
    fn on_screen_positions_are_kept_and_sizes_clamped() {
        assert_eq!(
            usable_state(state(100, 50, 1200, 800), &[MONITOR]),
            Some(state(100, 50, 1200, 800))
        );
        assert_eq!(
            usable_state(state(100, 50, 200, 100), &[MONITOR]),
            Some(state(100, 50, MIN_WIDTH, MIN_HEIGHT))
        );
        assert_eq!(
            usable_state(state(0, 0, 9000, 9000), &[MONITOR]),
            Some(state(0, 0, 1920, 1040))
        );
        let second = Rect {
            x: 1920,
            y: 0,
            width: 2560,
            height: 1400,
        };
        assert_eq!(
            usable_state(state(2200, 200, 1400, 900), &[MONITOR, second]),
            Some(state(2200, 200, 1400, 900))
        );
    }

    #[test]
    fn corrupt_state_files_are_ignored() {
        assert_eq!(parse_state("not json"), None);
        assert_eq!(parse_state(r#"{"x":1}"#), None);
        assert_eq!(
            parse_state(r#"{"x":1,"y":2,"width":800,"height":600,"maximized":true}"#),
            Some(WindowState {
                x: 1,
                y: 2,
                width: 800,
                height: 600,
                maximized: true
            })
        );
    }
}
