# Windows Media Integration

Arlet uses Windows System Media Transport Controls (SMTC) on Windows 10
22H2 (build 19045) and newer, including Windows 11.

## Target design (from `plan.md` sections 11.2 and 12)

A narrow Rust adapter (`src-tauri/src/windows_media.rs`) bridges the
frontend and Windows SMTC. The frontend stays the source of truth for
MusicKit playback; Rust never owns a second playback state machine.

```text
frontend normalized state ──command/event──▶ Rust WindowsMediaSession ──WinRT──▶ SMTC
hardware key / system command ──▶ Rust ──event──▶ PlaybackController ──▶ MusicKit player
```

## Required behaviors (acceptance for Milestone 4)

- System Play resumes MusicKit; Pause pauses; Next/Previous follow the app queue.
- Now-playing metadata (title, artist, album, artwork) updates quickly on
  track transition; stale artwork is cleared on logout/stop.
- Hardware media keys work while the app is unfocused.
- App volume and system media state do not fight each other.
- Repeat and shuffle remain MusicKit-owned and are not emulated by native
  controls.

Supported system actions:

- Play and Pause
- Next and Previous
- Track title, artist, album, and HTTPS artwork
- Playing, paused, and stopped status

Arlet clears SMTC metadata and artwork when playback stops, the current track
is removed, the user signs out, or the native window is destroyed. Artwork is
best effort; text metadata remains visible when artwork cannot load.

The NSIS installer rejects Windows builds below 19045. Direct executable
launches use the same native build guard before WebView2 creation.

## Test surfaces

Standard keyboard media keys, Bluetooth headset controls, the Windows volume
flyout/system media surface, lock/unlock, and minimized-app playback.
