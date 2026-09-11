//! Windows-native window effects: Mica, Acrylic, opaque fallback.

use tauri::WebviewWindow;

#[cfg(target_os = "windows")]
fn acrylic_tint(dark: bool) -> (u8, u8, u8, u8) {
    if dark {
        (30, 30, 30, 180)
    } else {
        (245, 245, 245, 200)
    }
}

fn paint_opaque_background(window: &WebviewWindow, dark: bool) {
    let color = if dark {
        tauri::window::Color(0x1e, 0x1e, 0x1e, 0xff)
    } else {
        tauri::window::Color(0xf5, 0xf5, 0xf5, 0xff)
    };
    let _ = window.set_background_color(Some(color));
}

#[cfg(target_os = "windows")]
fn paint_transparent_background(window: &WebviewWindow) {
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
}

pub fn apply_mica(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::{apply_acrylic, apply_mica};
        paint_transparent_background(window);
        match apply_mica(window, Some(dark)) {
            Ok(()) => return Ok(()),
            Err(mica_error) => {
                match apply_acrylic(window, Some(acrylic_tint(dark))) {
                    Ok(()) => return Ok(()),
                    Err(acrylic_error) => {
                        paint_opaque_background(window, dark);
                        return Err(format!(
                            "Mica unavailable ({mica_error}); Acrylic failed: {acrylic_error}"
                        ));
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = dark;
        paint_opaque_background(window, dark);
        Ok(())
    }
}

pub fn clear_effects(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::{clear_acrylic, clear_mica};
        let mica = clear_mica(window);
        let acrylic = clear_acrylic(window);
        paint_opaque_background(window, dark);
        if mica.is_ok() || acrylic.is_ok() {
            Ok(())
        } else {
            Err(format!(
                "Could not clear window effects: mica={mica:?}, acrylic={acrylic:?}"
            ))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        paint_opaque_background(window, dark);
        Ok(())
    }
}

#[tauri::command]
pub fn set_window_fx(
    window: WebviewWindow,
    enabled: bool,
    dark: bool,
) -> Result<(), String> {
    if !supports_native_fx() {
        paint_opaque_background(&window, dark);
        let _ = enabled;
        return Ok(());
    }
    if enabled {
        apply_mica(&window, dark)
    } else {
        clear_effects(&window, dark)
    }
}

pub fn supports_native_fx() -> bool {
    cfg!(target_os = "windows")
}

#[tauri::command]
pub fn supports_window_fx() -> bool {
    supports_native_fx()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supports_native_fx_matches_platform() {
        let expected = cfg!(target_os = "windows");
        assert_eq!(supports_native_fx(), expected);
        assert_eq!(supports_window_fx(), expected);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn acrylic_tint_is_theme_aware() {
        let dark = acrylic_tint(true);
        let light = acrylic_tint(false);
        assert_eq!(dark, (30, 30, 30, 180));
        assert_eq!(light.0, 245);
        assert!(light.0 > dark.0);
    }
}
