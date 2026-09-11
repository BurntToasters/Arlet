# MusicKit + Tauri v2 Feasibility Report

> **Status:** PENDING — protected-playback matrix not yet run (no developer token on this machine)
> Environment lines below captured 2026-09-11 from `npm run phase0:preflight` / this Windows host. Authorization, playback, lifecycle, and recovery checkboxes stay unchecked until a subscriber run.

## Environment

| Property              | Value |
|-----------------------|-------|
| Windows Build         | 25H2 build 26200.9445 |
| Architecture          | x64 (fill native `get_app_info.arch` from the app log if ARM64) |
| WebView2 Version      | 152.0.4191.66 (Evergreen registry) |
| Tauri Version         | (fill from Phase 0 diagnostics log: `Tauri …`) |
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

(Document any failures with exact error messages, console output, and steps)

## Recommendation

- [ ] **PASS** — Proceed to Milestone 1
- [ ] **FAIL** — Document in detail, evaluate CastLabs Electron
