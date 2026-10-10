# Windows Media Integration

Arlet uses Windows System Media Transport Controls (SMTC) on Windows 10
22H2 (build 19045) and newer, including Windows 11.

## Target design (from `docs/history/plan.md` sections 11.2 and 12)

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
- Repeat and shuffle remain MusicKit-owned. Native requests are sent to
  MusicKit, and SMTC shows the state MusicKit reports back.

Supported system actions:

- Play and Pause
- Next and Previous
- Seek from the timeline (`PlaybackPositionChangeRequested`)
- Shuffle and repeat requests (`ShuffleEnabledChangeRequested`,
  `AutoRepeatModeChangeRequested`)
- Track title, artist, album, and HTTPS artwork
- Playing, paused, and stopped status

Event contract (Rust emits, `src/app/App.tsx` routes):

| Event                   | Payload                             | Frontend action                               |
| ----------------------- | ----------------------------------- | --------------------------------------------- |
| `windows-media-control` | `play`, `pause`, `next`, `previous` | play, pause, next, previous                   |
| `windows-media-seek`    | seconds                             | `controller.seek`, clamped to `[0, duration]` |
| `windows-media-shuffle` | boolean                             | `controller.setShuffleMode`                   |
| `windows-media-repeat`  | `off`, `all`, `one`                 | `controller.setRepeatMode`                    |

Rust drops seek requests that are negative, non-finite, or arrive before a
timeline has published a duration. The frontend drops them again, and ignores
every event until MusicKit is ready. Shuffle and repeat go out through the
payload (`shuffle`, `repeat`), read from MusicKit state.

Seek availability comes from the timeline's min and max seek range, which
Arlet publishes with each timeline update. The `windows` 0.62 bindings expose
no separate "playback position enabled" or repeat/shuffle capability setter,
so none is set. Whether Windows shows the scrubber and shuffle/repeat buttons
on a given build is verified only on hardware (see `docs/TESTING.md`).

The tray's Play/Pause item emits the same `windows-media-control` event, with
`pause` while playing and `play` otherwise, so one frontend path handles both.

The `trayIcon` setting (on by default) shows the tray icon and makes closing
the main window hide it instead of quitting. Left-clicking the icon shows or
hides the window, right-click opens the menu, and a second launch shows the
window too. Tray Quit saves the window geometry before exiting. With the
setting off there is no icon and closing the window quits.

Arlet clears SMTC metadata and artwork when playback stops, the current track
is removed, the user signs out, or the native window is destroyed. Artwork is
best effort; text metadata remains visible when artwork cannot load.

The NSIS installer rejects Windows builds below 19045. Direct executable
launches use the same native build guard before WebView2 creation.

## Test surfaces

Standard keyboard media keys, Bluetooth headset controls, the Windows volume
flyout/system media surface, lock/unlock, and minimized-app playback.
