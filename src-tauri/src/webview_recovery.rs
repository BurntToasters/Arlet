//! Recovers the main window when a WebView2 process dies. Without this a
//! renderer crash leaves a blank frameless window with no way back.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recovery {
    Reload,
    Restart,
    Ignore,
}

/// Renderer crashes within this window count toward the loop guard.
pub const CRASH_WINDOW: Duration = Duration::from_secs(60);
pub const MAX_RELOADS_PER_WINDOW: usize = 3;

/// Maps `COREWEBVIEW2_PROCESS_FAILED_KIND` values to an action. Frame,
/// GPU, and utility process failures are recovered by WebView2 itself.
pub fn recovery_for_kind(kind: i32) -> Recovery {
    match kind {
        // BROWSER_PROCESS_EXITED: the webview is gone; only a restart helps.
        0 => Recovery::Restart,
        // RENDER_PROCESS_EXITED, RENDER_PROCESS_UNRESPONSIVE.
        1 | 2 => Recovery::Reload,
        _ => Recovery::Ignore,
    }
}

/// Stops reloading once a page crashes repeatedly (a crash loop).
#[derive(Default)]
pub struct CrashGuard {
    reloads: VecDeque<Instant>,
}

impl CrashGuard {
    pub fn allow_reload(&mut self, now: Instant) -> bool {
        while self
            .reloads
            .front()
            .is_some_and(|at| now.duration_since(*at) > CRASH_WINDOW)
        {
            self.reloads.pop_front();
        }
        if self.reloads.len() >= MAX_RELOADS_PER_WINDOW {
            return false;
        }
        self.reloads.push_back(now);
        true
    }
}

/// Registers the ProcessFailed handler on the main window's WebView2.
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
    use std::sync::Mutex;
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND;
    use webview2_com::ProcessFailedEventHandler;

    let app = window.app_handle().clone();
    window
        .with_webview(move |webview| {
            let guard = Mutex::new(CrashGuard::default());
            let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                unsafe { args.ProcessFailedKind(&mut kind)? };
                let action = recovery_for_kind(kind.0);
                let message = format!("WebView2 process failed (kind {}): {action:?}", kind.0);
                eprintln!("{message}");
                let _ = crate::logging::append_local_log(app.clone(), message);
                match action {
                    Recovery::Reload => {
                        let allowed = guard
                            .lock()
                            .map(|mut guard| guard.allow_reload(Instant::now()))
                            .unwrap_or(false);
                        if let (true, Some(sender)) = (allowed, sender) {
                            unsafe { sender.Reload()? };
                        }
                    }
                    Recovery::Restart => app.request_restart(),
                    Recovery::Ignore => {}
                }
                Ok(())
            }));
            unsafe {
                if let Ok(core) = webview.controller().CoreWebView2() {
                    let mut token = Default::default();
                    if let Err(error) = core.add_ProcessFailed(&handler, &mut token) {
                        eprintln!("Unable to watch WebView2 process failures: {error}");
                    }
                }
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Failure modes: a renderer crash leaves a blank window; a browser
    // process exit is "recovered" by reloading a webview that no longer
    // exists; GPU or iframe failures (which WebView2 recovers itself)
    // reload the whole app; a page that crashes on load reloads forever.
    #[test]
    fn maps_process_failures_to_recovery() {
        assert_eq!(recovery_for_kind(0), Recovery::Restart); // browser exited
        assert_eq!(recovery_for_kind(1), Recovery::Reload); // render exited
        assert_eq!(recovery_for_kind(2), Recovery::Reload); // unresponsive
        assert_eq!(recovery_for_kind(3), Recovery::Ignore); // frame renderer
        assert_eq!(recovery_for_kind(5), Recovery::Ignore); // GPU
        assert_eq!(recovery_for_kind(99), Recovery::Ignore);
    }

    #[test]
    fn crash_guard_stops_reload_loops_and_recovers_later() {
        let start = Instant::now();
        let mut guard = CrashGuard::default();
        for second in 0..MAX_RELOADS_PER_WINDOW as u64 {
            assert!(guard.allow_reload(start + Duration::from_secs(second)));
        }
        assert!(!guard.allow_reload(start + Duration::from_secs(10)));
        assert!(guard.allow_reload(start + CRASH_WINDOW + Duration::from_secs(5)));
    }
}
