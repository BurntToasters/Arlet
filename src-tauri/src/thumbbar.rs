//! Taskbar thumbnail toolbar with Previous, Play/Pause, and Next buttons.
//!
//! The main window is subclassed to receive the `TaskbarButtonCreated`
//! message and button clicks. Glyphs are drawn at runtime, so no icon files
//! ship with the app. Non-Windows builds do nothing.

use tauri::{AppHandle, WebviewWindow};

/// Installs the toolbar on the main window. Called once from setup.
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

/// Sets the button state and the play/pause glyph.
pub fn update(
    app: &AppHandle,
    playing: bool,
    previous_enabled: bool,
    play_pause_enabled: bool,
    next_enabled: bool,
) {
    #[cfg(windows)]
    {
        let _ = app.run_on_main_thread(move || {
            platform::set_state(playing, previous_enabled, play_pause_enabled, next_enabled);
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (
            app,
            playing,
            previous_enabled,
            play_pause_enabled,
            next_enabled,
        );
    }
}

/// Removes the subclass and icons when the main window is destroyed.
pub fn remove() {
    #[cfg(windows)]
    platform::remove();
}

#[cfg(windows)]
mod platform {
    use crate::{auth_popup, tray, windows_media};
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicU32, Ordering};
    use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
    use windows::core::w;
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        CreateBitmap, CreateCompatibleDC, CreateDIBSection, CreateSolidBrush, DeleteDC,
        DeleteObject, GetStockObject, Polygon, Rectangle, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, NULL_PEN,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::{
        DefSubclassProc, ITaskbarList3, RemoveWindowSubclass, SetWindowSubclass, TaskbarList,
        THBF_DISABLED, THBF_ENABLED, THBN_CLICKED, THB_FLAGS, THB_ICON, THB_TOOLTIP, THUMBBUTTON,
        THUMBBUTTONFLAGS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateIconIndirect, DestroyIcon, GetSystemMetrics, RegisterWindowMessageW, HICON, ICONINFO,
        SM_CXSMICON, WM_COMMAND,
    };

    /// Identifies this subclass on the main window.
    const SUBCLASS_ID: usize = 0x4152_4c54;
    const BUTTON_PREVIOUS: u32 = 1;
    const BUTTON_PLAY_PAUSE: u32 = 2;
    const BUTTON_NEXT: u32 = 3;
    /// Registered message Explorer sends when it creates the taskbar button.
    static TASKBAR_BUTTON_CREATED: AtomicU32 = AtomicU32::new(0);

    /// Icon handles stored as `isize` so the state stays plain data.
    #[derive(Clone, Copy)]
    struct Icons {
        previous: isize,
        play: isize,
        pause: isize,
        next: isize,
    }

    struct State {
        app: AppHandle,
        hwnd: isize,
        icons: Icons,
        taskbar: Option<ITaskbarList3>,
        buttons_added: bool,
        playing: bool,
        previous_enabled: bool,
        play_pause_enabled: bool,
        next_enabled: bool,
    }

    // The state is used on the UI thread only, so COM objects need no locking.
    thread_local! {
        static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    }

    /// Runs `action` on the state when it is installed and not borrowed.
    /// A borrow conflict is skipped rather than panicking in the window proc.
    fn with_state<R>(action: impl FnOnce(&mut State) -> R) -> Option<R> {
        STATE
            .try_with(|cell| {
                let mut guard = cell.try_borrow_mut().ok()?;
                guard.as_mut().map(action)
            })
            .ok()
            .flatten()
    }

    pub fn install(window: &WebviewWindow) -> Result<(), String> {
        if with_state(|_| ()).is_some() {
            return Ok(());
        }
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        // SAFETY: the argument is a static wide string literal.
        let message = unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) };
        TASKBAR_BUTTON_CREATED.store(message, Ordering::SeqCst);
        // SAFETY: a metric query takes no pointers.
        let size = unsafe { GetSystemMetrics(SM_CXSMICON) };
        let icons = create_icons(size)?;
        STATE.with(|cell| {
            *cell.borrow_mut() = Some(State {
                app: window.app_handle().clone(),
                hwnd: hwnd.0 as isize,
                icons,
                taskbar: None,
                buttons_added: false,
                playing: false,
                previous_enabled: false,
                play_pause_enabled: false,
                next_enabled: false,
            })
        });
        // SAFETY: setup runs on the UI thread that owns `hwnd`, and the proc matches the
        // subclass signature.
        let attached = unsafe { SetWindowSubclass(hwnd, Some(thumbbar_proc), SUBCLASS_ID, 0) };
        if !attached.as_bool() {
            remove();
            return Err("Unable to subclass the main window for the taskbar toolbar".to_string());
        }
        // Fails until Explorer has created the button; the message covers that case.
        // SAFETY: called on the UI thread that owns `hwnd`.
        let _ = unsafe { sync_buttons(hwnd) };
        Ok(())
    }

    pub fn remove() {
        let state = STATE
            .try_with(|cell| {
                cell.try_borrow_mut()
                    .ok()
                    .and_then(|mut guard| guard.take())
            })
            .ok()
            .flatten();
        let Some(state) = state else {
            return;
        };
        // SAFETY: the subclass was installed on this HWND from the UI thread. Removing it after
        // the window is gone fails harmlessly.
        unsafe {
            let _ = RemoveWindowSubclass(
                HWND(state.hwnd as *mut c_void),
                Some(thumbbar_proc),
                SUBCLASS_ID,
            );
        }
        destroy_icons(&[
            state.icons.previous,
            state.icons.play,
            state.icons.pause,
            state.icons.next,
        ]);
    }

    /// Stores the new state and pushes it to the taskbar once buttons exist.
    pub fn set_state(
        playing: bool,
        previous_enabled: bool,
        play_pause_enabled: bool,
        next_enabled: bool,
    ) {
        let snapshot = with_state(|state| {
            state.playing = playing;
            state.previous_enabled = previous_enabled;
            state.play_pause_enabled = play_pause_enabled;
            state.next_enabled = next_enabled;
            if !state.buttons_added {
                return None;
            }
            let taskbar = state.taskbar.clone()?;
            Some((taskbar, state.hwnd, button_set(state)))
        })
        .flatten();
        let Some((taskbar, hwnd, buttons)) = snapshot else {
            return;
        };
        // SAFETY: called on the UI thread, and `hwnd` is the live main window the buttons
        // were added to.
        if let Err(error) =
            unsafe { taskbar.ThumbBarUpdateButtons(HWND(hwnd as *mut c_void), &buttons) }
        {
            eprintln!("Unable to update taskbar thumbnail buttons: {error}");
        }
    }

    /// Adds the buttons, or updates them after the first add. The taskbar
    /// interface is created on each call so a restarted Explorer is used.
    ///
    /// SAFETY: must run on the UI thread that owns `hwnd`.
    unsafe fn sync_buttons(hwnd: HWND) -> Result<(), String> {
        // SAFETY: COM is initialized on the UI thread, and the class id is a static constant.
        let taskbar: ITaskbarList3 = unsafe {
            CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| format!("Unable to create the taskbar list: {error}"))?
        };
        // SAFETY: the taskbar object was just created on this thread.
        unsafe { taskbar.HrInit() }
            .map_err(|error| format!("Unable to initialize the taskbar list: {error}"))?;
        let (already_added, buttons) = with_state(|state| (state.buttons_added, button_set(state)))
            .ok_or_else(|| "Taskbar toolbar is not installed".to_string())?;
        // SAFETY: `hwnd` is owned by this thread, and `buttons` lives for the calls.
        let result = unsafe {
            if already_added {
                taskbar
                    .ThumbBarUpdateButtons(hwnd, &buttons)
                    .or_else(|_| taskbar.ThumbBarAddButtons(hwnd, &buttons))
            } else {
                taskbar.ThumbBarAddButtons(hwnd, &buttons)
            }
        };
        result.map_err(|error| format!("Unable to add taskbar thumbnail buttons: {error}"))?;
        with_state(|state| {
            state.taskbar = Some(taskbar);
            state.buttons_added = true;
        });
        Ok(())
    }

    /// Window proc for the subclass. Windows calls it on the UI thread.
    unsafe extern "system" fn thumbbar_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass_id: usize,
        _ref_data: usize,
    ) -> LRESULT {
        let created = TASKBAR_BUTTON_CREATED.load(Ordering::SeqCst);
        if message != 0 && message == created {
            // SAFETY: the proc runs on the UI thread that owns `hwnd`.
            if let Err(error) = unsafe { sync_buttons(hwnd) } {
                eprintln!("{error}");
            }
        } else if message == WM_COMMAND && ((wparam.0 >> 16) & 0xFFFF) as u32 == THBN_CLICKED {
            click_button((wparam.0 & 0xFFFF) as u32);
            return LRESULT(0);
        }
        // SAFETY: forwards the unhandled message to the rest of the subclass chain.
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }

    /// Sends the same SMTC control the tray items send to the page.
    fn click_button(id: u32) {
        let control = match id {
            BUTTON_PREVIOUS => "previous",
            BUTTON_NEXT => "next",
            BUTTON_PLAY_PAUSE => tray::play_pause_control(windows_media::is_playing()),
            _ => return,
        };
        if let Some(app) = with_state(|state| state.app.clone()) {
            let _ = app.emit_to(
                auth_popup::MAIN_WINDOW_LABEL,
                "windows-media-control",
                control,
            );
        }
    }

    fn button_set(state: &State) -> [THUMBBUTTON; 3] {
        let (play_icon, play_tip) = if state.playing {
            (state.icons.pause, "Pause")
        } else {
            (state.icons.play, "Play")
        };
        [
            button(
                BUTTON_PREVIOUS,
                state.icons.previous,
                "Previous",
                state.previous_enabled,
            ),
            button(
                BUTTON_PLAY_PAUSE,
                play_icon,
                play_tip,
                state.play_pause_enabled,
            ),
            button(BUTTON_NEXT, state.icons.next, "Next", state.next_enabled),
        ]
    }

    fn button(id: u32, icon: isize, tip: &str, enabled: bool) -> THUMBBUTTON {
        let flags = if enabled { THBF_ENABLED } else { THBF_DISABLED };
        let mut tip_units = [0u16; 260];
        // The last slot stays zero as the terminating NUL.
        for (slot, unit) in tip_units.iter_mut().take(259).zip(tip.encode_utf16()) {
            *slot = unit;
        }
        THUMBBUTTON {
            dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
            iId: id,
            hIcon: HICON(icon as *mut c_void),
            szTip: tip_units,
            dwFlags: THUMBBUTTONFLAGS(flags.0),
            ..Default::default()
        }
    }

    fn create_icons(size: i32) -> Result<Icons, String> {
        let glyphs: [fn(HDC, i32); 4] = [draw_previous, draw_play, draw_pause, draw_next];
        let mut created = [0isize; 4];
        for (index, glyph) in glyphs.into_iter().enumerate() {
            match create_icon(size, glyph) {
                Ok(icon) => created[index] = icon.0 as isize,
                Err(error) => {
                    destroy_icons(&created);
                    return Err(error);
                }
            }
        }
        Ok(Icons {
            previous: created[0],
            play: created[1],
            pause: created[2],
            next: created[3],
        })
    }

    /// Destroys the non-zero handles in `icons`.
    fn destroy_icons(icons: &[isize]) {
        for icon in icons.iter().copied().filter(|icon| *icon != 0) {
            // SAFETY: each handle came from CreateIconIndirect and is destroyed once.
            unsafe {
                let _ = DestroyIcon(HICON(icon as *mut c_void));
            }
        }
    }

    /// Builds a square icon from a white glyph, with its coverage as alpha.
    fn create_icon(size: i32, draw: fn(HDC, i32)) -> Result<HICON, String> {
        let color = create_color_bitmap(size, draw)?;
        // A 32-bit icon takes its transparency from alpha, so the mask stays clear.
        let mask_bits = vec![0u8; (size * 4) as usize];
        // SAFETY: `mask_bits` holds word-aligned monochrome rows for sizes up to 32.
        let mask = unsafe { CreateBitmap(size, size, 1, 1, Some(mask_bits.as_ptr().cast())) };
        if mask.0.is_null() {
            // SAFETY: `color` was created above and is not yet owned by an icon.
            unsafe {
                let _ = DeleteObject(HGDIOBJ(color.0));
            }
            return Err("Unable to create the taskbar icon mask".to_string());
        }
        let info = ICONINFO {
            fIcon: windows::Win32::Foundation::TRUE,
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: mask,
            hbmColor: color,
        };
        // SAFETY: `info` points at valid bitmaps, which CreateIconIndirect copies.
        let icon = unsafe { CreateIconIndirect(&info) };
        // SAFETY: the icon holds its own copies, so the source bitmaps are released here.
        unsafe {
            let _ = DeleteObject(HGDIOBJ(color.0));
            let _ = DeleteObject(HGDIOBJ(mask.0));
        }
        icon.map_err(|error| format!("Unable to create a taskbar icon: {error}"))
    }

    fn create_color_bitmap(size: i32, draw: fn(HDC, i32)) -> Result<HBITMAP, String> {
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: size,
                // Negative height keeps row 0 at the top, matching the glyph coordinates.
                biHeight: -size,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        // SAFETY: a memory DC with no source is valid for drawing.
        let dc = unsafe { CreateCompatibleDC(None) };
        if dc.0.is_null() {
            return Err("Unable to create a drawing context for the taskbar icon".to_string());
        }
        // SAFETY: `info` and `bits` live for the call. The returned bitmap is owned by the caller.
        let bitmap =
            unsafe { CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) };
        let bitmap = match bitmap {
            Ok(bitmap) if !bits.is_null() => bitmap,
            _ => {
                // SAFETY: `dc` was created above and nothing is selected into it.
                unsafe {
                    let _ = DeleteDC(dc);
                }
                return Err("Unable to create the taskbar icon bitmap".to_string());
            }
        };
        // SAFETY: `bits` points at size * size 32-bit pixels owned by `bitmap`. No slice borrows
        // them while GDI draws, and the DC is released before the pixels are read.
        unsafe {
            std::ptr::write_bytes(bits.cast::<u8>(), 0, (size * size * 4) as usize);
            let previous = SelectObject(dc, HGDIOBJ(bitmap.0));
            draw(dc, size);
            SelectObject(dc, previous);
            let _ = DeleteDC(dc);
        }
        // SAFETY: GDI has finished drawing, so the pixels are only read and rewritten here.
        let pixels =
            unsafe { std::slice::from_raw_parts_mut(bits.cast::<u32>(), (size * size) as usize) };
        for pixel in pixels {
            // GDI leaves alpha at zero, so the brightest channel is the glyph coverage.
            let coverage = (*pixel & 0xFF)
                .max((*pixel >> 8) & 0xFF)
                .max((*pixel >> 16) & 0xFF);
            // Premultiplied white: every channel and alpha carry the same coverage.
            *pixel = coverage * 0x0101_0101;
        }
        Ok(bitmap)
    }

    /// Glyph shapes on a 16-unit grid, scaled to the icon size.
    enum Shape {
        Rect(i32, i32, i32, i32),
        Triangle([(i32, i32); 3]),
    }

    fn scale(value: i32, size: i32) -> i32 {
        value * size / 16
    }

    /// Paints the shapes in white with no outline.
    fn paint(dc: HDC, size: i32, shapes: &[Shape]) {
        // SAFETY: the brush is selected only while `dc` is live. The previous objects are
        // restored before the brush is deleted.
        unsafe {
            let brush = CreateSolidBrush(COLORREF(0x00FF_FFFF));
            let previous_brush = SelectObject(dc, HGDIOBJ(brush.0));
            let previous_pen = SelectObject(dc, GetStockObject(NULL_PEN));
            for shape in shapes {
                match shape {
                    Shape::Rect(left, top, right, bottom) => {
                        let _ = Rectangle(
                            dc,
                            scale(*left, size),
                            scale(*top, size),
                            scale(*right, size),
                            scale(*bottom, size),
                        );
                    }
                    Shape::Triangle(points) => {
                        let points = points.map(|(x, y)| POINT {
                            x: scale(x, size),
                            y: scale(y, size),
                        });
                        let _ = Polygon(dc, &points);
                    }
                }
            }
            SelectObject(dc, previous_pen);
            SelectObject(dc, previous_brush);
            let _ = DeleteObject(HGDIOBJ(brush.0));
        }
    }

    fn draw_previous(dc: HDC, size: i32) {
        paint(
            dc,
            size,
            &[
                Shape::Rect(3, 3, 5, 13),
                Shape::Triangle([(13, 3), (13, 13), (6, 8)]),
            ],
        );
    }

    fn draw_play(dc: HDC, size: i32) {
        paint(dc, size, &[Shape::Triangle([(4, 3), (4, 13), (13, 8)])]);
    }

    fn draw_pause(dc: HDC, size: i32) {
        paint(
            dc,
            size,
            &[Shape::Rect(4, 3, 7, 13), Shape::Rect(9, 3, 12, 13)],
        );
    }

    fn draw_next(dc: HDC, size: i32) {
        paint(
            dc,
            size,
            &[
                Shape::Triangle([(3, 3), (3, 13), (10, 8)]),
                Shape::Rect(11, 3, 13, 13),
            ],
        );
    }
}
