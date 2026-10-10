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
#[cfg(test)]
pub fn usable_state(state: WindowState, monitors: &[Rect]) -> Option<WindowState> {
    let scales = vec![1.0; monitors.len()];
    usable_state_scaled(state, monitors, &scales)
}

/// Like [`usable_state`], with each monitor's scale factor. The minimum size
/// is logical, so it is scaled to the physical pixels the state is saved in.
/// The monitor holding most of the window wins, so a window on a large
/// secondary monitor is not shrunk to fit the primary.
pub fn usable_state_scaled(
    state: WindowState,
    monitors: &[Rect],
    scales: &[f64],
) -> Option<WindowState> {
    if state.width == 0 || state.height == 0 {
        return None;
    }
    // Clamp first: a tiny saved size is still a usable position once it is
    // grown to the minimum.
    monitors
        .iter()
        .zip(scales.iter().copied().chain(std::iter::repeat(1.0)))
        .filter_map(|(monitor, scale)| {
            let scale = if scale.is_finite() && scale > 0.0 {
                scale
            } else {
                1.0
            };
            let min_width = (f64::from(MIN_WIDTH) * scale).round() as u32;
            let min_height = (f64::from(MIN_HEIGHT) * scale).round() as u32;
            let clamped = WindowState {
                width: state.width.clamp(min_width, monitor.width.max(min_width)),
                height: state
                    .height
                    .clamp(min_height, monitor.height.max(min_height)),
                ..state
            };
            let visible_x = overlap(clamped.x, clamped.width, monitor.x, monitor.width);
            let visible_y = overlap(clamped.y, clamped.height, monitor.y, monitor.height);
            let visible =
                visible_x >= i64::from(MIN_VISIBLE) && visible_y >= i64::from(MIN_VISIBLE);
            visible.then_some((visible_x * visible_y, clamped))
        })
        .max_by_key(|(area, _)| *area)
        .map(|(_, clamped)| clamped)
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
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "Window state lock poisoned".to_string())?;
    if let Some(path) = state_path(app) {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn monitor_rects(window: &WebviewWindow) -> (Vec<Rect>, Vec<f64>) {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            (
                Rect {
                    x: area.position.x,
                    y: area.position.y,
                    width: area.size.width,
                    height: area.size.height,
                },
                monitor.scale_factor(),
            )
        })
        .unzip()
}

/// Applies the saved geometry to the still-hidden main window. Call
/// [`settle_after_show`] with the result once the window is shown.
pub fn restore(window: &WebviewWindow) -> Option<WindowState> {
    let app = window.app_handle();
    let path = state_path(app)?;
    if std::fs::metadata(&path).ok()?.len() > MAX_FILE_BYTES {
        return None;
    }
    let saved = parse_state(&std::fs::read_to_string(&path).ok()?)?;
    let (monitors, scales) = monitor_rects(window);
    let state = usable_state_scaled(saved, &monitors, &scales)?;
    // Position first: moving onto a monitor with another DPI rescales the
    // window, which would undo a size set before the move.
    let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
    let _ = window.set_size(PhysicalSize::new(state.width, state.height));
    if let Some(cache) = app.try_state::<WindowStateCache>() {
        if let Ok(mut current) = cache.0.lock() {
            *current = Some(state);
        }
    }
    Some(state)
}

/// Showing the frameless window recomputes its frame, and Windows adds the
/// caption height to a size set while hidden (+30 px per launch otherwise).
/// Re-apply the saved size, then maximize if the window was maximized.
pub fn settle_after_show(window: &WebviewWindow, state: WindowState) {
    let position = PhysicalPosition::new(state.x, state.y);
    if window
        .outer_position()
        .is_ok_and(|current| current != position)
    {
        let _ = window.set_position(position);
    }
    let expected = PhysicalSize::new(state.width, state.height);
    if window.inner_size().is_ok_and(|size| size != expected) {
        let _ = window.set_size(expected);
    }
    if state.maximized {
        let _ = window.maximize();
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
            drop(current);
            schedule_persist(window.app_handle());
            return;
        }
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    // A window maximized before any normal move has no earlier geometry;
    // seed it so the maximized flag is still kept.
    *current = Some(WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
    });
    drop(current);
    schedule_persist(window.app_handle());
}

/// Bumped by each move or resize; a pending save only writes if no newer
/// change arrived during the debounce.
static PERSIST_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const PERSIST_DEBOUNCE: std::time::Duration = std::time::Duration::from_secs(1);

/// Saves shortly after the window settles, so a crash, logoff, or shutdown
/// while hidden in the tray keeps the geometry.
fn schedule_persist(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    let generation = PERSIST_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(PERSIST_DEBOUNCE).await;
        if PERSIST_GENERATION.load(Ordering::SeqCst) == generation {
            persist_app(&app);
        }
    });
}

/// Writes the last recorded geometry when the main window closes, unless a
/// settings reset is pending.
pub fn persist(window: &tauri::Window) {
    persist_app(window.app_handle());
}

/// Serializes the close-time save, debounced saves, and the reset delete.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn persist_app(app: &tauri::AppHandle) {
    let Ok(_guard) = WRITE_LOCK.lock() else {
        return;
    };
    if crate::settings::reset_pending() {
        return;
    }
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
