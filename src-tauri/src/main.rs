#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod logging;
mod settings;
mod window_fx;

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
            let window = app.get_webview_window("main");
            if let Some(ref win) = window {
                let _ = window_fx::apply_mica(win, true);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            settings::load_settings,
            settings::save_settings,
            settings::reset_settings,
            logging::append_local_log,
            logging::get_log_dir,
            logging::clear_logs,
            window_fx::set_window_fx,
            window_fx::supports_window_fx,
        ])
        .run(tauri::generate_context!())
        .expect("failed to initialize Arlet");
}
