#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth_popup;
mod commands;
mod logging;
mod music_diagnostic;
mod settings;
mod window_fx;
mod window_snap;

use std::sync::Mutex;
use tauri::Manager;

use logging::LogFileLock;

fn main() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(LogFileLock(Mutex::new(())))
        .setup(|app| {
            let window = auth_popup::create_main_window(app)?;
            // The config is declaratively frameless; repeat the setting while
            // hidden for runtimes that cache an older generated config. A
            // failure is logged but is not allowed to reintroduce a native
            // frame because the builder already requested decorations=false.
            if let Err(error) = window.set_decorations(false) {
                eprintln!("Unable to confirm frameless window: {error}");
            }

            let appearance = settings::load_startup_appearance(app.handle());
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
            window.show()?;
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
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window_snap::on_window_destroyed(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::get_developer_token,
            music_diagnostic::open_music_diagnostic,
            settings::load_settings,
            settings::save_settings,
            settings::reset_settings,
            logging::append_local_log,
            logging::get_log_dir,
            logging::clear_logs,
            window_fx::set_window_fx,
            window_fx::supports_window_fx,
            window_snap::set_snap_overlay_bounds,
        ])
        .run(tauri::generate_context!())
        .expect("failed to initialize Arlet");
}
