fn main() {
    const COMMANDS: &[&str] = &[
        "get_app_info",
        "load_settings",
        "save_settings",
        "reset_settings",
        "append_local_log",
        "get_log_dir",
        "clear_logs",
        "set_window_fx",
        "supports_window_fx",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build Tauri application metadata");
}
