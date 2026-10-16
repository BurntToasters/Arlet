#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Arlet ships only on Windows. Linux CI checks that the crate builds and the
// portable unit tests pass, but helpers whose callers are `#[cfg(windows)]`
// (WebView2 recovery, SMTC timeline, the build check) are unused there.
// Windows clippy, where they are used, still reports real dead code.
#![cfg_attr(not(windows), allow(dead_code))]

mod auth_popup;
mod commands;
mod library_cache;
mod logging;
mod music_diagnostic;
mod pins;
mod playback_session;
mod settings;
mod token_policy;
mod tray;
mod webview_recovery;
mod window_fx;
mod window_snap;
mod window_state;
mod windows_media;

use std::sync::Mutex;

use logging::LogFileLock;

/// Tauri panics when the setup hook returns an error, so a WebView2 failure
/// would end the process silently. WebView2 asks hosts to retry controller
/// creation once; a second failure is explained to the user and logged.
fn create_main_window_or_exit(app: &tauri::App) -> tauri::WebviewWindow {
    let error = match auth_popup::create_main_window(app) {
        Ok(window) => return window,
        Err(first) => {
            logging::write_native_log(&format!(
                "Main window creation failed; retrying once: {first}"
            ));
            match auth_popup::create_main_window(app) {
                Ok(window) => return window,
                Err(second) => second,
            }
        }
    };
    logging::write_native_log(&format!("Main window creation failed: {error}"));
    commands::show_error_dialog(&format!(
        "Arlet could not open its window because Microsoft Edge WebView2 failed to start.\n\n\
         {error}\n\n\
         Restart Windows and try again. If this keeps happening, reinstall the \
         WebView2 Runtime from Microsoft."
    ));
    std::process::exit(1);
}

fn main() {
    logging::install_panic_hook();
    if let Err(error) = commands::ensure_supported_windows() {
        commands::show_error_dialog(&error);
        return;
    }
    let mut builder = tauri::Builder::default();

    // Single-instance must be the first plugin, so a second launch exits
    // before any other plugin initializes.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch brings the existing window back even when it
            // is minimized or hidden to the tray; focus alone leaves it on the taskbar.
            tray::show_main_window(app);
        }));
    }
    builder = builder.plugin(tauri_plugin_clipboard_manager::init());
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(LogFileLock(Mutex::new(())))
        .manage(library_cache::LibraryCacheState::default())
        .manage(window_state::WindowStateCache::default())
        .setup(|app| {
            // Read before the webview exists: its first log lines must
            // already follow Debug Mode.
            let appearance = settings::load_startup_appearance(app.handle());
            settings::set_debug_mode(appearance.debug_mode);
            let window = create_main_window_or_exit(app);
            // The config is declaratively frameless; repeat the setting while
            // hidden for runtimes that cache an older generated config. A
            // failure is logged but is not allowed to reintroduce a native
            // frame because the builder already requested decorations=false.
            if let Err(error) = window.set_decorations(false) {
                eprintln!("Unable to confirm frameless window: {error}");
            }

            let dark = appearance.theme.resolve_dark(&window);
            if let Err(error) = window_fx::apply_preference(&window, appearance.window_effect, dark)
            {
                // A failed material must not prevent the app from becoming
                // usable. apply_preference already attempts solid, and this
                // final retry protects the setup/show path if that attempt
                // itself returned an error.
                eprintln!("Unable to apply startup window effect: {error}");
                if let Err(solid_error) = window_fx::apply_solid(&window, dark) {
                    eprintln!("Unable to apply solid startup fallback: {solid_error}");
                }
            }
            if let Err(error) = webview_recovery::install(&window) {
                eprintln!("Unable to install WebView2 crash recovery: {error}");
            }
            settings::set_tray_icon(appearance.tray_icon);
            if appearance.tray_icon {
                if let Err(error) = tray::install(app.handle()) {
                    eprintln!("Unable to create the tray icon: {error}");
                }
            }
            // Positioned while still hidden, so there is no visible jump.
            let restored = window_state::restore(&window);
            window.show()?;
            if let Some(state) = restored {
                window_state::settle_after_show(&window, state);
            }
            #[cfg(debug_assertions)]
            if music_diagnostic::should_auto_open_music_diagnostic(
                std::env::var(music_diagnostic::AUTO_OPEN_ENV)
                    .ok()
                    .as_deref(),
            ) {
                let _ = music_diagnostic::open_music_diagnostic(app.handle().clone());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == auth_popup::MAIN_WINDOW_LABEL
                && matches!(
                    event,
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
                )
            {
                window_state::record(window);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == auth_popup::MAIN_WINDOW_LABEL {
                    if tray::should_hide_on_close() {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        // A shown-again window may move without a final Moved
                        // event; capture the geometry it closes at.
                        window_state::record(window);
                        // A settings reset closes for its restart; any other
                        // close quits once the page has saved its queue.
                        if !settings::reset_pending() {
                            use tauri::Manager;
                            api.prevent_close();
                            tray::request_quit(window.app_handle());
                        }
                    }
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if window.label() == auth_popup::MAIN_WINDOW_LABEL {
                    window_state::persist(window);
                }
                window_snap::on_window_destroyed(window);
                // Auth popups and the diagnostic window must not tear down
                // the main window's media session.
                if window.label() == auth_popup::MAIN_WINDOW_LABEL {
                    windows_media::dispose();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::get_developer_token,
            commands::get_beta_updater_target,
            commands::open_support_page,
            commands::open_about_link,
            tray::quit_ready,
            music_diagnostic::open_music_diagnostic,
            settings::load_settings,
            settings::save_settings,
            settings::reset_settings,
            pins::load_pins,
            pins::save_pins,
            pins::delete_pins,
            playback_session::load_playback_session,
            playback_session::save_playback_session,
            playback_session::delete_playback_session,
            logging::append_local_log,
            logging::get_log_dir,
            logging::clear_logs,
            library_cache::library_cache_read_page,
            library_cache::library_cache_read_section,
            library_cache::library_cache_write_page,
            library_cache::library_cache_clear_section,
            library_cache::library_cache_set_meta,
            library_cache::library_cache_get_meta,
            library_cache::library_cache_clear,
            window_fx::set_window_fx,
            window_fx::supports_window_fx,
            window_snap::set_snap_overlay_bounds,
            windows_media::update_windows_media_session,
            windows_media::update_windows_media_timeline,
            windows_media::clear_windows_media_session,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| {
            commands::show_error_dialog(&format!("Arlet could not start: {error}"));
            std::process::exit(1);
        });
}
