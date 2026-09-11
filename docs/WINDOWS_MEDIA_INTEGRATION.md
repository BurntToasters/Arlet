# Windows Media Integration

> **Status:** Deferred to Milestone 4. No Rust media module exists yet, on
> purpose: System Media Transport Controls integration is built after the
> Phase 0 playback gate passes and playback is productized, so the work
> cannot be invalidated by a shell change (see `plan.md` section 25).

## Target design (from `plan.md` sections 11.2 and 12)

A narrow Rust adapter (`src-tauri/src/windows/media_controls.rs`) bridges the
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

## Test surfaces

Standard keyboard media keys, Bluetooth headset controls, the Windows volume
flyout/system media surface, lock/unlock, and minimized-app playback.
