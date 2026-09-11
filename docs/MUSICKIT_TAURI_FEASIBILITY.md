# MusicKit + Tauri v2 Feasibility Report

> **Status:** PENDING — Phase 0 testing not yet started

## Environment

| Property              | Value             |
|-----------------------|-------------------|
| Windows Build         | (fill after test) |
| Architecture          | x64               |
| WebView2 Version      | (fill after test) |
| Tauri Version         | (fill after test) |
| MusicKit JS Version   | v3                |
| Node Version          | (fill after test) |
| Rust Toolchain        | (fill after test) |

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
