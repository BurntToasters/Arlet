use serde::Serialize;

pub const MINIMUM_WINDOWS_BUILD: u32 = 19045;

pub fn supports_windows_build(build: u32) -> bool {
    build >= MINIMUM_WINDOWS_BUILD
}

#[cfg(windows)]
pub fn current_windows_build() -> Option<u32> {
    use windows::Win32::System::SystemInformation::{GetVersionExW, OSVERSIONINFOEXW};
    let mut version = OSVERSIONINFOEXW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOEXW>() as u32,
        ..Default::default()
    };
    unsafe { GetVersionExW((&mut version as *mut OSVERSIONINFOEXW).cast()) }.ok()?;
    Some(version.dwBuildNumber)
}

#[cfg(not(windows))]
pub fn current_windows_build() -> Option<u32> {
    None
}

pub fn ensure_supported_windows() -> Result<(), String> {
    #[cfg(windows)]
    {
        let build = current_windows_build()
            .ok_or_else(|| "Could not determine Windows build. Arlet requires Windows 10 22H2 (build 19045) or newer.".to_string())?;
        if !supports_windows_build(build) {
            return Err(format!(
                "Arlet requires Windows 10 22H2 (build 19045) or newer. Detected build {build}."
            ));
        }
    }
    Ok(())
}

#[derive(Serialize)]
pub struct AppInfo {
    pub version: String,
    pub tauri_version: String,
    /// Operating system from `std::env::consts::OS` (e.g. "windows").
    pub os: String,
    /// CPU architecture from `std::env::consts::ARCH` (e.g. "x86_64").
    pub arch: String,
    /// WebView2 runtime version, when queryable. `None` maps to JSON null.
    pub webview_version: Option<String>,
    /// Rust compiler version captured at build time, when available.
    pub rustc_version: Option<String>,
    /// Windows display/build string when running on Windows.
    pub windows_build: Option<String>,
    /// True for debug builds, false for release.
    pub debug: bool,
}

// `async` keeps the WebView2 and registry queries off the UI thread.
#[tauri::command(async)]
pub fn get_app_info(app: tauri::AppHandle) -> Result<AppInfo, String> {
    let version = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    Ok(AppInfo {
        version,
        tauri_version: tauri::VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        webview_version: tauri::webview_version().ok(),
        rustc_version: option_env!("ARLET_RUSTC_VERSION").map(str::to_string),
        windows_build: windows_display_build(),
        debug: cfg!(debug_assertions),
    })
}

const TOKEN_ENV_KEYS: [&str; 2] = [
    crate::token_policy::TOKEN_ENV,
    "VITE_MUSICKIT_DEVELOPER_TOKEN",
];

/// Release builds compiled by `build.rs` carry a validated token.
const EMBEDDED_TOKEN: Option<&str> = option_env!("ARLET_MUSICKIT_DEVELOPER_TOKEN");

/// Debug builds read `.env` at runtime; release builds serve only the token
/// embedded at compile time and never consult the user's environment.
pub fn resolve_developer_token<F>(
    debug: bool,
    embedded: Option<&str>,
    lookup: F,
    now: u64,
) -> Result<String, String>
where
    F: Fn(&str) -> Option<String>,
{
    if !debug {
        let token = embedded
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| {
                "This Arlet build was compiled without a MusicKit developer token.".to_string()
            })?;
        let exp = crate::token_policy::token_expiry(token)?;
        if exp <= now {
            return Err(
                "Arlet's Apple Music access token has expired. Install the latest Arlet update."
                    .to_string(),
            );
        }
        return Ok(token.to_string());
    }
    for key in TOKEN_ENV_KEYS {
        if let Some(value) = lookup(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }
    Err(
        "MUSICKIT_DEVELOPER_TOKEN is not set. Copy .env.example to .env and run npm run tauri:dev."
            .to_string(),
    )
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
pub fn get_developer_token() -> Result<String, String> {
    resolve_developer_token(
        cfg!(debug_assertions),
        EMBEDDED_TOKEN,
        |key| std::env::var(key).ok(),
        unix_now(),
    )
}

/// The only page `open_support_page` opens. The command takes no input, so
/// web content that can invoke it cannot pick a different URL.
pub const SUPPORT_URL: &str = "https://rosie.run/support";

#[tauri::command]
pub fn open_support_page() -> Result<(), String> {
    open_in_default_browser(SUPPORT_URL)
}

#[cfg(windows)]
fn open_in_default_browser(url: &str) -> Result<(), String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &HSTRING::from(url),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW reports success with a value above 32.
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!(
            "Could not open the default browser (code {}).",
            result.0 as isize
        ))
    }
}

#[cfg(not(windows))]
fn open_in_default_browser(_url: &str) -> Result<(), String> {
    Err("Opening the browser is supported on Windows only.".to_string())
}

pub fn beta_updater_target_for_arch(arch: &str) -> Result<String, String> {
    match arch {
        "x86_64" | "aarch64" => Ok(format!("windows-beta-{arch}-nsis")),
        other => Err(format!(
            "Beta updater is not published for architecture {other}."
        )),
    }
}

#[tauri::command]
pub fn get_beta_updater_target() -> Result<String, String> {
    beta_updater_target_for_arch(std::env::consts::ARCH)
}

#[cfg(windows)]
fn read_current_version_value(
    name: &str,
    flags: windows::Win32::System::Registry::REG_ROUTINE_FLAGS,
) -> Option<Vec<u8>> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE};
    let subkey = HSTRING::from(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
    let value = HSTRING::from(name);
    let mut buffer = vec![0u8; 256];
    let mut size = buffer.len() as u32;
    unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            &subkey,
            &value,
            flags,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
    }
    .ok()
    .ok()?;
    buffer.truncate(size as usize);
    Some(buffer)
}

#[cfg(windows)]
fn read_current_version_string(name: &str) -> Option<String> {
    use windows::Win32::System::Registry::RRF_RT_REG_SZ;
    let bytes = read_current_version_value(name, RRF_RT_REG_SZ)?;
    let wide: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .take_while(|unit| *unit != 0)
        .collect();
    let text = String::from_utf16_lossy(&wide).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// Registry read in-process; spawning PowerShell flashed a console window in
/// GUI-subsystem builds and stalled startup.
#[cfg(windows)]
fn windows_display_build() -> Option<String> {
    use windows::Win32::System::Registry::RRF_RT_REG_DWORD;
    let build = read_current_version_string("CurrentBuild")?;
    let display = read_current_version_string("DisplayVersion").unwrap_or_default();
    let ubr = read_current_version_value("UBR", RRF_RT_REG_DWORD)
        .and_then(|bytes| {
            bytes
                .get(..4)
                .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        })
        .unwrap_or(0);
    Some(format!("{display} build {build}.{ubr}").trim().to_string())
}

#[cfg(not(windows))]
fn windows_display_build() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn app_info_serializes() {
        let info = super::AppInfo {
            version: "0.1.0".to_string(),
            tauri_version: "2.0.0".to_string(),
            os: "windows".to_string(),
            arch: "x86_64".to_string(),
            webview_version: Some("152.0.0.0".to_string()),
            rustc_version: Some("rustc 1.88.0".to_string()),
            windows_build: Some("24H2 build 26100.1".to_string()),
            debug: true,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("0.1.0"));
        assert!(json.contains("webview_version"));
        assert!(json.contains("rustc_version"));
        assert!(json.contains("windows_build"));
    }

    const NOW: u64 = 1_800_000_000;

    fn embedded(exp: u64) -> String {
        // {"alg":"ES256"} . {"exp":<exp>} . sig
        let payload = format!("{{\"exp\":{exp}}}");
        let encode = |bytes: &[u8]| {
            const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let mut out = String::new();
            for chunk in bytes.chunks(3) {
                let n = chunk
                    .iter()
                    .enumerate()
                    .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
                for i in 0..=chunk.len() {
                    out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
                }
            }
            out
        };
        format!(
            "{}.{}.{}",
            encode(br#"{"alg":"ES256"}"#),
            encode(payload.as_bytes()),
            encode(b"sig")
        )
    }

    fn env_token(key: &str) -> Option<String> {
        (key == "MUSICKIT_DEVELOPER_TOKEN").then(|| " jwt-from-env ".to_string())
    }

    #[test]
    fn debug_reads_musickit_developer_token() {
        let token = super::resolve_developer_token(true, None, env_token, NOW).expect("token");
        assert_eq!(token, "jwt-from-env");
    }

    #[test]
    fn debug_accepts_legacy_vite_token_alias() {
        let token = super::resolve_developer_token(
            true,
            None,
            |key| (key == "VITE_MUSICKIT_DEVELOPER_TOKEN").then(|| "legacy-jwt".to_string()),
            NOW,
        )
        .expect("token");
        assert_eq!(token, "legacy-jwt");
    }

    #[test]
    fn missing_token_does_not_echo_secrets() {
        let err = super::resolve_developer_token(true, None, |_| None, NOW).unwrap_err();
        assert!(err.contains("MUSICKIT_DEVELOPER_TOKEN"));
        assert!(!err.contains("jwt"));
    }

    // Failure modes: release build without an embedded token falls back to a
    // user-controlled env var; an expired embedded token reaches MusicKit and
    // fails opaquely; error text echoes the embedded token.
    #[test]
    fn release_serves_embedded_token_only() {
        let valid = embedded(NOW + 86_400);
        assert_eq!(
            super::resolve_developer_token(false, Some(&valid), env_token, NOW).unwrap(),
            valid
        );
        let missing = super::resolve_developer_token(false, None, env_token, NOW).unwrap_err();
        assert!(missing.contains("without"));
    }

    #[test]
    fn release_rejects_expired_embedded_token() {
        let expired = embedded(NOW - 1);
        let err =
            super::resolve_developer_token(false, Some(&expired), env_token, NOW).unwrap_err();
        assert!(err.contains("update"));
        assert!(!err.contains(expired.split('.').nth(1).unwrap()));
    }

    #[test]
    fn beta_target_matches_published_windows_architectures() {
        assert_eq!(
            super::beta_updater_target_for_arch("x86_64").unwrap(),
            "windows-beta-x86_64-nsis"
        );
        assert_eq!(
            super::beta_updater_target_for_arch("aarch64").unwrap(),
            "windows-beta-aarch64-nsis"
        );
    }

    #[test]
    fn beta_target_rejects_unpublished_architectures() {
        assert!(super::beta_updater_target_for_arch("x86").is_err());
    }

    // Failure mode: the support link is pointed at a non-HTTPS or different
    // host by an edit; the command itself takes no URL input.
    #[test]
    fn support_url_is_the_https_support_page() {
        assert_eq!(super::SUPPORT_URL, "https://rosie.run/support");
    }

    #[test]
    fn windows_support_floor_is_build_19045() {
        assert!(!super::supports_windows_build(19044));
        assert!(super::supports_windows_build(19045));
        assert!(super::supports_windows_build(26100));
    }
}
