//! Launch at startup through the per-user `Run` key. The entry starts Arlet
//! with `--autostart`, which startup uses to keep the window out of sight.

/// Value name under the Run key; the NSIS uninstaller deletes it by this name.
const VALUE_NAME: &str = "Arlet";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
/// Redirects the Run key so E2E runs never touch the real startup list.
const RUN_KEY_OVERRIDE_ENV: &str = "ARLET_E2E_RUN_KEY";
/// Argument the Run entry passes on sign-in.
pub const AUTOSTART_ARG: &str = "--autostart";

/// True when this process was started by the Run entry.
pub fn launched_at_startup() -> bool {
    std::env::args().any(|arg| arg == AUTOSTART_ARG)
}

fn run_key_path() -> String {
    match std::env::var(RUN_KEY_OVERRIDE_ENV) {
        Ok(path) if !path.is_empty() => path,
        _ => RUN_KEY.to_string(),
    }
}

/// Quoted so an install path with spaces still launches.
fn run_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|error| format!("Unable to find Arlet: {error}"))?;
    Ok(format!("\"{}\" {AUTOSTART_ARG}", exe.display()))
}

/// Writes or removes the Run entry. A missing entry counts as removed.
pub fn apply(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        if enabled {
            write_value(&run_command()?)
        } else {
            delete_value()
        }
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Ok(())
    }
}

#[cfg(windows)]
fn write_value(command: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };
    let subkey = HSTRING::from(run_key_path());
    let mut key = HKEY(std::ptr::null_mut());
    // SAFETY: `key` receives the opened handle, and `subkey` lives for the call.
    unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            &subkey,
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut key,
            None,
        )
    }
    .ok()
    .map_err(|error| format!("Unable to open the startup registry key: {error}"))?;
    // REG_SZ data is UTF-16LE with a terminating NUL.
    let data: Vec<u8> = command
        .encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect();
    let name = HSTRING::from(VALUE_NAME);
    // SAFETY: `key` is open until the close below, and `data` lives for the call.
    let written = unsafe { RegSetValueExW(key, &name, None, REG_SZ, Some(&data)) };
    // SAFETY: `key` was opened by RegCreateKeyExW above and is closed once.
    unsafe {
        let _ = RegCloseKey(key);
    }
    written
        .ok()
        .map_err(|error| format!("Unable to write the startup entry: {error}"))
}

#[cfg(windows)]
fn delete_value() -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
    };
    let subkey = HSTRING::from(run_key_path());
    let mut key = HKEY(std::ptr::null_mut());
    // SAFETY: `key` receives the opened handle, and `subkey` lives for the call.
    let opened =
        unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, &subkey, None, KEY_SET_VALUE, &mut key) };
    if opened == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    opened
        .ok()
        .map_err(|error| format!("Unable to open the startup registry key: {error}"))?;
    let name = HSTRING::from(VALUE_NAME);
    // SAFETY: `key` is open until the close below, and `name` lives for the call.
    let deleted = unsafe { RegDeleteValueW(key, &name) };
    // SAFETY: `key` was opened by RegOpenKeyExW above and is closed once.
    unsafe {
        let _ = RegCloseKey(key);
    }
    if deleted == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    deleted
        .ok()
        .map_err(|error| format!("Unable to remove the startup entry: {error}"))
}
