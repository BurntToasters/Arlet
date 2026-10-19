//! Pauses playback on system suspend, when the output device in use is
//! removed or deactivated (unplugged, Bluetooth dropped), and when the lid
//! closes with the display off (Modern Standby keeps audio running). Pauses go
//! out as the existing `windows-media-control` "pause" event. Screen lock is
//! not a trigger: people listen with the screen locked.
//!
//! Failure modes:
//! - Duplicate pauses: one default change fires once per role; the tracker
//!   compares device ids, so only the first notification can pause.
//! - Headphones plugged in also change the default. The previous device is
//!   still active, so that does not pause.
//! - Pause while paused: harmless for suspend; device changes check playing.
//! - COM: the notifier lives on its own MTA thread, never the UI thread.
//! - Callback outliving the app: callbacks use only a process-lifetime
//!   `OnceLock<AppHandle>` and a static tracker; registrations last until exit.
//! - Panics across FFI: callback bodies run under `catch_unwind` and return
//!   success. Release builds abort on panic, so the guard is a no-op there.
//! - Registration failure: logged, and the app runs without these pauses. A
//!   change between seeding and registration is missed.
//! - Re-install: guarded by `APP`, so only one registration exists.
//! - Lid: a closed lid with an external display on (docked), or an idle
//!   display timeout with the lid open, does not pause.
//! - Lid seeds: the registration-time notification only sets state. A failed
//!   registration leaves that setting unseeded, so it never pauses.

use tauri::AppHandle;

/// `PBT_APMSUSPEND`: the system is entering sleep or hibernation. The query
/// form (`PBT_APMQUERYSUSPEND`, 0) is not a pause because it can be denied.
const PBT_APMSUSPEND: u32 = 0x0004;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flow {
    Render,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Console,
    Multimedia,
    Other,
}

/// True for power notifications that mean the system is going to sleep.
pub fn pauses_on_power_event(event: u32) -> bool {
    event == PBT_APMSUSPEND
}

/// Pause decision for a default-device change. A change pauses only when the
/// previous output is gone or inactive; a newly added device does not count.
pub fn should_pause_on_default_change(
    playing: bool,
    flow: Flow,
    role: Role,
    previous_active: bool,
) -> bool {
    playing
        && flow == Flow::Render
        && matches!(role, Role::Console | Role::Multimedia)
        && !previous_active
}

/// Remembers the last default render device so a change is handled once,
/// however many role notifications Windows sends for it.
#[derive(Debug)]
pub struct DefaultRenderTracker {
    last_id: Option<String>,
}

impl DefaultRenderTracker {
    pub const fn new() -> Self {
        Self { last_id: None }
    }

    /// Records the device that is default at startup, so the first real
    /// change is compared against it.
    pub fn seed(&mut self, id: &str) {
        self.last_id = Some(id.to_string());
    }

    pub fn last_id(&self) -> Option<&str> {
        self.last_id.as_deref()
    }

    /// Returns true when this notification should pause playback.
    /// `previous_active` is whether the device recorded before this
    /// notification is still active; the caller queries it only on a change.
    pub fn observe(
        &mut self,
        playing: bool,
        flow: Flow,
        role: Role,
        id: &str,
        previous_active: bool,
    ) -> bool {
        if flow != Flow::Render || role == Role::Other {
            return false;
        }
        let changed = self.last_id.as_deref() != Some(id);
        if changed {
            self.last_id = Some(id.to_string());
        }
        changed && should_pause_on_default_change(playing, flow, role, previous_active)
    }
}

/// `PBT_POWERSETTINGCHANGE`: a registered power setting changed.
const PBT_POWERSETTINGCHANGE: u32 = 0x8013;

/// Tracks the lid and the console display, and pauses once when the system
/// enters "lid closed AND display off". The first value seen for each setting
/// is the registration seed and never pauses.
#[derive(Debug, Default)]
pub struct LidDisplayTracker {
    lid_closed: Option<bool>,
    display_off: Option<bool>,
}

impl LidDisplayTracker {
    pub const fn new() -> Self {
        Self {
            lid_closed: None,
            display_off: None,
        }
    }

    fn closed_and_off(&self) -> bool {
        self.lid_closed == Some(true) && self.display_off == Some(true)
    }

    /// Records the lid state. Returns true when this entered "closed and off".
    pub fn observe_lid(&mut self, closed: bool) -> bool {
        let was = self.closed_and_off();
        let seeded = self.lid_closed.replace(closed).is_some();
        seeded && !was && self.closed_and_off()
    }

    /// Records the console display state. Returns true when this entered
    /// "closed and off".
    pub fn observe_display(&mut self, off: bool) -> bool {
        let was = self.closed_and_off();
        let seeded = self.display_off.replace(off).is_some();
        seeded && !was && self.closed_and_off()
    }
}

#[cfg(windows)]
mod platform {
    use super::{
        pauses_on_power_event, DefaultRenderTracker, Flow, LidDisplayTracker, Role,
        PBT_POWERSETTINGCHANGE,
    };
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use std::sync::{Mutex, MutexGuard, OnceLock};
    use tauri::{AppHandle, Emitter};
    use windows::core::{Result as WinResult, GUID, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{HANDLE, PROPERTYKEY};
    use windows::Win32::Media::Audio::{
        eConsole, eMultimedia, eRender, EDataFlow, ERole, IMMDeviceEnumerator,
        IMMNotificationClient, IMMNotificationClient_Impl, MMDeviceEnumerator, DEVICE_STATE,
        DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Power::{
        PowerRegisterSuspendResumeNotification, PowerSettingRegisterNotification,
        DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, POWERBROADCAST_SETTING,
    };
    use windows::Win32::System::SystemServices::{
        GUID_CONSOLE_DISPLAY_STATE, GUID_LIDSWITCH_STATE_CHANGE,
    };
    use windows::Win32::UI::WindowsAndMessaging::DEVICE_NOTIFY_CALLBACK;
    use windows_core::implement;

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static DEFAULT_RENDER: Mutex<DefaultRenderTracker> = Mutex::new(DefaultRenderTracker::new());
    static LID_DISPLAY: Mutex<LidDisplayTracker> = Mutex::new(LidDisplayTracker::new());

    fn tracker() -> MutexGuard<'static, DefaultRenderTracker> {
        DEFAULT_RENDER
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lid_display() -> MutexGuard<'static, LidDisplayTracker> {
        LID_DISPLAY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Runs a callback body so a panic cannot unwind into Windows.
    fn guarded(what: &str, body: impl FnOnce()) {
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)).is_err() {
            crate::logging::write_native_log(&format!("Panic in {what} callback suppressed"));
        }
    }

    fn emit_pause(reason: &str) {
        let Some(app) = APP.get() else {
            return;
        };
        match app.emit_to(
            crate::auth_popup::MAIN_WINDOW_LABEL,
            "windows-media-control",
            "pause",
        ) {
            Ok(()) => crate::logging::write_native_log(&format!("Paused playback: {reason}")),
            Err(error) => crate::logging::write_native_log(&format!(
                "Pause for {reason} was not delivered: {error}"
            )),
        }
    }

    unsafe extern "system" fn power_callback(
        _context: *const c_void,
        event: u32,
        _setting: *const c_void,
    ) -> u32 {
        guarded("power", || {
            if pauses_on_power_event(event) {
                emit_pause("system suspend");
            }
        });
        0
    }

    unsafe extern "system" fn setting_callback(
        _context: *const c_void,
        event: u32,
        setting: *const c_void,
    ) -> u32 {
        guarded("power setting", || {
            if event == PBT_POWERSETTINGCHANGE {
                observe_setting(setting);
            }
        });
        0
    }

    /// Reads a `POWERBROADCAST_SETTING` and routes lid and display changes.
    fn observe_setting(setting: *const c_void) {
        if setting.is_null() {
            return;
        }
        let setting = setting.cast::<POWERBROADCAST_SETTING>();
        // Safe to read: Windows fills the header before every callback.
        let (guid, length) = unsafe {
            (
                std::ptr::addr_of!((*setting).PowerSetting).read_unaligned(),
                std::ptr::addr_of!((*setting).DataLength).read_unaligned(),
            )
        };
        if length < 4 {
            return;
        }
        let value = unsafe {
            std::ptr::addr_of!((*setting).Data)
                .cast::<u32>()
                .read_unaligned()
        };
        if guid == GUID_LIDSWITCH_STATE_CHANGE {
            // 0 = closed, 1 = open.
            let pause = lid_display().observe_lid(value == 0);
            if pause {
                emit_pause("lid closed with the display off");
            }
        } else if guid == GUID_CONSOLE_DISPLAY_STATE {
            // 0 = off, 1 = on, 2 = dimmed. Dimmed still counts as on.
            let pause = lid_display().observe_display(value == 0);
            if pause {
                emit_pause("lid closed with the display off");
            }
        }
    }

    fn register_setting(what: &str, guid: &GUID) {
        // Leaked on purpose: Windows keeps the pointer until process exit.
        let params = Box::into_raw(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(setting_callback),
            Context: null_mut(),
        }));
        let mut handle: *mut c_void = null_mut();
        let status = unsafe {
            PowerSettingRegisterNotification(
                guid,
                DEVICE_NOTIFY_CALLBACK,
                HANDLE(params.cast()),
                &mut handle,
            )
        };
        if status.0 != 0 {
            crate::logging::write_native_log(&format!(
                "Unable to register {what} notification (error {})",
                status.0
            ));
        }
    }

    fn register_power() {
        // Leaked on purpose: Windows keeps the pointer until process exit.
        let params = Box::into_raw(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(power_callback),
            Context: null_mut(),
        }));
        let mut handle: *mut c_void = null_mut();
        let status = unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                HANDLE(params.cast()),
                &mut handle,
            )
        };
        if status.0 != 0 {
            crate::logging::write_native_log(&format!(
                "Unable to register suspend notification (error {})",
                status.0
            ));
        }
    }

    fn flow_of(flow: EDataFlow) -> Flow {
        if flow == eRender {
            Flow::Render
        } else {
            Flow::Other
        }
    }

    fn role_of(role: ERole) -> Role {
        if role == eConsole {
            Role::Console
        } else if role == eMultimedia {
            Role::Multimedia
        } else {
            Role::Other
        }
    }

    /// True while the endpoint exists and is active. Unplugged, disabled, or
    /// removed devices (including a failed lookup) report false.
    fn render_device_active(enumerator: &IMMDeviceEnumerator, id: &str) -> bool {
        let id = HSTRING::from(id);
        unsafe { enumerator.GetDevice(&id) }
            .and_then(|device| unsafe { device.GetState() })
            .is_ok_and(|state| state == DEVICE_STATE_ACTIVE)
    }

    #[implement(IMMNotificationClient)]
    struct DeviceNotifier {
        enumerator: IMMDeviceEnumerator,
    }

    impl IMMNotificationClient_Impl for DeviceNotifier_Impl {
        fn OnDeviceStateChanged(&self, _id: &PCWSTR, _state: DEVICE_STATE) -> WinResult<()> {
            Ok(())
        }

        fn OnDeviceAdded(&self, _id: &PCWSTR) -> WinResult<()> {
            Ok(())
        }

        fn OnDeviceRemoved(&self, _id: &PCWSTR) -> WinResult<()> {
            Ok(())
        }

        fn OnDefaultDeviceChanged(
            &self,
            flow: EDataFlow,
            role: ERole,
            id: &PCWSTR,
        ) -> WinResult<()> {
            guarded("default device", || {
                let id = if id.is_null() {
                    String::new()
                } else {
                    unsafe { id.to_string() }.unwrap_or_default()
                };
                // Only the device this session was using decides the pause.
                let previous = tracker()
                    .last_id()
                    .filter(|old| *old != id)
                    .map(str::to_owned);
                let previous_active =
                    previous.is_none_or(|old| render_device_active(&self.enumerator, &old));
                let playing = crate::windows_media::is_playing();
                let pause =
                    tracker().observe(playing, flow_of(flow), role_of(role), &id, previous_active);
                if pause {
                    emit_pause("output device removed");
                }
            });
            Ok(())
        }

        fn OnPropertyValueChanged(&self, _id: &PCWSTR, _key: &PROPERTYKEY) -> WinResult<()> {
            Ok(())
        }
    }

    fn default_render_id(enumerator: &IMMDeviceEnumerator) -> Option<String> {
        unsafe {
            let device = enumerator
                .GetDefaultAudioEndpoint(eRender, eMultimedia)
                .ok()?;
            let id = device.GetId().ok()?;
            let text = id.to_string().ok();
            CoTaskMemFree(Some(id.as_ptr().cast()));
            text
        }
    }

    /// Owns the endpoint enumerator and notifier for the process lifetime.
    /// Returns only on failure.
    fn watch_default_render() -> WinResult<()> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok()?;
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
        if let Some(id) = default_render_id(&enumerator) {
            tracker().seed(&id);
        }
        let client: IMMNotificationClient = DeviceNotifier {
            enumerator: enumerator.clone(),
        }
        .into();
        unsafe { enumerator.RegisterEndpointNotificationCallback(&client)? };
        loop {
            std::thread::park();
        }
    }

    pub fn install(app: &AppHandle) {
        if APP.set(app.clone()).is_err() {
            return;
        }
        register_power();
        register_setting("lid state", &GUID_LIDSWITCH_STATE_CHANGE);
        register_setting("console display state", &GUID_CONSOLE_DISPLAY_STATE);
        let spawned = std::thread::Builder::new()
            .name("arlet-audio-endpoints".into())
            .spawn(|| {
                if let Err(error) = watch_default_render() {
                    crate::logging::write_native_log(&format!(
                        "Unable to watch the default audio output: {error}"
                    ));
                }
            });
        if let Err(error) = spawned {
            crate::logging::write_native_log(&format!(
                "Unable to start the audio output watcher: {error}"
            ));
        }
    }
}

/// Registers the suspend, lid, and audio-output handlers. Call once, after the
/// main window exists. Failures are logged and never stop startup.
#[cfg(windows)]
pub fn install(app: &AppHandle) {
    platform::install(app);
}

#[cfg(not(windows))]
pub fn install(_app: &AppHandle) {}

#[cfg(test)]
mod tests {
    use super::{pauses_on_power_event, should_pause_on_default_change, DefaultRenderTracker};
    use super::{Flow, LidDisplayTracker, Role};

    // Failure mode: a docked laptop with the lid closed and an external
    // display still on must not pause.
    #[test]
    fn closed_lid_with_display_on_does_not_pause() {
        let mut tracker = LidDisplayTracker::new();
        assert!(!tracker.observe_lid(false));
        assert!(!tracker.observe_display(false));
        assert!(!tracker.observe_lid(true));
    }

    // Failure mode: an idle display timeout with the lid open is not a lid
    // close and must not pause.
    #[test]
    fn display_off_with_lid_open_does_not_pause() {
        let mut tracker = LidDisplayTracker::new();
        assert!(!tracker.observe_lid(false));
        assert!(!tracker.observe_display(false));
        assert!(!tracker.observe_display(true));
    }

    // Failure mode: the registration-time notifications report current state;
    // reading them as transitions pauses on launch with the lid already shut.
    #[test]
    fn registration_seeds_never_pause() {
        let mut tracker = LidDisplayTracker::new();
        assert!(!tracker.observe_lid(true));
        assert!(!tracker.observe_display(true));
    }

    // Failure mode: a lid closed while the display is already off must pause
    // on entry, and repeated notifications must not pause again.
    #[test]
    fn entering_closed_and_off_pauses_once() {
        let mut tracker = LidDisplayTracker::new();
        assert!(!tracker.observe_lid(false));
        assert!(!tracker.observe_display(false));
        assert!(!tracker.observe_display(true));
        assert!(tracker.observe_lid(true));
        assert!(!tracker.observe_lid(true));
        assert!(!tracker.observe_display(true));
    }

    // Failure mode: reopening the lid must re-arm the pause, so the next close
    // pauses again; a display coming back on while closed must not pause.
    #[test]
    fn reopening_rearms_the_pause() {
        let mut tracker = LidDisplayTracker::new();
        assert!(!tracker.observe_lid(false));
        assert!(!tracker.observe_display(false));
        assert!(!tracker.observe_lid(true));
        assert!(tracker.observe_display(true));
        assert!(!tracker.observe_display(false));
        assert!(!tracker.observe_lid(false));
        assert!(!tracker.observe_display(true));
        assert!(tracker.observe_lid(true));
    }

    // Failure mode: a query for permission to sleep, or a resume, is treated
    // as a suspend and pauses playing music for no reason.
    #[test]
    fn only_the_suspend_event_pauses() {
        assert!(pauses_on_power_event(0x0004));
        assert!(!pauses_on_power_event(0x0000)); // PBT_APMQUERYSUSPEND
        assert!(!pauses_on_power_event(0x0007)); // PBT_APMRESUMESUSPEND
        assert!(!pauses_on_power_event(0x0012)); // PBT_APMRESUMEAUTOMATIC
    }

    // Failure modes: capture changes and the communications role pause music;
    // a change while stopped pauses; plugging headphones in pauses while the
    // previous output is still active.
    #[test]
    fn default_change_pauses_only_when_previous_output_is_gone() {
        assert!(should_pause_on_default_change(
            true,
            Flow::Render,
            Role::Console,
            false
        ));
        assert!(should_pause_on_default_change(
            true,
            Flow::Render,
            Role::Multimedia,
            false
        ));
        assert!(!should_pause_on_default_change(
            true,
            Flow::Render,
            Role::Console,
            true
        ));
        assert!(!should_pause_on_default_change(
            false,
            Flow::Render,
            Role::Multimedia,
            false
        ));
        assert!(!should_pause_on_default_change(
            true,
            Flow::Other,
            Role::Multimedia,
            false
        ));
        assert!(!should_pause_on_default_change(
            true,
            Flow::Render,
            Role::Other,
            false
        ));
    }

    // Failure mode: one device change fires once per role and pauses twice.
    #[test]
    fn one_change_pauses_once_across_roles() {
        let mut tracker = DefaultRenderTracker::new();
        tracker.seed("device-a");
        assert!(tracker.observe(true, Flow::Render, Role::Console, "device-b", false));
        assert!(!tracker.observe(true, Flow::Render, Role::Multimedia, "device-b", true));
    }

    // Failure mode: headphones plugged in change the default while the old
    // speaker is still active; that must not stop playback.
    #[test]
    fn plugging_in_a_new_output_does_not_pause() {
        let mut tracker = DefaultRenderTracker::new();
        tracker.seed("speaker");
        assert!(!tracker.observe(true, Flow::Render, Role::Console, "headphones", true));
        assert_eq!(tracker.last_id(), Some("headphones"));
    }

    // Failure mode: a notification for the unchanged device pauses, which
    // would stop playback on a device that is still in use.
    #[test]
    fn same_device_never_pauses() {
        let mut tracker = DefaultRenderTracker::new();
        tracker.seed("device-a");
        assert!(!tracker.observe(true, Flow::Render, Role::Multimedia, "device-a", false));
    }

    // Failure mode: a change while stopped is forgotten, so the next
    // notification for that same device pauses playback that just started.
    #[test]
    fn change_while_stopped_is_remembered() {
        let mut tracker = DefaultRenderTracker::new();
        tracker.seed("device-a");
        assert!(!tracker.observe(false, Flow::Render, Role::Multimedia, "device-b", false));
        assert!(!tracker.observe(true, Flow::Render, Role::Multimedia, "device-b", true));
    }

    // Failure mode: with no startup device known, the first change must not
    // pause on an unknown previous state.
    #[test]
    fn unseeded_first_change_with_active_previous_does_not_pause() {
        let mut tracker = DefaultRenderTracker::new();
        assert!(!tracker.observe(true, Flow::Render, Role::Console, "device-a", true));
    }

    // Failure mode: unplugging the last output reports an empty id and a gone
    // previous device; that is a real change and must pause while playing.
    #[test]
    fn removed_previous_output_pauses_even_with_empty_new_id() {
        let mut tracker = DefaultRenderTracker::new();
        tracker.seed("device-a");
        assert!(tracker.observe(true, Flow::Render, Role::Console, "", false));
    }
}
