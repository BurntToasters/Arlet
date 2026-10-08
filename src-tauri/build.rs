#[allow(dead_code)]
#[path = "src/token_policy.rs"]
mod token_policy;

/// Release builds compile the MusicKit developer token from the build
/// machine's environment (`.env` via dotenv). Never print the token.
fn embed_release_token() {
    println!("cargo:rerun-if-env-changed={}", token_policy::TOKEN_ENV);
    println!(
        "cargo:rerun-if-env-changed={}",
        token_policy::SKIP_EMBED_ENV
    );
    if std::env::var("PROFILE").as_deref() != Ok("release") {
        return;
    }
    if std::env::var(token_policy::SKIP_EMBED_ENV).as_deref() == Ok("1") {
        println!(
            "cargo:warning={}=1: release binary has no MusicKit token and cannot play music.",
            token_policy::SKIP_EMBED_ENV
        );
        return;
    }
    let token = std::env::var(token_policy::TOKEN_ENV).unwrap_or_default();
    let token = token.trim();
    if token.is_empty() {
        panic!(
            "Release builds require {} (run through dotenv with the production .env). \
             Set {}=1 only for unpublished smoke builds.",
            token_policy::TOKEN_ENV,
            token_policy::SKIP_EMBED_ENV
        );
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before 1970")
        .as_secs();
    let check = token_policy::validate_for_embed(token, now)
        .unwrap_or_else(|error| panic!("Refusing to embed MusicKit token: {error}"));
    println!(
        "cargo:rustc-env={}={token}",
        token_policy::EMBEDDED_TOKEN_ENV
    );
    println!(
        "cargo:warning=Embedded MusicKit developer token; expires in {} days.",
        check.exp.saturating_sub(now) / 86_400
    );
    if !check.origin_restricted {
        println!(
            "cargo:warning=MusicKit token has no origin claim; mint it with MUSICKIT_TOKEN_ORIGINS={} so a leaked token is refused on other web origins.",
            token_policy::RELEASE_ORIGIN
        );
    }
}

fn main() {
    embed_release_token();
    if let Ok(output) = std::process::Command::new("rustc").arg("-V").output() {
        if output.status.success() {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            println!("cargo:rustc-env=ARLET_RUSTC_VERSION={version}");
        }
    }

    const COMMANDS: &[&str] = &[
        "get_app_info",
        "get_developer_token",
        "get_beta_updater_target",
        "open_music_diagnostic",
        "load_settings",
        "save_settings",
        "reset_settings",
        "load_pins",
        "save_pins",
        "delete_pins",
        "append_local_log",
        "get_log_dir",
        "clear_logs",
        "library_cache_read_page",
        "library_cache_read_section",
        "library_cache_write_page",
        "library_cache_clear_section",
        "library_cache_set_meta",
        "library_cache_get_meta",
        "library_cache_clear",
        "set_window_fx",
        "supports_window_fx",
        "set_snap_overlay_bounds",
        "update_windows_media_session",
        "update_windows_media_timeline",
        "clear_windows_media_session",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(
                tauri_build::WindowsAttributes::new()
                    .app_manifest(include_str!("windows-app.manifest")),
            )
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build Tauri application metadata");
}
