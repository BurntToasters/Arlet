//! Background launch for end-to-end runs. With `ARLET_E2E_BACKGROUND=1` the
//! main window never becomes the active window and stays behind every other
//! window, so a test run neither takes the keyboard nor covers a full-screen
//! game or app. Tests drive the page through DevTools, which needs no OS focus.

use tauri::WebviewWindow;

const BACKGROUND_ENV: &str = "ARLET_E2E_BACKGROUND";

/// True when the E2E runner asked for a background launch.
pub fn enabled() -> bool {
    std::env::var(BACKGROUND_ENV).is_ok_and(|value| value == "1")
}

/// Strips activation from the main window's position changes. Call before
/// the first show.
pub fn install(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        platform::install(window)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(())
    }
}

/// Moves the window behind the other windows without activating it.
pub fn send_to_back(window: &WebviewWindow) {
    #[cfg(windows)]
    platform::send_to_back(window);
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
mod platform {
    use tauri::WebviewWindow;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_BOTTOM, MA_NOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_NOZORDER, WINDOWPOS, WM_MOUSEACTIVATE, WM_WINDOWPOSCHANGING,
    };

    /// Identifies this subclass on the main window.
    const SUBCLASS_ID: usize = 0x4152_4c42;

    /// The window is built not focusable (WS_EX_NOACTIVATE, kept by tao).
    /// This subclass also strips activation from every position change and
    /// keeps the window at the bottom of the z-order.
    pub fn install(window: &WebviewWindow) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        // SAFETY: setup runs on the UI thread that owns `hwnd`, and the proc matches the
        // subclass signature.
        let attached = unsafe { SetWindowSubclass(hwnd, Some(background_proc), SUBCLASS_ID, 0) };
        if attached.as_bool() {
            Ok(())
        } else {
            Err("Unable to subclass the main window for a background launch".to_string())
        }
    }

    pub fn send_to_back(window: &WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else { return };
        // SAFETY: called on the UI thread that owns `hwnd`; no pointers are passed.
        let _ = unsafe {
            SetWindowPos(
                hwnd,
                Some(HWND_BOTTOM),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
        };
    }

    /// Show, maximize, full screen, and always-on-top all pass through
    /// WM_WINDOWPOSCHANGING, so rewriting it there covers every path. Even an
    /// inactive window placed on top would knock a game out of full screen,
    /// so each change also goes to the bottom (which drops always-on-top).
    unsafe extern "system" fn background_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        match message {
            WM_WINDOWPOSCHANGING => {
                let pos = lparam.0 as *mut WINDOWPOS;
                if !pos.is_null() {
                    // SAFETY: for this message `lparam` points at the WINDOWPOS the system
                    // is about to apply, valid for the duration of the call.
                    unsafe {
                        (*pos).flags |= SWP_NOACTIVATE;
                        (*pos).flags &= !SWP_NOZORDER;
                        (*pos).hwndInsertAfter = HWND_BOTTOM;
                    }
                }
            }
            WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
            _ => {}
        }
        // SAFETY: forwards the original arguments to the next proc in the chain.
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }
}
