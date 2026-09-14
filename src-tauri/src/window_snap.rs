//! Windows 11 Snap Layout support for Arlet's frameless titlebar.
//!
//! WebView2 owns the client-area hit test, so an HTML maximize button cannot
//! report `HTMAXBUTTON` to Windows. Arlet uses a tiny transparent native child
//! window over the button instead. The child reports the maximize hit-test,
//! toggles maximize on release, and forwards hover state to the renderer.
//!
//! The overlay is intentionally implemented here rather than copied from
//! another application: only the behavior and Win32 contract are shared.
//! Non-Windows builds validate the command and otherwise perform no native
//! work.

const MAX_COORDINATE: i32 = 1_000_000;
const MAX_DIMENSION: i32 = 16_384;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SnapOverlayBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

/// Validate renderer geometry before it reaches Win32. Zero-area rectangles
/// are a supported hide operation; negative dimensions and absurd positions
/// are rejected so an untrusted renderer cannot request pathological native
/// window sizes.
fn validate_bounds(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<Option<SnapOverlayBounds>, String> {
    if width < 0 || height < 0 {
        return Err("snap overlay dimensions cannot be negative".to_string());
    }
    if width == 0 || height == 0 {
        return Ok(None);
    }
    if !(-MAX_COORDINATE..=MAX_COORDINATE).contains(&x)
        || !(-MAX_COORDINATE..=MAX_COORDINATE).contains(&y)
    {
        return Err("snap overlay coordinates are outside the supported range".to_string());
    }
    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err("snap overlay dimensions are outside the supported range".to_string());
    }
    let right = i64::from(x) + i64::from(width);
    let bottom = i64::from(y) + i64::from(height);
    if !(-i64::from(MAX_COORDINATE)..=i64::from(MAX_COORDINATE)).contains(&right)
        || !(-i64::from(MAX_COORDINATE)..=i64::from(MAX_COORDINATE)).contains(&bottom)
    {
        return Err("snap overlay rectangle is outside the supported range".to_string());
    }

    Ok(Some(SnapOverlayBounds {
        x,
        y,
        width,
        height,
    }))
}

/// Position (or hide) the maximize-button overlay for the calling window.
/// Coordinates are physical pixels in the window client space, as reported by
/// the renderer after applying its device-pixel ratio.
#[tauri::command]
pub async fn set_snap_overlay_bounds(
    window: tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    let bounds = validate_bounds(x, y, width, height)?;

    #[cfg(target_os = "windows")]
    {
        win::set_bounds(&window, bounds).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&window, bounds);
        Ok(())
    }
}

/// Drop overlay bookkeeping when a Tauri window is destroyed. The child HWND
/// is parent-owned and normally dies with it; explicit destruction also makes
/// the cleanup deterministic if the event arrives first.
pub fn on_window_destroyed(window: &tauri::Window) {
    #[cfg(target_os = "windows")]
    win::remove(window);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
    }
}

#[cfg(target_os = "windows")]
mod win {
    use super::SnapOverlayBounds;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::{Mutex, OnceLock};

    use tauri::{Emitter, WebviewWindow, Window};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{
        GetLastError, ERROR_CLASS_ALREADY_EXISTS, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Controls::WM_MOUSELEAVE;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, GetParent, GetWindowLongPtrW, IsWindow,
        RegisterClassExW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWLP_USERDATA, HMENU,
        HTMAXBUTTON, HWND_TOP, SWP_NOACTIVATE, SW_HIDE, SW_SHOW, WM_LBUTTONDOWN, WM_LBUTTONUP,
        WM_MOUSEMOVE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP,
        WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS, WS_EX_NOACTIVATE,
        WS_EX_TRANSPARENT,
    };

    const CLASS_NAME: PCWSTR = w!("ArletSnapMaximizeOverlay");

    struct Overlay {
        hwnd: isize,
        window: WebviewWindow,
        hovered: bool,
    }

    fn overlays() -> &'static Mutex<HashMap<isize, Overlay>> {
        static OVERLAYS: OnceLock<Mutex<HashMap<isize, Overlay>>> = OnceLock::new();
        OVERLAYS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn parent_hwnd<W: HasWindowHandle>(window: &W) -> Option<isize> {
        match window.window_handle().ok()?.as_raw() {
            RawWindowHandle::Win32(handle) => Some(handle.hwnd.get()),
            _ => None,
        }
    }

    pub async fn set_bounds(
        window: &WebviewWindow,
        bounds: Option<SnapOverlayBounds>,
    ) -> Result<(), String> {
        let parent = parent_hwnd(window)
            .ok_or_else(|| "main window does not expose a Win32 handle".to_string())?;
        let owned = window.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();

        // Tauri commands can run off the UI thread; all HWND operations and
        // class registration must occur on the window's owning thread. The
        // oneshot is important: run_on_main_thread queues the closure and
        // returns before it executes, so returning here without awaiting it
        // would hide native failures from the renderer.
        window
            .run_on_main_thread(move || unsafe {
                let result = apply_bounds(parent, bounds, owned);
                if let Err(error) = &result {
                    let message = format!("snap overlay native operation failed: {error}");
                    eprintln!("{message}");
                }
                let _ = sender.send(result);
            })
            .map_err(|error| format!("could not schedule snap overlay operation: {error}"))?;

        receiver
            .await
            .map_err(|_| "snap overlay main-thread operation did not complete".to_string())?
    }

    pub fn remove(window: &Window) {
        let Some(parent) = parent_hwnd(window) else {
            return;
        };
        let overlay = overlays()
            .lock()
            .ok()
            .and_then(|mut entries| entries.remove(&parent));
        if let Some(overlay) = overlay {
            // A Destroyed notification runs on Tauri's main thread. If the
            // parent has already gone away this simply fails harmlessly.
            let hwnd = HWND(overlay.hwnd as *mut c_void);
            unsafe {
                if is_exact_child(hwnd, parent) {
                    let _ = DestroyWindow(hwnd);
                }
            }
        }
    }

    fn overlay_for(parent: isize) -> Option<HWND> {
        let mut entries = overlays().lock().ok()?;
        let hwnd = entries
            .get(&parent)
            .map(|entry| HWND(entry.hwnd as *mut c_void))?;
        if unsafe { is_exact_child(hwnd, parent) } {
            Some(hwnd)
        } else {
            // A destroyed HWND may be recycled by Windows. Do not leave a
            // stale reusable handle under this parent key.
            entries.remove(&parent);
            None
        }
    }

    /// SAFETY: called on the owner thread, with a live parent HWND.
    unsafe fn apply_bounds(
        parent: isize,
        bounds: Option<SnapOverlayBounds>,
        window: WebviewWindow,
    ) -> Result<(), String> {
        let parent_hwnd = HWND(parent as *mut c_void);
        if !IsWindow(Some(parent_hwnd)).as_bool() {
            return Err("parent HWND is no longer a valid window".to_string());
        }

        if let Some(bounds) = bounds {
            let existing = overlay_for(parent);
            let created = existing.is_none();
            let overlay = match existing {
                Some(hwnd) => hwnd,
                None => create_overlay(parent)?,
            };
            let setup_result = (|| {
                SetWindowPos(
                    overlay,
                    Some(HWND_TOP),
                    bounds.x,
                    bounds.y,
                    bounds.width,
                    bounds.height,
                    SWP_NOACTIVATE,
                )
                .map_err(|error| format!("SetWindowPos failed: {error}"))?;
                if !is_exact_child(overlay, parent) {
                    return Err(
                        "SetWindowPos completed but overlay is no longer the exact child"
                            .to_string(),
                    );
                }
                // ShowWindow returns the previous visibility state rather
                // than a success flag; IsWindow is the reliable failure
                // signal for this synchronous native operation.
                let _ = ShowWindow(overlay, SW_SHOW);
                if !IsWindow(Some(overlay)).as_bool() {
                    return Err("ShowWindow(SW_SHOW) invalidated the overlay HWND".to_string());
                }
                Ok(())
            })();
            if let Err(error) = setup_result {
                if created {
                    let _ = DestroyWindow(overlay);
                }
                return Err(error);
            }
            if created {
                install_overlay(parent, overlay, window)?;
            }
        } else if let Some(overlay) = overlay_for(parent) {
            emit_hover(overlay, false);
            // See the SW_SHOW path above: ShowWindow's BOOL is not an error
            // result, so validate that the HWND remained live after hiding.
            let _ = ShowWindow(overlay, SW_HIDE);
            if !IsWindow(Some(overlay)).as_bool() {
                return Err("ShowWindow(SW_HIDE) invalidated the overlay HWND".to_string());
            }
        }
        Ok(())
    }

    /// SAFETY: called on the owner thread, with a live parent HWND.
    unsafe fn create_overlay(parent: isize) -> Result<HWND, String> {
        ensure_class()?;
        let instance = HINSTANCE(
            GetModuleHandleW(PCWSTR::null())
                .map_err(|error| format!("GetModuleHandleW failed: {error}"))?
                .0,
        );
        let overlay = CreateWindowExW(
            WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
            CLASS_NAME,
            PCWSTR::null(),
            WS_CHILD | WS_CLIPSIBLINGS,
            0,
            0,
            0,
            0,
            Some(HWND(parent as *mut c_void)),
            Some(HMENU::default()),
            Some(instance),
            None,
        )
        .map_err(|error| format!("CreateWindowExW failed: {error}"))?;

        if !is_child_window(overlay, parent) {
            let _ = DestroyWindow(overlay);
            return Err("CreateWindowExW returned a non-child overlay HWND".to_string());
        }

        SetWindowLongPtrW(overlay, GWLP_USERDATA, parent as _);
        if !is_exact_child(overlay, parent) {
            let _ = DestroyWindow(overlay);
            return Err("SetWindowLongPtrW did not retain the parent HWND".to_string());
        }

        Ok(overlay)
    }

    fn install_overlay(parent: isize, overlay: HWND, window: WebviewWindow) -> Result<(), String> {
        let Ok(mut entries) = overlays().lock() else {
            unsafe {
                let _ = DestroyWindow(overlay);
            }
            return Err("snap overlay bookkeeping lock poisoned".to_string());
        };
        entries.insert(
            parent,
            Overlay {
                hwnd: overlay.0 as isize,
                window,
                hovered: false,
            },
        );
        Ok(())
    }

    /// SAFETY: registration is process-global and must run on the UI thread.
    unsafe fn ensure_class() -> Result<(), String> {
        static REGISTERED: OnceLock<Result<(), String>> = OnceLock::new();
        REGISTERED
            .get_or_init(|| {
                let class = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    lpfnWndProc: Some(overlay_proc),
                    hInstance: HINSTANCE(
                        GetModuleHandleW(PCWSTR::null())
                            .map_err(|error| format!("GetModuleHandleW failed: {error}"))?
                            .0,
                    ),
                    lpszClassName: CLASS_NAME,
                    ..Default::default()
                };
                if RegisterClassExW(&class) != 0 {
                    Ok(())
                } else {
                    let error = GetLastError();
                    if error == ERROR_CLASS_ALREADY_EXISTS {
                        Ok(())
                    } else {
                        Err(format!("RegisterClassExW failed: {error:?}"))
                    }
                }
            })
            .clone()
    }

    unsafe fn is_child_window(overlay: HWND, parent: isize) -> bool {
        IsWindow(Some(overlay)).as_bool()
            && GetParent(overlay)
                .map(|actual_parent| actual_parent == HWND(parent as *mut c_void))
                .unwrap_or(false)
    }

    unsafe fn is_exact_child(overlay: HWND, parent: isize) -> bool {
        is_child_window(overlay, parent)
            && GetWindowLongPtrW(overlay, GWLP_USERDATA) as isize == parent
    }

    fn window_for(overlay: HWND) -> Option<WebviewWindow> {
        let parent = unsafe { GetWindowLongPtrW(overlay, GWLP_USERDATA) as isize };
        if !unsafe { is_exact_child(overlay, parent) } {
            return None;
        }
        let entries = overlays().lock().ok()?;
        entries.get(&parent).map(|entry| entry.window.clone())
    }

    fn set_hovered(overlay: HWND, hovered: bool) -> bool {
        let parent = unsafe { GetWindowLongPtrW(overlay, GWLP_USERDATA) as isize };
        if !unsafe { is_exact_child(overlay, parent) } {
            return false;
        }
        let mut entries = match overlays().lock() {
            Ok(entries) => entries,
            Err(_) => return false,
        };
        match entries.get_mut(&parent) {
            Some(entry) if entry.hovered != hovered => {
                entry.hovered = hovered;
                true
            }
            _ => false,
        }
    }

    fn emit_hover(overlay: HWND, hovered: bool) {
        if set_hovered(overlay, hovered) {
            if let Some(window) = window_for(overlay) {
                let _ = window.emit("snap-max-hover", hovered);
            }
        }
    }

    unsafe fn track_mouse(overlay: HWND, non_client: bool) {
        let mut flags = TME_LEAVE;
        if non_client {
            flags |= TME_NONCLIENT;
        }
        let mut track = TRACKMOUSEEVENT {
            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
            dwFlags: flags,
            hwndTrack: overlay,
            dwHoverTime: 0,
        };
        let _ = TrackMouseEvent(&mut track);
    }

    unsafe extern "system" fn overlay_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            // Windows 11 uses this exact caption hit-test to expose Snap
            // Layouts when the pointer rests over the maximize control.
            WM_NCHITTEST => return LRESULT(HTMAXBUTTON as isize),
            WM_NCLBUTTONDOWN | WM_LBUTTONDOWN => return LRESULT(0),
            WM_NCLBUTTONUP | WM_LBUTTONUP => {
                if let Some(window) = window_for(hwnd) {
                    let result = if window.is_maximized().unwrap_or(false) {
                        window.unmaximize()
                    } else {
                        window.maximize()
                    };
                    if let Err(error) = result {
                        eprintln!("snap overlay maximize toggle failed: {error}");
                    }
                }
                return LRESULT(0);
            }
            WM_NCMOUSEMOVE => {
                emit_hover(hwnd, true);
                track_mouse(hwnd, true);
                return LRESULT(0);
            }
            WM_MOUSEMOVE => {
                emit_hover(hwnd, true);
                track_mouse(hwnd, false);
                return LRESULT(0);
            }
            WM_NCMOUSELEAVE | WM_MOUSELEAVE => {
                emit_hover(hwnd, false);
                return LRESULT(0);
            }
            WM_NCDESTROY => {
                let parent = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as isize;
                if let Ok(mut entries) = overlays().lock() {
                    if entries
                        .get(&parent)
                        .is_some_and(|entry| entry.hwnd == hwnd.0 as isize)
                    {
                        entries.remove(&parent);
                    }
                }
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            }
            _ => {}
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_area_bounds_hide_overlay() {
        assert_eq!(validate_bounds(0, 0, 0, 0).unwrap(), None);
        assert_eq!(validate_bounds(10, 20, 0, 30).unwrap(), None);
    }

    #[test]
    fn negative_dimensions_are_rejected() {
        assert!(validate_bounds(0, 0, -1, 10).is_err());
        assert!(validate_bounds(0, 0, 10, -1).is_err());
    }

    #[test]
    fn absurd_bounds_are_rejected() {
        assert!(validate_bounds(MAX_COORDINATE + 1, 0, 10, 10).is_err());
        assert!(validate_bounds(0, 0, MAX_DIMENSION + 1, 10).is_err());
        assert!(validate_bounds(MAX_COORDINATE, 0, 10, 10).is_err());
    }

    #[test]
    fn valid_bounds_are_preserved() {
        let bounds = validate_bounds(-10, 12, 48, 32).unwrap().unwrap();
        assert_eq!(
            bounds,
            SnapOverlayBounds {
                x: -10,
                y: 12,
                width: 48,
                height: 32
            }
        );
    }

    #[test]
    fn command_registration_invariants_are_stable() {
        let raw = include_str!("../capabilities/default.json");
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        let permissions = value["permissions"].as_array().unwrap();
        assert!(permissions
            .iter()
            .any(|permission| { permission == "allow-set-snap-overlay-bounds" }));
        assert!(permissions
            .iter()
            .any(|permission| { permission == "core:window:allow-toggle-maximize" }));
        assert_eq!(value["windows"][0], "main");

        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window = &config["app"]["windows"][0];
        assert_eq!(window["decorations"], false);
        assert_eq!(window["minWidth"], 500);
    }
}
