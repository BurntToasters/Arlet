//! Native window materials and their safe fallback policy.
//!
//! Acrylic is the Arlet default because it gives the custom titlebar a glass
//! surface on Windows. Windows may reject a material at runtime (DWM policy,
//! OS version, remote sessions, or transparency settings), so every request
//! has a deterministic fallback ending in an opaque, theme-aware surface.

use serde::Serialize;
use tauri::{Theme, WebviewWindow};

/// Material values are deliberately represented by their public lowercase
/// strings so the command wire format remains stable for the renderer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowEffectPreference {
    #[default]
    Acrylic,
    Mica,
    Solid,
}

impl WindowEffectPreference {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Acrylic => "acrylic",
            Self::Mica => "mica",
            Self::Solid => "solid",
        }
    }

    /// Parse persisted values. Settings migrations use the default for
    /// unknown values; the command parser below returns an error instead so a
    /// malformed IPC request cannot silently select a different material.
    pub fn from_setting(value: Option<&str>) -> Self {
        match value {
            Some("mica") => Self::Mica,
            Some("solid") => Self::Solid,
            Some("acrylic") | None | Some(_) => Self::Acrylic,
        }
    }

    fn parse_command(value: &str) -> Result<Self, String> {
        match value {
            "acrylic" => Ok(Self::Acrylic),
            "mica" => Ok(Self::Mica),
            "solid" => Ok(Self::Solid),
            _ => Err("window effect preference must be acrylic, mica, or solid".to_string()),
        }
    }
}

/// Result returned by `set_window_fx`. Field names are intentionally the
/// exact snake_case keys consumed by the renderer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WindowEffectResult {
    pub requested: WindowEffectPreference,
    pub applied: WindowEffectPreference,
    pub fallback_reason: Option<String>,
}

fn opaque_color(dark: bool) -> tauri::window::Color {
    if dark {
        tauri::window::Color(0x1e, 0x1e, 0x1e, 0xff)
    } else {
        tauri::window::Color(0xf5, 0xf5, 0xf5, 0xff)
    }
}

#[cfg(target_os = "windows")]
fn acrylic_tint(dark: bool) -> (u8, u8, u8, u8) {
    if dark {
        (30, 30, 30, 180)
    } else {
        (245, 245, 245, 200)
    }
}

fn paint_opaque_background(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    window
        .set_background_color(Some(opaque_color(dark)))
        .map_err(|error| format!("could not paint opaque background: {error}"))
}

/// Keep WebView2 and the native material on the same resolved theme. This is
/// intentionally explicit even when switching to Acrylic: window-vibrancy
/// 0.8 ignores Acrylic tint on modern Windows, and clearing Mica does not
/// reset its immersive dark-mode attribute.
fn set_resolved_theme(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    let webview_result = window
        .set_theme(Some(if dark { Theme::Dark } else { Theme::Light }))
        .map_err(|error| format!("could not apply resolved WebView2 theme: {error}"));

    #[cfg(target_os = "windows")]
    let native_result = set_resolved_dwm_theme(window, dark);
    #[cfg(not(target_os = "windows"))]
    let native_result: Result<(), String> = Ok(());

    let failures = [webview_result.err(), native_result.err()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

#[cfg(target_os = "windows")]
fn set_resolved_dwm_theme(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE};

    let hwnd = window
        .hwnd()
        .map_err(|error| format!("could not obtain HWND for native theme: {error}"))?;
    let dark_mode = u32::from(dark);
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            (&dark_mode as *const u32).cast(),
            std::mem::size_of_val(&dark_mode) as u32,
        )
    }
    .map_err(|error| format!("DwmSetWindowAttribute(theme) failed: {error}"))
}

#[cfg(target_os = "windows")]
fn paint_transparent_background(window: &WebviewWindow) -> Result<(), String> {
    window
        .set_background_color(Some(tauri::window::Color(0, 0, 0, 0)))
        .map_err(|error| format!("could not make window transparent: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn paint_transparent_background(_window: &WebviewWindow) -> Result<(), String> {
    Err("native window effects are unavailable on this platform".to_string())
}

#[cfg(target_os = "windows")]
fn clear_native_effects(window: &WebviewWindow) -> Result<(), String> {
    let mut failures = Vec::new();

    // On Windows 10, clear_mica reports UnsupportedPlatformVersion because
    // Mica never existed there. That is an expected inactive-effect clear;
    // Win32/DWM errors remain fatal so a reported Solid result is truthful.
    if let Err(error) = window_vibrancy::clear_mica(window) {
        if !matches!(
            &error,
            window_vibrancy::Error::UnsupportedPlatformVersion(_)
        ) {
            failures.push(format!("clear_mica failed: {error}"));
        }
    }
    if let Err(error) = window_vibrancy::clear_acrylic(window) {
        if !matches!(
            &error,
            window_vibrancy::Error::UnsupportedPlatformVersion(_)
        ) {
            failures.push(format!("clear_acrylic failed: {error}"));
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

#[cfg(not(target_os = "windows"))]
fn clear_native_effects(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// Clear native effects and leave the webview on an opaque theme background.
/// This is also the final safety net for unsupported Windows configurations.
pub fn apply_solid(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    // Run every cleanup step even if an earlier one fails. This prevents a
    // stale material from being hidden behind an opaque-color claim and lets
    // the caller see all actionable native failures at once.
    let clear_result = clear_native_effects(window);
    let theme_result = set_resolved_theme(window, dark);
    let paint_result = paint_opaque_background(window, dark);
    let failures = [clear_result.err(), theme_result.err(), paint_result.err()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();

    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

#[cfg(target_os = "windows")]
fn apply_acrylic(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    use window_vibrancy::apply_acrylic;

    clear_native_effects(window)?;
    set_resolved_theme(window, dark)?;
    paint_transparent_background(window)?;
    apply_acrylic(window, Some(acrylic_tint(dark))).map_err(|error| error.to_string())
}

#[cfg(not(target_os = "windows"))]
fn apply_acrylic(window: &WebviewWindow, _dark: bool) -> Result<(), String> {
    paint_transparent_background(window)
}

#[cfg(target_os = "windows")]
fn apply_mica(window: &WebviewWindow, dark: bool) -> Result<(), String> {
    use window_vibrancy::apply_mica;

    clear_native_effects(window)?;
    set_resolved_theme(window, dark)?;
    paint_transparent_background(window)?;
    apply_mica(window, Some(dark)).map_err(|error| error.to_string())
}

#[cfg(not(target_os = "windows"))]
fn apply_mica(window: &WebviewWindow, _dark: bool) -> Result<(), String> {
    paint_transparent_background(window)
}

fn fallback_chain(requested: WindowEffectPreference) -> &'static [WindowEffectPreference] {
    const ACRYLIC_CHAIN: &[WindowEffectPreference] = &[
        WindowEffectPreference::Acrylic,
        WindowEffectPreference::Mica,
        WindowEffectPreference::Solid,
    ];
    const MICA_CHAIN: &[WindowEffectPreference] =
        &[WindowEffectPreference::Mica, WindowEffectPreference::Solid];
    const SOLID_CHAIN: &[WindowEffectPreference] = &[WindowEffectPreference::Solid];

    match requested {
        WindowEffectPreference::Acrylic => ACRYLIC_CHAIN,
        WindowEffectPreference::Mica => MICA_CHAIN,
        WindowEffectPreference::Solid => SOLID_CHAIN,
    }
}

fn apply_candidate(
    window: &WebviewWindow,
    candidate: WindowEffectPreference,
    dark: bool,
) -> Result<(), String> {
    match candidate {
        WindowEffectPreference::Acrylic => apply_acrylic(window, dark),
        WindowEffectPreference::Mica => apply_mica(window, dark),
        WindowEffectPreference::Solid => apply_solid(window, dark),
    }
}

/// Apply a requested material and return the material that actually won.
/// Earlier failures are included in `fallback_reason` for the debug drawer.
pub fn apply_preference(
    window: &WebviewWindow,
    requested: WindowEffectPreference,
    dark: bool,
) -> Result<WindowEffectResult, String> {
    let mut failures = Vec::new();

    for candidate in fallback_chain(requested) {
        match apply_candidate(window, *candidate, dark) {
            Ok(()) => {
                return Ok(WindowEffectResult {
                    requested,
                    applied: *candidate,
                    fallback_reason: (!failures.is_empty()).then(|| failures.join("; ")),
                });
            }
            Err(error) => {
                let failure = format!("{} failed: {error}", candidate.as_str());
                eprintln!("Window effect fallback: {failure}");
                failures.push(failure);
            }
        }
    }

    Err(format!(
        "all requested window effects failed: {}",
        failures.join("; ")
    ))
}

/// Apply a material from the renderer command wire format. Invalid values are
/// rejected before touching the existing native effect.
#[tauri::command]
pub fn set_window_fx(
    window: WebviewWindow,
    preference: String,
    dark: bool,
) -> Result<WindowEffectResult, String> {
    let requested = WindowEffectPreference::parse_command(&preference)?;
    apply_preference(&window, requested, dark)
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

    #[test]
    fn settings_parser_defaults_unknown_values_to_acrylic() {
        assert_eq!(
            WindowEffectPreference::from_setting(Some("unknown")),
            WindowEffectPreference::Acrylic
        );
        assert_eq!(
            WindowEffectPreference::from_setting(None),
            WindowEffectPreference::Acrylic
        );
    }

    #[test]
    fn command_parser_rejects_unknown_values_without_fallback() {
        assert!(WindowEffectPreference::parse_command("blur").is_err());
        assert_eq!(
            WindowEffectPreference::parse_command("mica").unwrap(),
            WindowEffectPreference::Mica
        );
    }

    #[test]
    fn fallback_order_is_deterministic() {
        assert_eq!(
            fallback_chain(WindowEffectPreference::Acrylic),
            &[
                WindowEffectPreference::Acrylic,
                WindowEffectPreference::Mica,
                WindowEffectPreference::Solid
            ]
        );
        assert_eq!(
            fallback_chain(WindowEffectPreference::Mica),
            &[WindowEffectPreference::Mica, WindowEffectPreference::Solid]
        );
        assert_eq!(
            fallback_chain(WindowEffectPreference::Solid),
            &[WindowEffectPreference::Solid]
        );
    }

    #[test]
    fn result_serializes_stable_snake_case_wire_keys() {
        let result = WindowEffectResult {
            requested: WindowEffectPreference::Acrylic,
            applied: WindowEffectPreference::Mica,
            fallback_reason: Some("acrylic failed".to_string()),
        };
        let value = serde_json::to_value(result).unwrap();
        assert_eq!(value["requested"], "acrylic");
        assert_eq!(value["applied"], "mica");
        assert_eq!(value["fallback_reason"], "acrylic failed");
        assert!(value.get("fallbackReason").is_none());
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
