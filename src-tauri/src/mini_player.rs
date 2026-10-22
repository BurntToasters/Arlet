//! Compact mini player: a size and always-on-top mode of the main window.
//! The same webview keeps running, so MusicKit playback is not interrupted.
//! The mini geometry is never saved; `window_state` keeps the normal size.

use crate::window_state::{self, WindowState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const MINI_WIDTH: f64 = 360.0;
const MINI_HEIGHT: f64 = 132.0;
const MINI_MIN_WIDTH: f64 = 300.0;
const MINI_MIN_HEIGHT: f64 = 120.0;
/// Matches `minWidth`/`minHeight` in tauri.conf.json (logical px).
const NORMAL_MIN_WIDTH: f64 = 500.0;
const NORMAL_MIN_HEIGHT: f64 = 480.0;

static ACTIVE: AtomicBool = AtomicBool::new(false);
/// Normal geometry captured when mini mode starts, restored when it ends.
/// Sync commands run on the main thread, so this lock is never contended.
static SAVED: Mutex<Option<WindowState>> = Mutex::new(None);

pub fn is_active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

fn stringify<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

/// The geometry to return to: the outer position and inner size, or the last
/// normal rectangle when the window is maximized (a maximized rectangle is
/// not the size to restore).
fn capture(window: &WebviewWindow) -> Result<WindowState, String> {
    let maximized = window.is_maximized().map_err(stringify)?;
    if maximized {
        if let Some(normal) = window_state::last_normal(window.app_handle()) {
            return Ok(WindowState {
                maximized: true,
                ..normal
            });
        }
    }
    let position = window.outer_position().map_err(stringify)?;
    let size = window.inner_size().map_err(stringify)?;
    Ok(WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
    })
}

fn apply_mini(window: &WebviewWindow) -> Result<(), String> {
    window
        .set_min_size(Some(LogicalSize::new(MINI_MIN_WIDTH, MINI_MIN_HEIGHT)))
        .map_err(stringify)?;
    window
        .set_size(LogicalSize::new(MINI_WIDTH, MINI_HEIGHT))
        .map_err(stringify)?;
    window.set_always_on_top(true).map_err(stringify)
}

fn apply_normal(window: &WebviewWindow, geometry: WindowState) -> Result<(), String> {
    window.set_always_on_top(false).map_err(stringify)?;
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(stringify)?;
    }
    window
        .set_min_size(Some(LogicalSize::new(NORMAL_MIN_WIDTH, NORMAL_MIN_HEIGHT)))
        .map_err(stringify)?;
    // Position first, as window_state::restore does, so a DPI change on the
    // target monitor does not undo the size.
    window
        .set_position(PhysicalPosition::new(geometry.x, geometry.y))
        .map_err(stringify)?;
    window
        .set_size(PhysicalSize::new(geometry.width, geometry.height))
        .map_err(stringify)?;
    if geometry.maximized {
        window.maximize().map_err(stringify)?;
    }
    Ok(())
}

fn enter(window: &WebviewWindow) -> Result<(), String> {
    let mut saved = SAVED
        .lock()
        .map_err(|_| "Mini player lock poisoned".to_string())?;
    if is_active() {
        return Ok(());
    }
    let geometry = capture(window)?;
    // Flag first: resize and move events from here on must not be recorded.
    ACTIVE.store(true, Ordering::SeqCst);
    let result = (|| -> Result<(), String> {
        if window.is_maximized().map_err(stringify)? {
            window.unmaximize().map_err(stringify)?;
        }
        apply_mini(window)
    })();
    if let Err(error) = result {
        let _ = apply_normal(window, geometry);
        ACTIVE.store(false, Ordering::SeqCst);
        return Err(error);
    }
    *saved = Some(geometry);
    Ok(())
}

fn exit(window: &WebviewWindow) -> Result<(), String> {
    let mut saved = SAVED
        .lock()
        .map_err(|_| "Mini player lock poisoned".to_string())?;
    if !is_active() {
        return Ok(());
    }
    let geometry = saved.take();
    let result = match geometry {
        Some(geometry) => apply_normal(window, geometry),
        None => window
            .set_min_size(Some(LogicalSize::new(NORMAL_MIN_WIDTH, NORMAL_MIN_HEIGHT)))
            .and_then(|_| window.set_always_on_top(false))
            .map_err(stringify),
    };
    // A failed restore leaves the window in mini mode, so the flag tracks
    // what the window actually is.
    if result.is_ok() {
        ACTIVE.store(false, Ordering::SeqCst);
    } else {
        *saved = geometry;
    }
    result
}

/// Enters or leaves mini mode. Enabling twice keeps the first saved geometry.
#[tauri::command]
pub fn set_mini_player(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    if enabled {
        enter(&window)
    } else {
        exit(&window)
    }
}

/// Keeps the mini window above others. Ignored outside mini mode, so a stale
/// pin request cannot change the normal window.
#[tauri::command]
pub fn set_mini_player_on_top(window: WebviewWindow, on_top: bool) -> Result<(), String> {
    if !is_active() {
        return Ok(());
    }
    window.set_always_on_top(on_top).map_err(stringify)
}
