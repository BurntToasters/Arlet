# Testing Boundaries

## Offline application smoke

`npm run test:e2e` is an offline smoke gate for the production frontend. It
builds the Vite output, confirms that `dist/index.html` references the local
entrypoint and stylesheet, and checks the emitted bundle for the native
diagnostics, updater target, startup-check, and update-modal paths. It also
checks the source-level startup order: persisted settings load, MusicKit
initialization, and then the startup updater check.

This gate does not open Tauri, authorize Apple Music, download an update, or
contact a release service. It therefore does not prove that protected playback
works, that an Apple account can authorize, or that a live updater feed is
reachable.

## Native app E2E

`npm run test:e2e:app` (Windows only, opt-in) builds a release binary into
`src-tauri/target/e2e` with a synthetic MusicKit token, moves the per-user
Arlet data folders aside, launches the app with WebView2 remote debugging, and
drives it over the DevTools Protocol. It restores the data folders afterwards
and writes `e2e-artifacts/<timestamp>/report.json` (binary SHA-256, commit,
per-check results), `screenshot.png`, and the run's `arlet.log`. Close every
running Arlet first; the app is single-instance. `--skip-build` reuses the
last E2E binary.

Failure modes it covers:

1. A release build cannot embed the token, or serves the runtime env instead.
2. The window never renders its shell.
3. A corrupt `settings.json` silently resets preferences (backup ignored).
4. A long multibyte log entry panics and aborts the process.
5. Music User Tokens reach the log file unredacted.
6. The registry Windows-build lookup or media-session commands fail.
7. Removed plugins (`dialog`, `notification`) are still reachable.
8. The app does not run on `http://tauri.localhost`, so origin-scoped
   tokens would break.
9. A cache written by the former SQL plugin is lost on upgrade, the fixed
   cache commands fail, or the generic SQL plugin is still reachable.
10. The open-source licenses dialog is empty.
11. With Apple's CDN unreachable, the cached library is not shown.
12. A renderer crash leaves a blank window.

It also writes `screenshot-offline.png`. CI runs this gate on Windows x64 and
uploads the report as the `e2e-report` artifact.

`npm run test:e2e:app:real` embeds the real `MUSICKIT_DEVELOPER_TOKEN` from
`.env` instead and adds a check that Apple's catalog API accepts it from the
release origin and that it carries no `origin` claim. That proves the token
on this machine; `release:preflight` checks the release VM's token against
Apple separately. Library (`/v1/me`) requests need a signed-in user, so
confirm them by hand on an installed build.
The E2E binary then contains that token; it stays in `src-tauri/target/e2e`.

It does not sign in to Apple Music or play protected audio.

## Song navigation and playlist playback

The native E2E gate also reloads the production frontend with a deterministic
MusicKit fixture injected through WebView2 DevTools. The application still
uses its real components, controller, request adapter, router, and playback
event handlers. The fixture replaces the external provider only; it does not
prove protected Apple Music audio playback.

Failure scenarios to cover before changing production code:

- A song title opens the wrong album or single, or navigation interrupts playback.
- Multiple artists collapse into one destination, or punctuation in an artist
  name creates invented artists.
- Catalog and library IDs use the wrong route or lookup endpoint; absent
  relationships cause guessed links, repeated requests, or an unhandled error.
- A late lookup changes a newer song's links or a closed/replaced context menu.
- Player links or context-menu actions cannot be reached by keyboard.
- Starting a middle playlist row queues only that song or discards earlier
  songs from shuffle; duplicate occurrences select the wrong position.
- Playback stops after the selected song, queue display disagrees with the
  provider, or next/previous and repeat settings change unexpectedly.
- Playlist pagination is truncated, loops forever, or replaces a working queue
  after a page request fails.
- Context-menu Play now loses playlist context; Play next or Play later adds
  the entire playlist instead of the selected song.

The report records the fixture seed and per-scenario results. Additional
artifacts retain navigation/playback screenshots and provider queue transitions
so the fixture run is repeatable and auditable. Run `npm run test:e2e:app` on
Windows with every existing Arlet instance closed. A separate signed-in check
must confirm real track completion, shuffle, and repeat on Apple Music.

## Playback correctness

Failure scenarios to cover before changing production code:

- A playback error badge outlives a later successful play.
- Choosing a row in `Playing Next` drops earlier songs, breaks Previous, or
  reorders a shuffled queue.
- A failed repeat or queue action is silent.
- A library-only song (no catalog ID) leaves the `songs` descriptor, which
  MusicKit's item loader resolves through `/v1/me/library/songs`.
- With shuffle on, the chosen song does not play first (MusicKit shuffles on
  `setQueue`; the start must be passed as `startWith`).
- Shuffle state is read from the write-only `shuffle` property instead of
  `shuffleMode`, so the button and Shuffle play misreport.
- The Play button gives no feedback while a long playlist's pages load.
- A keyboard shortcut calls a stale controller after the controller changes.

## Keyboard and transport

- Shortcuts fire while typing in search, a text field, or a dialog.
- Space activates a focused button twice (click plus shortcut).
- Arrow keys on a focused slider are hijacked.
- Alt+arrow history navigation stops working.
- Mute writes volume 0 to `settings.json`, or unmute restores the wrong level.
- Shuffle play starts the same song every time or leaves shuffle off.

## Queue editing

- Removing or reordering upcoming songs interrupts or restarts the current song.
- Indexes go off by one when the queue has duplicate songs.
- Editing while shuffle is on corrupts the order.
- A provider queue event during an edit is overwritten by a stale snapshot.
- `Clear` stops the current song; history rows become editable.
- A 600-song queue freezes the drawer.

## Ratings and library

- A ratings request uses the wrong ID kind (library vs catalog path).
- An optimistic Love stays set after the request fails.
- Fast repeated clicks race and leave the wrong final rating.
- A late rating response is shown for a newer track.
- Add to Library duplicates an item or calls the wrong endpoint.
- Mutating requests (PUT/POST/DELETE) are retried.

## Now Playing

- The overlay steals focus, traps it forever, or Esc does not close it.
- Transport keys stop working while the overlay is open.
- Up Next shows history or the current song, or choosing a row drops the
  songs before it.
- Seeking from the overlay does not reach MusicKit.

## Desktop controls

- A seek from Windows media controls outside the timeline, or NaN, reaches
  MusicKit.
- Windows shows a shuffle or repeat state that disagrees with MusicKit.
- A media-control event arrives before the controller exists.
- The sleep timer fires after sign-out or after it was cancelled.
- `End of track` lets the next song play audibly, or never fires at queue end.
- Autoplay is offered when the runtime does not support it, or the setting is
  saved even though the runtime rejected it.

## Tray

The `trayIcon` setting (on by default) controls the icon and closing together:
on, closing the window hides Arlet to the tray; off, there is no icon and
closing the window quits.

- Quit from the tray skips saving the window state.
- With the tray on, the app becomes impossible to quit, or the reset-settings
  restart hides instead of restarting.
- With the tray off, closing the window hides it with no icon to bring it back.
- Turning the tray off leaves a stale icon, or turning it on adds a duplicate.
- A duplicate tray icon appears after a WebView2 recovery.
- Left-click does not toggle the window (show when hidden or minimized, hide
  when shown).
- Tray commands arrive before the frontend listens.
- A second launch does not show a window hidden in the tray.
- A missing or non-boolean `trayIcon` value disables the tray instead of
  using the default.

## Session restore

- A corrupt or oversized session file blocks startup.
- Restore starts playback by itself.
- Restore runs before sign-in, or for a different account after sign-out.
- Restore delays the startup update check.
- A saved position beyond the song duration, or library IDs that no longer
  exist, break playback.
- Saving on every position tick thrashes the disk.

## Radio and artist pages

- Start Station on a library song with no catalog ID, or an artist with none,
  throws instead of reporting that no station is available.
- A station lookup that finishes after the user started something else
  replaces the newer playback.
- Play next or Play later on an album or playlist queues only the first page,
  the wrong order, or interrupts the current song.
- Artist top songs for a library artist call the catalog with a library ID.
- Top songs from a previous artist flash on the next artist page.
- The shortcut list in Settings drifts from the real key handling.

## Release-only evidence

The following checks require a Windows release environment and are kept out of
the deterministic smoke gate:

- Azure Artifact Signing credentials and the signing client are required to
  prove Authenticode signatures on x64 and ARM64 installers.
- A real signed x64 and ARM64 canary installer is required to prove install,
  restart, architecture selection, and rollback behavior.
- A published, signed updater manifest and its installer/signature sidecar are
  required to prove the live stable or beta feed. Use the existing read-only
  release verification commands after publishing; they must not be replaced by
  provider-account fixtures.
- Apple developer-token/account credentials are required for the manual
  MusicKit authorization and protected full-track playback matrix.
- The Windows SMTC flyout and hardware media keys need a real desktop: the
  timeline seek, shuffle and repeat buttons (and whether Windows shows them),
  and Play, Pause, Next, and Previous with the app unfocused or minimized.
  The E2E harness covers the frontend routing of these events only.
- The tray menu needs a real desktop: Play/Pause, Next, Previous, Show Arlet,
  and Quit (Quit must save the window geometry, then exit). Left-click shows
  or hides the window, and turning `Show tray icon` off removes the icon. The
  E2E harness covers closing with the tray on and off, the setting toggle, and
  the second launch only.
- `End of track` pauses at the next item change, so a brief bleed of the next
  song may be audible on MusicKit before the pause lands. Listen for it on
  protected and unprotected tracks.
- A signed-in Apple Music account is required for the 0.2.0 behavior the
  fixture only models from MusicKit's documented and bundled shapes:
  - Starting a song mid-playlist with shuffle on plays that song first
    (`setQueue` `startWith`), and the shuffle button reflects `shuffleMode`.
  - Queue remove, move, and clear use `Queue.splice` without restarting audio.
  - A library-only (uploaded) song plays from the `songs` descriptor.
  - Love, Dislike, clear, and Add to Library reach Apple (check the Music app).
  - Autoplay continues after the queue ends when enabled.
  - `Start Station` for a catalog song, a library song, and an artist; Top
    Songs for a library artist.
  - A restored session resumes at the saved song and position.

These external gates are intentionally opt-in and must run only on the release
VM or a test machine with the appropriate credentials and signed artifacts.

`--skip-e2e` remains available for a non-release local diagnostic run, but
`test:all --require-clean-proof --skip-e2e` is rejected so a release quality
proof cannot be created with the built smoke gate omitted.
