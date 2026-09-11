# MusicKit + Tauri v2 Feasibility Report

> **Status:** PENDING — MusicKit matrix not run (no developer token). Diagnostic webview **did** load Apple's site in Evergreen WebView2 (2026-09-11 screenshot). Subscriber playback still unproven.

## Environment

| Property              | Value |
|-----------------------|-------|
| Windows Build         | 25H2 build 26200.9445 |
| Architecture          | x64 (fill native `get_app_info.arch` from the app log if ARM64) |
| WebView2 Version      | 152.0.4191.66 (Evergreen registry) |
| Tauri Version         | 2.11.5 (Cargo.lock) |
| App Version           | 0.1.0 |
| MusicKit JS Version   | v3 |
| Node Version          | v24.20.0 |
| npm Version           | 12.0.2 |
| Rust Toolchain        | stable (`rust-toolchain.toml`) |
| rustc                 | rustc 1.98.1 (48a229cea 2026-09-01) |

## Authorization

- [ ] MusicKit initializes without errors
- [ ] Apple authorization popup appears
- [ ] Authorization completes successfully
- [ ] Music User Token is obtained
- [ ] Session persists across page reload
- [ ] Logout clears session
- [ ] Re-login after logout works

## Playback

- [ ] Full protected track plays (not just 30s preview)
- [ ] Audio output is correct
- [ ] Seek within track works
- [ ] Pause/resume works
- [ ] Skip to next track works
- [ ] Skip to previous track works
- [ ] Volume control works
- [ ] 20+ consecutive tracks play without failure
- [ ] Two-hour continuous session stable

## Window Lifecycle

- [ ] App minimize/restore: playback continues
- [ ] Lock/unlock Windows: playback recovers
- [ ] Change default audio output device: playback continues
- [ ] Alt-tab away and back: no issues

## Error Recovery

- [ ] Network interruption: error surfaced, recovery possible
- [ ] Invalid/expired token: clear error state
- [ ] Restart app: expected session behavior

## Observed Failures

- **Main window / MusicKit JS (2026-09-11):** `MusicKit: failed — MUSICKIT_DEVELOPER_TOKEN is not available. Copy .env.example to .env and run npm run tauri:dev.` Expected until a developer JWT is in `.env`. This is not a DRM result.

## Diagnostic webview (`music.apple.com`)

Plan §4.3 probe — **does not use** `MUSICKIT_DEVELOPER_TOKEN`. Needs a paid
Apple Music Apple ID in the unprivileged window (button: **Open
music.apple.com diagnostic**). Record whether WebView2 can play full
subscriber audio on Apple's own site vs MusicKit JS in the main window.

- [x] Diagnostic window opens and loads `https://music.apple.com/`
      (2026-09-11: title `Arlet — music.apple.com diagnostic (unprivileged)`;
      Apple Music web chrome rendered — Search/Home/New/Radio, Now rail,
      trial banner, **Sign in**). Zero Tauri privileges on that window.
- [ ] Apple ID sign-in completes in that window
- [ ] Full catalog track plays in the diagnostic window (not 30s preview)
- [ ] MusicKit JS path preview-vs-full label in the main window matches what you hear

## Recommendation

- [ ] **PASS** — Proceed to Milestone 1
- [ ] **FAIL** — Document in detail, evaluate CastLabs Electron
