fn main() {
    if let Ok(output) = std::process::Command::new("rustc").arg("-V").output() {
        if output.status.success() {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            println!("cargo:rustc-env=ARLET_RUSTC_VERSION={version}");
        }
    }

    const COMMANDS: &[&str] = &[
        "get_app_info",
        "get_developer_token",
        "open_music_diagnostic",
        "load_settings",
        "save_settings",
        "reset_settings",
        "append_local_log",
        "get_log_dir",
        "clear_logs",
        "set_window_fx",
        "supports_window_fx",
        "set_snap_overlay_bounds",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build Tauri application metadata");
}
