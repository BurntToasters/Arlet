# Testing Boundaries

## Offline application smoke

`npm run test:e2e` is an offline smoke gate for the production frontend, not
an end-to-end test of the app; the native suite below is. It
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

`npm run test:e2e:app` (Windows only) builds a release binary into
`src-tauri/target/e2e` with the `e2e` Cargo feature and a synthetic MusicKit
token, launches the app with WebView2 remote debugging, and drives it over the
DevTools Protocol. Every run gets a new marked root under the system temp
folder. The harness passes that exact root through `ARLET_E2E_DATA_ROOT`; Rust
stores app data, local cache, logs, and WebView2 storage in separate children
of it. It does not override `APPDATA` or `LOCALAPPDATA`, move real profiles, or
delete unmarked folders. The E2E binary rejects a missing or invalid root
before startup can use a Known Folder path, and normal release builds ignore
the E2E variable. `--skip-build` requires a SHA-256 proof that the binary was
built with the E2E feature and matching token mode. The proof stores only a
token fingerprint, never the token; synthetic-token runs verify against the
fingerprint from the build because each fresh synthetic token has a new expiry.

The suite writes `e2e-artifacts/<timestamp>/report.json` (binary SHA-256,
commit, startup arguments, process exit/error, and per-check results),
`screenshot.png`, `arlet.log`, `browser-process.log`, and
`webview-diagnostics.json` (WebView2 runtime versions, isolated browser
arguments, and Windows event diagnostics). Close every running Arlet first;
the app is single-instance. `npm run test:all -- --require-clean-proof` (every
release proof) runs this suite on a Windows desktop. Over SSH (the release VM)
WebView2 has no desktop, so the proof records this suite as deferred, not
verified; run `npm run test:e2e:app` at a desktop on the release commit before
publishing.

The previous Windows canary failed before DevTools target discovery because
port 9333 refused connections; the root cause is unverified. The harness now
selects an available loopback port, passes one run-specific WebView2 data
directory through both Tauri and the runtime environment, records child
startup output, and bounds discovery and command deadlines. These changes
make startup deterministic and the failure report useful, but do not establish
the original runner failure's cause.

The foreground monitor must ignore only the invisible Tao dispatcher when its
raw Windows class name is `Tao Thread Event Target` and its extended style includes
`WS_EX_NOACTIVATE`, `WS_EX_TRANSPARENT`, `WS_EX_LAYERED`, and
`WS_EX_TOOLWINDOW`. A generic visible/tool/transparent window remains a
failure. The clipboard restore helper must decode its stdin as UTF-8 without a
BOM: a legacy PowerShell code page can corrupt the expected Unicode report and
make `changed` appear successful while Arlet's report is still on the
clipboard. A `changed` result is valid only after the helper confirms the
report is no longer current; a successful restore also verifies the text after
writing it.

The app launches in the background, so a run does not interrupt whoever is
using the PC. `ARLET_E2E_BACKGROUND=1` (`src-tauri/src/background_launch.rs`)
builds the window not focusable, strips activation from every position
change, and keeps it at the bottom of the z-order, which also drops
always-on-top and keeps full-screen tests out of sight. The tray handoff does
not call `set_focus`, whose Alt-key workaround would take the foreground. The
page gets DevTools focus emulation and WebView2 switches that stop throttling
a covered window. `scripts/e2e-foreground.js` samples the foreground window
every 250 ms and writes `foreground.json`. The check fails if Arlet was ever
the active window or a sized Arlet window overlapped the active one from
above. When the desktop itself is active (explorer's `Progman` or `WorkerW`),
every window sits above it, so those samples only check that Arlet did not
activate; `foreground.json` counts them as `desktopSamples`. A File Explorer
window (`CabinetWClass`) is an ordinary app and is still checked for
covering. `--foreground` opts out (no flag, no monitor).

After each run, older `e2e-artifacts/<timestamp>` folders are pruned so only
the newest 20 (the current run included) remain. Set `ARLET_E2E_KEEP_RUNS` to
change that count; `0` keeps every folder. Only direct children whose names
match the script's timestamp format are deleted, never symlinks or junctions,
files, the current run, or other folders such as `audit-*`. The number pruned
is logged, and a pruning failure is logged as a warning without failing the run.

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
9. A cache written by the former SQL plugin is lost on upgrade, is not moved
   from the roaming config folder to local app data, the fixed cache commands
   fail, or the generic SQL plugin is still reachable.
10. The open-source licenses dialog is empty.
11. With Apple's CDN unreachable, the cached library is not shown, or the
    connection returning (an `online` event) does not reload to retry.
12. A renderer crash leaves a blank window, or leaves no line in `arlet.log`.
    A renderer or browser process exit that Arlet must recover from is
    written even with Debug Mode off. Failures WebView2 recovers from by
    itself (utility, GPU, and frame processes) are written only with Debug
    Mode on.

The saved-settings reset/restart and legacy-cache migration run entirely
inside the isolated root. Cleanup validates its absolute path and ownership
marker, removes it only after the E2E app exits, and never kills another
`arlet.exe`. A handled setup or test failure still writes the report and
attempts cleanup. A hard kill can leave only that run's marked temp profile;
it cannot move or alter the real Arlet profile.

The account-session scenario separately rejects `library_cache_clear`,
`delete_pins`, and `delete_playback_session`, reloads the app, and verifies the
previous library, pins, and queue remain hidden behind the durable account
fence. In the marked test data directory, `e2e-account-clear-fault.json` holds
exactly `{"command":"library_cache_clear"}`,
`{"command":"delete_pins"}`, or
`{"command":"delete_playback_session"}`. A missing file means no fault;
malformed or unreadable controls are rejected. The test-only IPC boundary
records `{atUnixMs,command,outcome}` lines in
`e2e-account-clear-trace.jsonl` (`success`, `failure`,
`injected_failure`, or `invalid_control`), capped at 64 KiB and 128 rows. The
scenario injects each rejection independently, waits for all three clear
calls to settle, and checks that only the rejected data category remains
fenced. It then reloads with the fault still in place. Startup retries the
clear for each fenced category, so the trace shows `injected_failure`, the
fence stays, and the previous data stays hidden. The fault file is then
removed and the app reloads again. The startup retry succeeds, the fence is
lifted, and the previous data still stays hidden. The fault file is removed in
a `finally`, so a failed check cannot leak it into later suites. The run saves
one sign-out trace per category (`account-clear-<category>.jsonl`) and one
restart trace per category (`account-clear-<category>-restart.jsonl`).

For a focused diagnostic run, use
`npm run test:e2e:app -- --skip-build --scenarios flows,discovery,account-session`
after a matching E2E-feature build is available. `--scenarios` accepts only
registered names and rejects unknown or repeated names before the harness
builds or launches Arlet. The report records `selectedScenarios` and
`fullSuite: false`; focused runs are useful for diagnosis and are never release
proof. Omitting the option runs every registered scenario and records
`fullSuite: true`. Both modes retain the isolated profile setup, startup
diagnostics, tray/quit checks, process verification, and cleanup.

After each native scenario the runner records one check, `<name> leaves the
app ready for the next scenario`. It fails when the app is signed out (except
`session-restore`, which signs out on purpose), shows the mini player instead
of the shell, or still has a fixture hold, delay, or rejection set. The runner
then restores those fixture controls to defaults but does not repair app state,
so the failing check names the scenario that leaked.

It also writes `screenshot-offline.png`. CI runs this gate on Windows x64 and
uploads the report as the `e2e-report` artifact.

`npm run test:e2e:app:real` embeds the real `MUSICKIT_DEVELOPER_TOKEN` from
`.env` instead and adds a check that Apple's catalog API accepts it from the
release origin and that it carries no `origin` claim. That proves the token
on this machine; `release:preflight` checks the release VM's token against
Apple separately. Library (`/v1/me`) requests need a signed-in user, so
confirm them by hand on an installed build.

Release token age:

- The weekly canary warns 150 days after the latest stable release, assuming
  its token was freshly minted for 180 days. A release built with an older
  pasted token (30 days left passes the build) stops playback for everyone
  before the canary warns. `release:preflight` now requires 150 days left.
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
- A playlist that changed after its page was shown (a song added at the top
  on another device) starts a different song than the row clicked, because
  playback reloads the playlist and plays by position.
- Clicking a song in Library › Songs queues only that song, so the rest of
  the list does not follow it.

The report records the fixture seed and per-scenario results. Additional
artifacts retain navigation/playback screenshots and provider queue transitions
so the fixture run is repeatable and auditable. Run `npm run test:e2e:app` on
Windows with every existing Arlet instance closed. A separate signed-in check
must confirm real track completion, shuffle, and repeat on Apple Music.

## Playback correctness

Failure scenarios to cover before changing production code:

- A playback error badge outlives a later successful play.
- Choosing a row in `Playing Next` drops earlier songs, breaks Previous, or
  reorders a shuffled queue. Opening `Playing Next` on a parked queue leaves
  the current row out of view.
- A failed repeat or queue action is silent.
- After a Play from mid-album, Repeat All at the end of the last song goes
  back to the chosen song instead of the album's first song, and Repeat One
  then repeats a different song.
- A library-only song (no catalog ID) leaves the `songs` descriptor, which
  MusicKit's item loader resolves through `/v1/me/library/songs`.
- With shuffle on, the chosen song does not play first (MusicKit shuffles on
  `setQueue`; the start must be passed as `startWith`).
- Shuffle state is read from the write-only `shuffle` property instead of
  `shuffleMode`, so the button and Shuffle play misreport.
- Turning shuffle on mid-song shows a different song's title and artist:
  MusicKit reorders the queue and publishes `queueItemsDidChange` before it
  moves the queue position, so the old position names another song.
- The Play button gives no feedback while a long playlist's pages load.
- A keyboard shortcut calls a stale controller after the controller changes.

## Unavailable songs

MusicKit's item loader rejects the whole `setQueue`, `playNext`, or
`playLater` call with `NOT_FOUND` ("One or more items could not be resolved")
when any catalog ID is missing, and it silently drops songs that resolve but
are not playable. Failure scenarios:

- A song MusicKit took as song details (no lookup) but could not start is
  queued again by ID, and that retry hits an unresolved ID: the Play fails
  instead of skipping the song (or retrying a library song by its library
  ID), as the first queue setup would.
- Rebuilding the queue from a chosen row (runtimes without
  `changeToMediaAtIndex`) fails on one unresolved song instead of dropping it.
- Background top-ups and Play Next/Later queue by ID, so MusicKit looks up
  every added song (one Apple request per 16). Details are tried first; a
  rejected details call falls back to IDs once.

- One removed or temporarily unavailable song stops a whole playlist or album
  from playing.
- The chosen song does not play first after unavailable songs are skipped, or
  a different song plays because skipped songs shifted the start index.
- Skipping the chosen song itself fails instead of starting the next
  available one.
- A library song whose catalog copy was removed is skipped even though its
  library copy can still play.
- A playlist where every song is unavailable loops or shows a raw error.
- `Play next` or `Play later` adds nothing because one song is unavailable.
- `Play next` or `Play later` pressed while a Play is still replacing the
  provider queue lands in the queue being replaced, so the next Play drops it.
  (Covered by `unavailable`: the fixture holds `setQueue`, the menu inserts
  during the hold, and the provider queue must show the inserted songs right
  after the new Play's active song, in order.)
- The user is not told that songs were skipped.
- A song that fails when it starts playing (content unavailable, restricted,
  unsupported) stops the queue instead of skipping to the next song.
- Auto-skip loops through the whole queue, or skips on account-wide failures
  (subscription, sign-in, DRM licence, device limit) that every song shares.
- A song that is not streamable looks normal in lists, or a playable song is
  greyed out.
- Queueing a very large playlist sends hundreds of parallel requests, hits
  Apple's rate limit, and plays nothing; shuffle of a large playlist only
  ever draws from the songs near the chosen one.
- A playlist or album page lists only its first page of songs (100) instead
  of every song; later pages loop on a repeated cursor, replace a newer
  playlist's rows, or block the first page from rendering.
- Revisiting a long playlist collapses the cached full list to its first page
  and jumps the scroll, or a cache write is rejected for exceeding the native
  10,000-entry page limit.
- Background queue refills show "skipped" toasts the user did not ask for.
- A capped queue ends after its first window instead of loading the rest of
  the playlist as it plays; a refill fires twice, refills after a new play or
  `Clear`, or interrupts the current song.
- Play on a large playlist waits for every page and queues hundreds of songs
  before any audio (a 1124-song playlist took over 10 seconds, and the
  ~32 parallel lookups for a 500-song queue sometimes failed with "Unable to
  read body as JSON"). Play must start after the chosen song's page with a
  first window of at most 100 songs; later pages join the continuation in
  the background and are dropped if the queue is replaced.
- A song lookup that fails once with an unreadable body fails the whole Play
  instead of being retried.
- A mid-playlist click queues songs before the clicked one and then
  re-selects it, so MusicKit prepares one song and switches to another (about
  1.3 seconds in a real log). MusicKit's queue must start at the clicked song.
- The first `setQueue` holds more than one lookup's worth (16) of songs.
- The wrong duplicate occurrence plays when a playlist lists a song twice.
- Previous on the first queued song restarts it instead of going to the song
  before it in the playlist, or steps back into a queue that was replaced.
- The rest of the playlist is not appended once the first song starts, or is
  appended twice.
- A first batch whose songs are all unavailable fails the Play although later
  songs can play.
- A new Play keeps showing the previous song's position until MusicKit's
  first time event, so Previous pressed right away restarts the new song
  instead of stepping back.
- With shuffle already on, clicking a row in a large playlist starts after its
  first pages, so the shuffle only draws from the start of the playlist.
- A collection Play that a newer Play replaced while it was starting still
  appends its later pages to the newer queue. (Code-reviewed: the later pages
  carry the token their own Play returned; the race is not driven here.)

`unavailable` also drives queue-integrity failures around a parked or
restored queue. A failed Play must leave the parked queue's songs, index,
seek position, and saved `playback-session.json` untouched, and the retry
must start the same queue; a failed station Play must leave no station label
for a later stream handoff. Both are checked with the fixture's held and
rejected `setQueue`, and the saved file is read directly.

The same scenario checks the insert-versus-setup race: a `Play next` pressed
while a Play is still replacing the provider queue must queue into the new
queue, in order, not the queue being replaced. The fixture holds `setQueue`
for the new Play, the album's menu item is clicked during the hold, then the
hold is released; the provider queue must show the album's songs directly
after the new Play's active song. Queue setup is tracked in the playback
session (`queueSetup`/`queueSetupGeneration`), and inserts wait for it before
planning, then abort their writes if a newer setup starts.

## Layout

- A horizontal scrollbar appears in the player or content area.
- Long pinned playlist names wrap into tall blocks in the sidebar and push
  the account row under the player bar instead of ending in an ellipsis.
- A pinned playlist that is not in the loaded playlist list shows as a
  generic "Playlist" until it is opened. Its name is now saved with the pin.
- A playlist with a large cover image pushes its title, Play all, and
  Shuffle out of the header to the far right (the art's wrapper took the
  image's natural width).
- An album, playlist or curator hero backdrop pushes the copy or actions out
  of the header, or adds horizontal overflow.
- An artist page matches `img.detail-hero-backdrop` instead of its own
  `artist-hero-banner` / `artist-hero-backdrop` selectors.

## Pinned playlist artwork

`pin-artwork` saves pins and reloads the app, and pins a playlist from its
page while the Library list holds an expired link for it. Apple serves
uploaded playlist covers from signed links (`X-Amz-Date` + `X-Amz-Expires`,
24 hours), so a link saved with a pin goes dead a day later.

- After a restart, a pin whose saved link has expired shows a broken image
  until its playlist is opened.
- The startup lookup skips pins that already have a name, so an expired link
  is never replaced.
- The fresh link is shown but not saved, so the next restart breaks again.
- Pins whose saved link is still valid are looked up again on every start.
- An image that fails to load for any other reason shows the browser's
  broken-image glyph instead of the playlist icon.
- Pinning while the Library list holds an expired link saves the name but no
  cover, so the pin is never looked up again and shows the icon for good.
- A playlist whose custom cover was removed keeps its dead saved link, so its
  pin is looked up again on every start.
- A lookup that fails or finds no playlist drops the saved link, so a
  network error loses the cover.

## Keyboard and transport

- Shortcuts fire while typing in search, a text field, or a dialog.
- Space activates a focused button twice (click plus shortcut).
- Arrow keys on a focused slider are hijacked.
- Alt+arrow history navigation stops working.
- Mute writes volume 0 to `settings.json`, or unmute restores the wrong level.
- Shuffle play starts the same song every time or leaves shuffle off.

## Seeking

`seek` drives the player-bar slider with real CDP mouse input while the
fixture emits playback ticks, and holds `seekToTime` with
`configure({ holdSeek: true })`.

- A tick between press and release cancels the click, so the song does not
  move (most visible when clicking back).
- A tick yanks the thumb or the time label away from the pointer mid-press or
  mid-drag.
- Dragging seeks more than once, or not to the release point.
- Stale ticks while `seekToTime` is in flight snap the thumb back to the old
  position before it settles.
- An earlier seek that finishes late overrides a newer one.
- A seek in flight for more than 3 seconds lets stale ticks snap the thumb
  back before it finishes.
- A stale tick just after the seek finishes snaps the thumb back.
- A seek that finishes but no tick confirms, or that never finishes, freezes
  the slider instead of following playback again.
- A press whose release never reaches the window (focus lost mid-drag)
  leaves the slider stuck at the pointer instead of following playback.

## Queue editing

- Removing or reordering upcoming songs interrupts or restarts the current song.
- Indexes go off by one when the queue has duplicate songs.
- Editing while shuffle is on corrupts the order.
- A provider queue event during an edit is overwritten by a stale snapshot.
- `Clear` stops the current song; history rows become editable.
- A 600-song queue freezes the drawer.
- Moving a song in Playing Next moves a different song when the queue
  shifted after the user picked it (a sync or top-up); the move must follow
  the song's ID. (Code-reviewed; the existing move checks cover the normal
  path, and the shift itself is not driven here.)
- `Save as playlist` saves only the songs already handed to MusicKit and
  leaves out the rest of a long playlist that the drawer says is coming.
  It now sends the queue in batches: a create carries the first 100 tracks,
  then sequential adds of up to 100 each, and a failed batch stops further
  adds while keeping the songs already saved; the dialog reports how many
  were saved versus how many could not be added.
  `scripts/e2e-save-queue.js` proves it with a 600-song queue: one create
  with the first 100 then sequential adds to 600, a short save that stays a
  single create, and a failed third add that keeps 300 and stops.
- A runtime without the undocumented `Queue.splice` rebuilds the queue for
  every edit (`setQueue`, reselect, seek, resume). Two quick clicks used to
  plan from the same local snapshot, run both rebuilds together, and finish by
  reloading the queue because it changed underneath them. Edits on one
  MusicKit instance now run in order: a pending edit waits for the edit ahead
  to settle, then reads local state and plans, so the second click sees the
  first result. Two Move ups apply in order, and a Move followed by a Remove
  of another row produces the sequential result. The native tier queues the
  same way, but its splices stay immediate.
- A MusicKit call that never settles must not block future edits forever.
  After a generous 20 s watchdog a pending edit abandons the stuck edit,
  reloads the provider queue into local state, and continues. The abandoned
  edit's late completion re-checks the abandoned condition around every await
  and writes no local state (including no error toast for its lost race).
- `scripts/e2e-queue-edit.js` hides `queue.splice` and delays `setQueue`, then
  clicks two Move ups, and separately a Move and a Remove on another row,
  before the first rebuild settles. It checks both provider orders and that no
  queue-reloaded error toast appears. The watchdog is code-reviewed: a 20 s
  hang is too long to drive in the deterministic suite.

## Ratings and library

- A ratings request uses the wrong ID kind (library vs catalog path).
- A queued song whose type says library but whose ID is a catalog ID (as
  MusicKit reports library playlist songs) is looked up on the library path:
  Apple answers 400 for its rating and 404 for its album and artists.
- When Apple names none of a song's artists, the player shows "Artist 1,
  Artist 2" instead of the song's artist text.
- Add to Library gives no confirmation and the item does not appear in
  Library until a manual refresh.
- An optimistic Favorite stays set after the request fails.
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
- The cover's bloom layers are missing, or a backdrop uses a CSS `url()`
  instead of an `<img>`.
- A track without `artwork.url` still renders a bloom `<img>`, so the src is
  empty or broken.
- The ambient bloom keeps drifting while playback is paused.
- The bloom animation still runs under `prefers-reduced-motion: reduce`, or
  the bloom images stay visible under `forced-colors: active`.

## Mini player

- The artwork bloom causes scrollbars at 360x132 or at the 300x120 minimum.
- The mini player paints an opaque background over the native Acrylic/Mica
  effect while the bloom is shown.
- The bloom renders for a track without artwork.
- Leaving the mini player after the normal window's monitor is gone puts the
  window back where that monitor was, out of reach.
- The rescued window opens on another monitor than the mini player's, keeps
  the mini size, or is larger than that monitor's work area.
- A Win32 test helper moves a window that does not belong to the E2E
  process.

Checks in `scripts/e2e-mini-player.js`:

| Check                                                                       | Guards                                       |
| --------------------------------------------------------------------------- | -------------------------------------------- |
| the mini player radiates its artwork over the native window effect          | opaque background; bloom missing; scrollbars |
| the mini player bloom adds no scrollbars at the 300x120 minimum             | bloom overflow at the minimum window size    |
| leaving the mini player after its monitor is gone opens on a monitor in use | off-screen restore; wrong monitor or size    |

## Desktop controls

- A seek from Windows media controls outside the timeline, or NaN, reaches
  MusicKit.
- Windows shows a shuffle or repeat state that disagrees with MusicKit.
- A media-control event arrives before the controller exists.
- The sleep timer fires after sign-out or after it was cancelled.
- The sleep timer menu opens away from its button (an inline style without
  units, which Preact 11 no longer completes).
- `End of track` lets the next song play audibly, or never fires at queue end.
- Autoplay is offered when the runtime does not support it, or the setting is
  saved even though the runtime rejected it.
- Windows media keys and the flyout cannot go Previous on the first song of
  a Play (every Play now starts at queue index 0), while the in-app Previous
  restarts the song or steps back into the playlist. Next is disabled on the
  last queued song while more songs of the playlist are still to be added.
- A failed media-overlay update is remembered as shown, so the overlay stays
  stale until the song changes.
- After playback stops, the tray Play/Pause item sends Pause, because the
  last playing state is never cleared.
  (These two are native-only and code-reviewed: the overlay and the tray
  need a real desktop, see Release-only evidence.)

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
- With the tray off, closing leaves the window on screen while the page
  saves before quitting. (Code-reviewed; the close-with-tray-off check still
  proves the save and the exit.)
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
- Quitting (tray Quit, or closing with the tray off) while playing loses up
  to 30 seconds of position: the page's unload save does not finish before
  the process exits. Arlet now waits up to 1.5 seconds for the page to save.
- Next, Previous, or a seek shortcut on a restored queue does nothing, or
  calls the provider before Play: there is no provider queue yet.
- A seek before Play is lost, and Play resumes at the old saved position.
- A restored long playlist ends after the songs MusicKit already held (50 to
  150), because the rest still to be added, and the songs before the one the
  Play started at, were not saved.
- A restored song loses its explicit rating, so it is queued without
  `contentRating` (no badge, and no content limit if MusicKit applies it
  client-side), or a song Apple marks unplayable is sent again.
- Installing an update or resetting settings exits without the quit save, so
  up to 30 seconds of position and a pending volume change are lost.
  (Code-reviewed: both now run the same save the quit check covers; an
  update install needs a published release.)
- An expired embedded developer token shows "You're offline" with a Reconnect
  button that fails forever; the token notice never appears because the
  expiry is only known after MusicKit started.

## Stream handoff and sign-in expiry

- Paused or errored playback keeps the DRM lease past 1 minute: MusicKit
  `stop()` is never called, so a phone playing the same account is paused
  with "More than one device is trying to play music".
- The handoff changes what the user sees: the queue, current song, or
  position changes, the status becomes "stopped" or "Nothing playing", or
  MusicKit's own stop and now-playing echoes overwrite the parked queue.
- Play after a handoff restarts at 0:00, plays a different song, or loses
  the rest of a long playlist. A station resumes as loose songs.
- A pause shorter than 1 minute is handed back anyway, or playing audio is
  ever stopped.
- Play pressed while the handoff's `stop()` is still in flight starts on a
  stopping player.
- MusicKit's own error dialog (a raw `MEDIA_LICENSE` and similar) still
  appears, or a raw reason code reaches the player bar or a toast.
- A rejected user token (403 or 401 on `/v1/me`, `AUTHORIZATION_ERROR`,
  `TOKEN_EXPIRED`, or `MEDIA_LICENSE` with a dead token) leaves the UI
  saying "Connected".
- A single forbidden resource, a network failure, or a `MEDIA_LICENSE` with
  a healthy token is treated as an expired sign-in. That would be a false
  positive.
- Expiry verification hammers Apple: more than one probe per cooldown, or
  `/v1/me` requests keep going out while expired.
- An expired sign-in deletes the library cache, pins, saved queue, or
  recents.
- "Sign in again" reuses the stale token and never opens the sign-in window.
  Or the `authorizationStatusDidChange` caused by its own `unauthorize()` is
  treated as a revocation.
- Closing the sign-in window leaves Arlet half signed in (banner gone,
  MusicKit unauthorized).
- "Sign out" from the expired state does not run the full local sign-out.

`scripts/e2e-account-session.js` drives these against the MusicKit fixture
(`stop` and `unauthorize` transitions, `configure({ rejectMeStatus: 403 })`
and `configure({ rejectAuthorize: true })`, and the configure options in
`snapshot().configure`). The 60 s handoff delay is shortened by mapping
`setTimeout` delay 60000 to a few hundred ms, installed only once playback is
audible and removed before Play. The 30 s probe cooldown cannot be shortened
from the page, so the suite reloads first and waits out the remainder before
the one check that needs a second probe. It leaves the app signed in and
healthy. Its artifacts under `e2e-artifacts/<timestamp>/`: the `account
session` and handoff/expiry checks in `report.json`,
`screenshot-account-session.png` (end state), `screenshot-account-session-expired.png`
(the banner), and `account-session-trace.json` (every fixture request and
transition, including the single `/v1/me/storefront` probe).

## Audit regressions

Failure scenarios covered by `scripts/e2e-audit-regressions.js`:

- A held `/v1/me/storefront` probe from the previous account completes with a
  403 after a new sign-in and expires the healthy session, or prevents the new
  account epoch from starting its own probe.
- An authorization still pending when the user explicitly signs out restores
  the old account when it finishes, or blocks a fresh sign-in after it settles.
  The separate `audit-fixes` scenario covers cancellation, which does not
  invalidate a late authorization.
- An old Play retries `setQueue` with the remaining IDs after a newer Play has
  already installed and started its queue.
- Release notes with a 65,527-byte unmatched inline-code run take excessive
  time or lose the literal backticks; ordinary emphasis, code spans, and
  non-navigable links regress.
- A native settings write failure has no visible error or changes the saved
  value. A failed volume write becomes an unhandled input rejection, or saving
  remains broken after the owned fault path is removed.

Run only this scenario with
`npm run test:e2e:app -- --skip-build --scenarios audit-regressions` after a
matching E2E-feature build is available. It reloads the fixture between cases
and ends signed in and healthy. The marked run artifacts include
`audit-regressions-observations.json` and
`screenshot-audit-regressions-<case>.png`; the settings case also saves the
volume and theme failure screenshots while their errors are visible. Its
native settings fault is an empty `settings.json.tmp` directory inside the
scenario's owned data directory; cleanup removes only that empty directory,
then the scenario confirms that a later settings save changes the persisted
theme.

## Deep playback and pin regressions

The `deep-regressions` native scenario runs after `audit-regressions` and
before `account-session`. It reloads the fixture between cases and covers:

- A held manual Play Next for an album rejects with `NOT_FOUND` after a newer
  Play has started. The stale retry must not add songs to the new queue.
- With MusicKit's indexed-selection methods removed, a held Playing Next row
  selection rejects after a newer Play. Its fallback must not replace that
  queue.
- A parked resume waits on the real provider stop while a newer Play starts.
  Releasing the stop must not replace the new queue or seek to the parked
  position of 0:42.
- Removing the upcoming row at index 3 in the six-song playlist holds the
  rebuild-tier `setQueue`. After a newer Play starts, rejecting that rebuild
  with `NOT_FOUND` must not retry, reselect, seek, or play over the new queue.
- An owned empty `pins.json.tmp` directory makes the native pin write fail.
  The UI must show the save error, persisted pins must stay unchanged, and a
  later pin write must persist and survive reload after the fault directory is
  removed.

Run only this scenario with
`npm run test:e2e:app -- --skip-build --scenarios deep-regressions` after a
matching E2E-feature build is available. Its marked run artifacts include
`deep-regressions-observations.json` and
`screenshot-deep-regressions-<case>.png`; the pin error screenshot is captured
before the reload. The pin fault cleanup removes only the empty directory the
scenario created. Each case records its setup preconditions with its result,
and the scenario ends with the fixture signed in and healthy.

## Handoff and settings regressions

The `handoff-settings-regressions` native scenario runs after
`deep-regressions` and before `account-session`. It reloads the fixture
between cases and covers:

- A real provider `stop()` parks a queue and remains pending. The first Play
  waits on it, a second player toggle means Pause, and releasing the stop must
  not start audio. A later Play must restore the full album queue at the saved
  0:42 position. The newer-Play-wins handoff case remains covered by
  `deep-regressions`.
- With Shuffle on, removing an upcoming row holds the rebuild after its
  temporary Shuffle-off change. A newer Play of Album Track C must queue the
  whole four-song album. Rejecting the old rebuild must retain Shuffle unless
  the user explicitly turns it off while the rebuild is still held.
- The native settings loader reads dark theme and volume 0.42 from a valid
  backup when the primary is missing, and the renderer applies both values.
  Missing both files and an invalid backup must load defaults. The cases
  preserve and restore the original primary and backup bytes in the marked
  run's owned data directory.

Run only this scenario with
`npm run test:e2e:app -- --skip-build --scenarios handoff-settings-regressions`
after a matching E2E-feature build is available. Its marked run artifacts
include `handoff-settings-regressions-observations.json` and
`screenshot-handoff-settings-regressions-<case>.png`; settings screenshots
are captured before the temporary files are restored. Queue spies only hold
and reject MusicKit provider calls; settings cases invoke the real native
`load_settings` command and reload the renderer. The existing `queue-edit`
scenario continues to cover a successful rebuild retaining its mode.

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
- A catalog next-page path Apple returns with `l=` already in it gets a
  second `l` added, so later pages can come back in another language or fail.
  (Code-reviewed; the fixture's catalog pages carry no language.)
- An artist page shows "No albums found" because a catalog response wrapped
  by MusicKit (`{ data: { data: [...] } }`) is read as empty, or lists only
  the first page (25) of an artist's albums.
- An artist page looks like an album page, its banner text is unreadable over
  the artwork, or its Top Songs grid scrolls sideways at narrow widths.
- Play on a playlist page fetches the songs already on screen again before
  any audio starts.
- Queuing songs by ID makes MusicKit look each one up first (one Apple
  request per 16 songs). Arlet queues song details instead; the real-token
  run (`test:e2e:app:real`) records the probe: one lookup by ID, none with
  details. Library-only songs are described as library songs; music videos
  still queue by ID. A rejected details queue, or details MusicKit queued but
  could not start, falls back to IDs once. With details MusicKit does not
  look songs up, so a song since removed from Apple Music fails when it
  starts and is skipped by auto-skip (covered above).

## Search, playlist dialogs, and support report

`scripts/e2e-flows.js` drives these through the real UI against the fixture.

- A submitted search shows no results, or results from the wrong source.
- Playing a search result queues the wrong song or nothing at all.
- A Play leaves no timing line in `arlet.log`, so a slow start reported by
  a user cannot be broken down into page loads, queue setup, and play.
- Add to playlist sends the song to the wrong playlist, or the dialog stays
  open after a successful add. The picker lists no playlist in time (a slow
  library load): the check waits up to 20 seconds for the option and reports
  the dialog, its feedback text, and the playlist requests in `detail`.
- New playlist drops the typed name or the selected song, or a late reply
  closes a dialog opened after it.
- The copied diagnostics report is empty, lacks the app version, or contains
  the developer or user token.
- A clipboard write that never finishes (another app holding the clipboard)
  leaves `Copy diagnostics report` with no confirmation and no error. It now
  fails after 5 seconds with an error toast, which the check's detail shows.

- A page that throws while rendering blanks the whole frameless window,
  taking the title bar, sidebar, and player with it.
- The failed page has no way back short of a restart, or "Try again" stays
  broken after the cause is gone.
- An uncaught error or unhandled promise rejection never reaches `arlet.log`,
  so a support report cannot show it.

The update-ready dialog is not driven here: it needs a signed installer from
a live feed, so it is checked by hand on each release (see below).

## Debug Mode

`scripts/e2e-app.js` starts with Debug Mode off (the default), checks it,
then turns it on through Settings for the rest of the run.

- With Debug Mode off, startup or app activity still writes `arlet.log`.
  The run starts from a settings file with no `debugMode` key.
- Turning Debug Mode on in Settings is not saved, or logging only starts
  after a restart.
- Turning it off keeps writing until restart.

A native crash or a failed window start is written to `arlet.log` even with
Debug Mode off, because nothing else records it. Routine native events, such
as a pause on suspend or lid close, are written only with Debug Mode on. The
crash path is not driven here.

## Rendering performance

`scripts/e2e-performance.js` runs inside the native suite against the MusicKit
fixture. It measures CDP `Performance` metric deltas (ScriptDuration,
LayoutCount, RecalcStyleCount, Nodes, JSHeapUsedSize) for steady playback, a
volume drag, a large library, Up Next, and artwork sizes. Every number is
written to the check `detail` and lands in `report.json`.

The metrics are relative. A report records numbers from one machine and one
run. Three ceilings and one leak check are set; a check fails when its count
is above its ceiling:

- `LIBRARY_CARD_MAX` (600): `.library-card` elements mounted in one library
  grid. The grid is virtualized, so this measures the viewport window, not the
  library size. The album and artist checks also require the scroll loop to
  reach the end (no `.library-load-more`) and the fixture to have answered all
  5000 items, counted by distinct id. Each step scrolls `.content-scroll` to
  its bottom and samples the mounted card count.
- `GRID_NODES_MAX` (5000): live elements (`getElementsByTagName("*")`) in the
  page, the largest value sampled while the album and artist grids scroll. A
  card is 16 elements (shell, open button, artwork box and img, copy block,
  actions box, Play button and icon, "..." button and icon). Measured in a
  native run: album grid max 3,452 elements (top 1,852, back to top 645);
  artist grid max 2,852. 5000 is about 1.45 times the album max. After the
  album scroll, CDP `Nodes` fell from 9,154 to 4,003 once garbage was
  collected, so the earlier growth was uncollected detached nodes, not live DOM.
- Leak check (`GRID_LEAK_MARGIN`, 50): after the scroll reaches the end, the
  scroller goes back to `scrollTop = 0`. The live element count there must not
  exceed the count at the top by more than 50. Growth only; a smaller count is
  not a leak. Both counts are read after `HeapProfiler.collectGarbage`, so a
  detached subtree still held by JavaScript shows up as growth.
- `UP_NEXT_ROW_MAX` (120): `.now-playing-queue > li` rows that are not
  `aria-hidden`. The virtual spacer rows are not counted.

CDP `Nodes` is still in each detail, but it also counts text nodes and detached
nodes that have not been collected, so it is a context figure, not a ceiling.
The grid detail records `topElements`, `maxElements`, `backToTopElements`,
`leakGrowth`, `nodeCeiling`, `leakMargin` and `maxCards` for each library.

The volume drag is checked on disk, not by counting IPC calls. Tauri defines
`__TAURI_INTERNALS__.invoke` as non-writable, so the save is observed through
`settings.json` in the scenario's data directory. Before the drag the file's
volume and mtime are recorded; 40 input events move the slider 0.4 away from
the start. Read straight after the drag, the file must be unchanged, which
shows there is no write per event and the 300 ms debounce has not fired. After
1.5 s the persisted volume must equal the slider's final value (within 0.001)
and the mtime must have moved. Before, during and after volumes and mtimes are
in the detail.

Artwork is an exact check, not a ceiling. The fixture serves an mzstatic-shaped
template (`configure({ artworkTemplate })`, with `{id}` per resource) so the
app's size rewrite runs. For a 42 px Up Next queue thumbnail and the Now Playing
hero, the check reads `devicePixelRatio` and each rendered CSS width, then
computes the expected size with the rule in `artworkBucketFor`: the smallest of
96, 300 or 640 px that covers CSS width times DPR, else 640. Every logged
segment (such as `96x96`) must equal that expected segment.

A ceiling set to `null` only records its number.

Failure modes this pass must not have:

- Playback ticks or unrelated store updates re-render the whole shell, so
  every view and the player bar rebuild several times a second.
- A volume drag re-renders every view and writes settings on every input
  event, instead of once when the drag ends.
- Queue events with an unchanged queue rebuild the queue and save the session
  on each event.
- Library album and artist grids with thousands of items mount every card,
  so scrolling costs grow with the library instead of the viewport.
- Now Playing's Up Next mounts hundreds of rows, not the visible ones.
- A 42 px thumbnail downloads a 300 px (or larger) image, and hero art is
  upscaled from a smaller source.
- A library page refresh waits on disk writes before it shows anything.
- The cached library and the saved queue wait for MusicKit's network
  configure before they appear.
- The cache's write-ahead log files survive a library clear and resurrect
  old data on the next start.
- With Debug Mode off, logging still crosses IPC for every line.

## Artwork sizing

`scripts/e2e-artwork.js` runs inside the native suite against the artwork
fixture (`configure({ artworkGrid: true, artworkTemplate })` in
`scripts/e2e-music-fixture.js`). The fixture serves short and very long titles
in the same grid, library artists whose artwork is only on their catalog
artist (`relationships.catalog.data[0].attributes.artwork`, served when the
request asks `include=catalog`), one artist and one album with no artwork. The
artwork template points every URL at the app icon, which the app already serves
from its own origin, so every `<img>` really loads. The app takes artwork only from http(s) URLs, so a data: image never
reaches an `<img>`. The template is needed: the seed artwork URLs never load.

It visits eight views: Home, Library albums, playlists, artists and recently
added, Radio, a search for `artwork`, and the library artist page for
`lib-artist-art-1`. Each card is measured from its `.card-shell`: the open
button (or static div) that holds the artwork, and the `.card-actions` overlay.
The search top result (`.search-tile-featured`, 140 px art beside text) and the
artist page's featured album (`.artist-featured-card`) are left out of the
equal-width check, but their overlays are still checked against their art.

Failure modes this pass must not have:

- A card's open button shrinks to its title, so its artwork is narrow for a
  short title and wide for a long one (the artwork is not the card's content
  width).
- Artwork is not square, so the tile height follows the title or the grid.
- Cards in one grid row differ in width.
- The Play and "..." overlay (`.card-actions`) sits beside the artwork, or is
  sized to the card instead of the art.
- Artwork renders with an image that fails to load, or an item without art shows
  nothing where its initials belong.
- A library artist tile with no artwork renders its icon as a wide strip instead
  of a square.
- A library artist's catalog artwork is ignored, so its tile has no picture
  (`include=catalog` not requested, or the catalog artwork read from the wrong
  path).
- A library artist's page hero has no picture, although its catalog artist has
  artwork.
- An album with no artwork shows no initials, or the wrong initials.
- Run on its own, or after a scenario that leaves the app signed in, Home and
  the library still hold data loaded before the artwork fixture was turned
  on, so the views show none of its cards. (In the full suite `discovery`
  leaves the app signed out first, which hid this.)

Each check's `detail` in `report.json` holds the measurements: the rects of the
artwork, content box and overlay, the row widths, and the kind of art each card
showed (`img`, `initials` or `icon`). The runner also writes one screenshot per
view (`artwork-<view>.png`, named by view) into the run's artifact folder.

Checks in `scripts/e2e-artwork.js`, by view. The check name is the `report.json`
name; `<view>` is one of the eight views above:

| Check                                                                     | Guards                                       |
| ------------------------------------------------------------------------- | -------------------------------------------- |
| `<view>: every card's artwork fills its card content width`               | button shrinks to its title                  |
| `<view>: its cards render`                                                | fixture not reached, cards missing           |
| `<view>: every card's artwork is square`                                  | non-square art, strips                       |
| `<view>: cards in one grid row share a width`                             | row widths differ                            |
| `<view>: each card's Play and More overlay sits over its artwork`         | overlay offset or sized to the card          |
| `<view>: fixture artwork loads, and items without art show a placeholder` | image not loading, placeholder missing       |
| `library albums: an album without art shows its initials`                 | initials missing or wrong                    |
| `library artists: a catalog artist's image shows on its tile`             | `include=catalog` or catalog artwork ignored |
| `library artists: an artist without art shows a square icon`              | icon rendered as a strip                     |
| `artist page: the hero shows the catalog artist's image`                  | library artist hero without catalog artwork  |

Not covered here: the real mzstatic bucket sizes (see Rendering performance),
hover and focus states of the overlay, and lazily loaded rows far below the
fold (the runner steps through the content area once, so lazy images load).

## UI polish and accessibility

`scripts/e2e-polish.js` runs inside the native suite (before Session restore)
against the `polish` fixture ids in `scripts/e2e-music-fixture.js`. It drives
the real UI over CDP and reads the fixture's snapshot for requests, queue and
volume. Each check is written to `report.json` with its observed values in
`detail`. The runner also writes `screenshot-polish.png` (the state at the end
of the scenario), `polish-trace.json`, and `now-playing-bloom-results.json`.
The latter records 20 frozen screenshots covering saturated blue and orange,
dark, pale and missing artwork in dark and light themes at desktop and narrow
widths. Compare files with the same name in the before and after run folders.

A check that fails names the gap in its `detail`. The album header menu has no
copy-link item (the hero carries no catalog URL), which is the one known gap at
this writing. A check failing means the source is behind the target below, not
that the test is wrong.

Toasts: a success toast carries `action-toast-success`. An error toast has no
class of its own, so the checks match it as an `.action-toast` that is not a
success.

Clipboard: the copied text is not read back. Reading it through
`navigator.clipboard` makes WebView2 show a Block/Allow prompt on the test
machine, which stalls the run. Copy-link is checked by its success toast, and
the exact URL is checked on the card shell.

F11 works while focus is in a text field or a dialog, by design: it has no
text-editing meaning, so it is a window action everywhere (`src/app/shortcuts.ts`).

Floating surfaces share the tokens in `src/styles/tokens.css`:
`--surface-popover` and `--backdrop-popover` for popups, menus, drawers, sticky
bars and toasts, and `--surface-modal` / `--surface-scrim` / `--backdrop-scrim`
for modal panels and their scrims. A surface that overrides them must keep a
see-through background and a real backdrop filter, while `forced-colors`
settings stay opaque with `backdrop-filter: none`.

Failure modes this pass must not have:

Floating surfaces:

- `.search-suggestions`, `.context-menu`, `.queue-drawer`, `.selection-bar` or
  `.action-toast` renders with `backdrop-filter: none`, so the blur is gone.
- One of those surfaces uses an opaque background, so text behind it clashes
  instead of showing through the frosted glass.
- A dialog scrim loses its blur, or a modal panel becomes fully opaque.

Album and playlist headers:

- A header button (Add to Library, Favorite, Pin/Unpin, "…") acts on the wrong
  item, such as the first track or the previously opened album.
- A header button does not reflect state: Favorite's `aria-pressed`, the Pin or
  Unpin label, or Add to Library's done state is stale after the library or
  ratings change.
- Favorite sends two requests for one click, or none.
- "…" opens the context menu for another item, or without the album's
  reference, so "Go to album" is missing.
- Editorial notes render HTML or run script. The fixture's notes contain
  `<i>`, `<br>` and a `<script>` that sets `window.__ARLET_POLISH_XSS__`; that
  flag must stay undefined, and the markup must appear as text.
- The "More" toggle's `aria-expanded` disagrees with the visible notes.
- Metadata invents values: a missing release date gives a year, missing genres
  give a genre, or a missing duration shows "0 min" or "NaN".
- Total length is wrong for the fixture (703 s, shown as "12 min" because
  `formatRuntime` rounds to whole minutes), or shows "NaN" or "0 min" when
  durations are missing.
- Record label or copyright appears for an item that has neither, or shows
  another item's value.
- Disc N grouping breaks click-to-play: starting track 1 of Disc 2 must play
  that track, and the queue follows the album order (Disc 1, then Disc 2).
- Disc headings break virtualization, so rows go missing at a disc boundary
  or a heading counts as a track in index-based playback.
- A single-disc album shows a "Disc 1" heading.

Now Playing:

- Favorite or Dislike writes a rating for another song, the wrong value, or drops
  a fast second click.
- Shuffle and repeat buttons disagree with the fixture's modes in the
  snapshot (`modes.shuffle`, `modes.repeat`).
- The volume control writes settings on every input event instead of after
  the debounce, or does not reach `player.volume`.
- The open or close animation leaves the dialog mounted after close, or traps
  focus after close (focus does not return to the artwork button).
- Fullscreen sticks after Esc, or the Now Playing button's label and the window
  disagree. F11 working in a text field or dialog is intended, not a failure.
- The slider's `aria-valuetext` shows a raw number or "NaN" instead of a
  formatted time or percentage.
- With `prefers-reduced-motion: reduce`, open, close or transition animations
  still run.
- The full-window bloom is too sharp or saturated, or its cover halo paints
  above the shared readability scrim.
- Blur, dither or scrim layers overlap the artwork, title, transport controls
  or queue, block clicks, or create horizontal overflow at narrow width.
- Forced-colors mode leaves either bloom image, scrim or dither visible.

Context menu:

- Separators are doubled, leading or trailing, or reachable by arrow keys.
- "Copy Apple Music link" (`data-menu-item="copy-link"`) copies a URL that is
  not `https://music.apple.com`, or the URL of a different item than the menu
  opened for. It is shown for an item with no Apple URL.
- After the menu is split into files, an item keeps no handler or a stale one.

Loading skeletons:

- A skeleton stays on screen after data arrives, or its hidden label stays
  visible.
- A refresh with data already shown replaces that data with the skeleton, so
  the layout jumps and the scroll position is lost.
- A first load that fails shows the skeleton forever instead of the error.
- Skeletons lack `role="status"` or the hidden label, so a screen reader hears
  nothing, or a spinner still shows on first load.

Toasts and About:

- A success is styled as an error (danger colour or `role="alert"`), or an
  error as a success.
- An About link navigates the app window away from `tauri.localhost` instead
  of opening the system browser, or a link is not on the allowlist.
- The About version is stale or a placeholder rather than the app's version.

Keyboard and later items:

- A keyboard-only user cannot reach a card's "…" (not focusable, or hidden
  until hover).
- A favorite star on a song row shows for an unfavorited song, or for the wrong row.
- QueueDrawer leaves focus on removed or hidden content after Esc.
- Search tabs ignore Arrow keys, or move focus without moving `aria-selected`.
- After navigating to a query route, keyboard navigation starts as soon as the
  tab exists, before RouteView's deferred heading focus settles; that later
  focus steals the tab and the first key is lost.
- The explicit badge has no accessible name, or its name is only "explicit".
- A page state (loading, empty, error) renders without an `h1`.

Checks in `scripts/e2e-polish.js`, by the failure mode each one guards (the
check name is the `report.json` name):

| Check                                                                                                                                     | Guards                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| polish fixture data reachable                                                                                                             | fixture route renders (kept from the first pass)                            |
| album metadata: year, song count, runtime from 703 s, genre                                                                               | invented values; total length                                               |
| sparse album shows only its song count                                                                                                    | invented values; "NaN" or "0 min"; More shown with no content               |
| More toggle expands and collapses, with aria-expanded matching the panel                                                                  | More toggle state                                                           |
| editorial notes are plain text: no markup element, no script ran                                                                          | notes render HTML or run script                                             |
| record label and copyright appear under More                                                                                              | label or copyright for the wrong item                                       |
| playlist description renders as plain text                                                                                                | description HTML or script                                                  |
| Disc 1 and Disc 2 headings group the four tracks in album order                                                                           | disc grouping                                                               |
| rows show per-disc track numbers                                                                                                          | disc numbering (not a listed failure mode; the spec for this pass)          |
| clicking the first row of Disc 2 starts MusicKit's queue at that song: [d2 t1, d2 t2] at index 0                                          | disc grouping breaks click-to-play                                          |
| the Disc 2 Play was given the whole album from the page: no track pages fetched                                                           | album re-fetched before Play                                                |
| Previous from Disc 2 track 1 plays Disc 1 track 2 (the album's earlier songs are kept)                                                    | earlier songs dropped from Previous history                                 |
| a single-disc album shows no Disc heading                                                                                                 | single-disc "Disc 1" heading                                                |
| header Favorite toggles once per click, sending one PUT then one DELETE                                                                   | Favorite sends two requests or none; aria-pressed                           |
| More actions opens the album menu and its target is the album                                                                             | "..." acts on the wrong item                                                |
| context menu has no leading, trailing or double separators                                                                                | separators doubled, leading or trailing                                     |
| ArrowDown visits each menu item once, wraps, and never lands on a separator                                                               | separators reachable by arrow keys                                          |
| album header menu offers Copy Apple Music link                                                                                            | copy-link missing (expected to fail; see above)                             |
| Escape closes the album menu and returns focus to its More button                                                                         | menu focus                                                                  |
| Pin and Unpin flip the playlist header label both ways                                                                                    | Pin or Unpin label stale                                                    |
| album card carries its Apple Music link on the card shell                                                                                 | copy-link URL                                                               |
| keyboard Tab from the card reaches its Play button, then its More actions button                                                          | card "..." not focusable                                                    |
| card menu offers Copy Apple Music link and has clean separators                                                                           | copy-link on a card                                                         |
| copy-link shows the success toast, not the error style                                                                                    | success styled as error                                                     |
| (no check: the copied text is not read back; the exact URL is asserted on the card shell, and copy-link is asserted by its success toast) | copy-link URL                                                               |
| card Play starts the album from its first track                                                                                           | card Play starts the wrong collection                                       |
| Arrow, Home and End keys move selection, focus and the tabpanel label together                                                            | search tabs ignore Arrow keys                                               |
| open animation moves the dialog when motion is allowed (baseline)                                                                         | baseline for the reduced-motion check                                       |
| Now Playing controls carry their state labels                                                                                             | controls missing or stale labels                                            |
| volume slider reads a percentage and reaches the player                                                                                   | volume writes or reads wrong                                                |
| seek slider reads m:ss of m:ss, not a raw number                                                                                          | slider aria-valuetext "NaN" or raw number                                   |
| artwork bgColor tints Now Playing through --now-playing-tint                                                                              | tint missing                                                                |
| a track without bgColor keeps the plain surface                                                                                           | tint on a track without bgColor                                             |
| closing Now Playing returns focus to the artwork button and unmounts it                                                                   | focus after close; dialog left mounted                                      |
| reduced motion: opening Now Playing runs no transform animation                                                                           | animation with reduced motion                                               |
| reduced motion: closing Now Playing unmounts within 400 ms                                                                                | exit transition with reduced motion                                         |
| opening Playing Next moves focus to its heading                                                                                           | queue drawer focus                                                          |
| Escape closes Playing Next and returns focus to its toggle                                                                                | queue drawer focus after Esc                                                |
| a rejected rating shows the error style and rolls Favorite back                                                                           | error styled as success; rollback                                           |
| radio first load shows a labelled role=status skeleton, removed once data renders                                                         | skeleton stuck or unlabelled                                                |
| a failed first load ends the skeleton instead of keeping it                                                                               | skeleton on a failed load                                                   |
| Ctrl+R refresh keeps album cards on screen and shows no skeleton                                                                          | refresh replaces data with a skeleton                                       |
| About links are enabled type=button elements labelled Project page, Release notes and License, with no href or target (not clicked)       | About link navigates the window, is missing, or is disabled                 |
| a route change moves focus to the page h1                                                                                                 | route focus, including a deferred heading focus stealing search-tab focus   |
| viewport override switches the shell to the compact layout (720 px)                                                                       | environment: the webview ignores the override (a failing check, not a skip) |
| opening the compact drawer moves focus into it                                                                                            | compact drawer focus                                                        |
| Escape closes the compact drawer and focuses the menu button                                                                              | compact drawer Esc                                                          |
| Tab on the last drawer control wraps to the first one                                                                                     | compact drawer focus trap                                                   |
| F11 enters window fullscreen; the Now Playing button then reads Exit full screen                                                          | fullscreen state disagrees with the window                                  |
| Escape in Now Playing closes it and leaves fullscreen                                                                                     | fullscreen sticks after Esc                                                 |
| album header blooms its artwork behind a right-side reading scrim                                                                         | detail hero backdrop missing; copy or actions outside the header            |
| playlist header blooms its artwork behind a right-side reading scrim                                                                      | playlist backdrop missing; hero overflow                                    |
| the search suggestion popup is a translucent frosted surface                                                                              | opaque popup or missing blur                                                |
| media suggestions show a 32 px thumbnail and their kind; text completions do not                                                          | thumbnails missing on media, or shown on terms                              |
| recent searches stay text-only with no thumbnail                                                                                          | recent rows grow a thumbnail                                                |
| the selection bar is a translucent frosted surface                                                                                        | opaque selection bar or missing blur                                        |
| the context menu is a translucent frosted surface                                                                                         | opaque context menu or missing blur                                         |
| the queue drawer is a translucent frosted surface                                                                                         | opaque queue drawer or missing blur                                         |
| the action toast is a translucent frosted surface                                                                                         | opaque toast or missing blur                                                |
| Now Playing renders its artwork backdrop and cover bloom                                                                                  | bloom layers missing; wrong alt or aria-hidden                              |
| pausing playback holds the bloom still                                                                                                    | bloom drifts while paused                                                   |
| resuming playback runs the bloom again                                                                                                    | bloom stops after pause and never restarts                                  |
| Now Playing bloom capture covers artwork variants, themes and widths                                                                      | visual matrix missing an artwork, theme or viewport                         |
| both bloom layers sit under the shared scrim with foreground content above                                                                | halo escapes the scrim or foreground is covered                             |
| Now Playing has no horizontal overflow and its controls and queue stay reachable                                                          | narrow layout clips or blocks controls or queue                             |
| forced colors hides the bloom decorations and keeps the track visible                                                                     | artwork, scrim or dither in forced colors                                   |
| a track without artwork renders no bloom images                                                                                           | broken backdrop or halo `<img>`                                             |
| reduced motion: the artwork bloom runs no animation                                                                                       | bloom animation with reduced motion                                         |

Fullscreen is read from the window size against the screen, because the app
uses window fullscreen and not DOM fullscreen (`document.fullscreenElement`
stays null).

## Apple Music discovery features

`scripts/e2e-discovery.js` runs inside the native suite (before Session
restore) against the discovery ids in `scripts/e2e-music-fixture.js`. The
fixture header lists every id, route and control. Each check's `detail` holds
the values it saw, and the run writes `discovery-trace.json` (the fixture
snapshot) and `screenshot-discovery.png` to the artifact folder.

The scenario resets the fixture between groups. External sign-out runs last
and restores the account in `finally`, so Session restore starts signed in.

Not covered yet: the fixture has one account, so recent searches are not
tested across accounts; the see-all loop guard (`repeatViewCursor`) is in the
fixture but no check drives it; Home's other card types are not modeled.

Failure modes, each with the check that guards it (the check names are the
`report.json` names).

Artist page (`views` and `extend` in one request):

- The page sends more than one artist request when views succeed, or sends a
  See all or fallback request on load. [artist page makes one artist request
  when views succeed]
- Albums are fetched again from the first page, or listed twice (the "every
  album" regression). [artist albums fill from the views with one next page
  and no duplicates]
- Views fail and the page shows less than before. [artist page falls back to
  its separate requests when views fail; the check first visits another
  artist and waits for each fallback request to settle]
- Top Songs repeat or drop a song. [artist top songs show the five inline
  songs, each once]
- The bio renders the fixture's `<b>`, `<a>` or `<script>` as markup, or runs
  the script (`window.__ARLET_DISCOVERY_XSS__`). [artist bio shows its markup as
  text and runs no script]
- The banner is missing when editorial artwork exists. [artist banner comes
  from the editorial artwork]
- A sparse artist shows an empty shelf, or a bio or banner with no data.
  [sparse artist hides the shelves Apple left out, along with its bio and
  banner]
- A library artist renders its library record without its catalog views.
  [library artist reads its catalog twin, then the catalog views]
- A library artist whose catalog views fail lists only the albums already in
  the library (matched by artist name), or none. On a real account, the
  library artist albums relationship answered 404, and the page then showed
  2 of the artist's albums. The fixture answers that relationship with 404 for
  `library-artist-views`. [library artist lists its catalog albums when the
  views fail]
- A later album page fails and the page drops the albums it already loaded,
  then falls back to the library albums. `configure({ rejectPaths:
["/view/full-albums?offset=25"] })` fails the second page. [artist page
  keeps the albums it loaded when a later album page fails]

Album shelves (`include=tracks` with `views`, album `album-discover`):

- Shelves replace or drop tracks, so the four tracks no longer all list.
  [album shelves keep all four tracks and hide the empty more-by-artist shelf]
- The empty more-by-artist shelf shows. [same check]
- A library album does not load its catalog views. [a library album keeps its
  tracks and loads the catalog album views]

Search suggestions (`/search/suggestions`):

- A one-character term sends a request. [a one-character term sends no
  suggestion request]
- A late reply overwrites a newer list. `configure({ delayTerms: { pol: 1200 } })`
  delays "pol" while "fix" is typed. [a late suggestion reply never replaces a
  newer one]
- Esc does not close the list, or the terms and top result do not show.
  [suggestions list terms and a top result, and Escape closes them]
- Tab stays inside the list. [Tab leaves the suggestion list instead of holding
  focus]
- Picking a term does not run that search. [picking a suggested term runs that
  search]
- A media suggestion has no thumbnail, or a text completion or recent search
  grows one. [media suggestions carry a decorative thumbnail; term suggestions
  stay text-only]
- The recent-search check starts before MusicKit authorization, catalog source,
  the submitted search route, or stored recent term settles. It must prove the
  real form submit and storage/route state before clearing the field and
  reopening suggestions through user input/focus. [recent searches stay
  text-only with no thumbnail]

Search results (`with=topResults`, `types`, `limit`, `offset`):

- The overview omits topResults, a requested type, or the limit of 10. [overview
  search asks every group with topResults and a limit of 10]
- See all albums duplicates or skips albums (60 albums, 25 a page). [See all
  albums pages through all 60 with no duplicate pages or albums]
- Stations or curators land in the Albums section, or a curator tile does not
  open its page. [stations and curators get their own sections, and a curator
  tile opens its page]

Browse charts (`/charts` with `genre`, `with`, `next`):

- Choosing a genre does not change the charts request, or shows the same songs.
  [choosing Pop sends genre 14 to charts and shows its songs]
- City or daily shelves stay when the genre has none, or hide Top Songs too.
  [city and daily shelves hide only where the genre has none; Top Songs stays]
- Top Songs See all repeats songs, or follows a next link that is not a chart
  path. [Top Songs See all pages through 30 songs with no duplicates, via the
  chart's next link]
- A Browse refresh that fails while a See all page loads leaves that shelf
  "loading" forever, so Load more never returns. [a failed Browse refresh during
  a See all page does not strand Load more; the next page appends once]
- Load more during a Browse refresh follows the old cursor, so a chart page for
  the replaced list is requested and appended to the new one. [Load more during
  a Browse refresh requests no chart page, and the next page appends once after
  it]

Radio station genres (`station-genres`, `station-genres/{id}/stations`):

- A genre chip does not open its station shelf. [a genre chip opens its
  station shelf from station-genres]
- A station with a URL does not play, or a station without one has an active
  Play. [a station with a URL plays from its card, and one without has no Play]
- Live text is missing for a live item, or stays after the item changes.
  [live radio text shows for a live item and clears when the item changes]

Curators (`curators/{id}`, `apple-curators/{id}` with `views=grouped-playlists`,
`playlists?ids=`, `playlists/{id}?include=curator`):

- An Apple curator shows no groups, because bare playlist refs are not
  batched. [an Apple curator shows its editorial group, resolved through the
  playlists batch]
- A non-Apple curator's flat playlist shelf is wrong, or a batch sends more
  than 25 ids. [a curator's flat playlist shelf lists its three playlists, and
  batches stay at 25 ids or fewer]
- A curator's playlist is a dead link. [a curator's playlist opens and lists its
  tracks (no dead link)]
- A playlist's curator link is missing, reads a different curator name, or
  opens the wrong kind of curator. [a playlist's curator link opens the curator
  page]
- A curator header has no artwork bloom, or its image matches an artist-only
  selector. [an Apple curator header blooms its artwork without leaking artist
  selectors; a curator header blooms its artwork without leaking artist
  selectors]
- A recent search grows an artwork thumbnail. [recent searches stay text-only
  with no thumbnail]
- The submit handler stores a recent term before the deferred route-to-input
  effect settles. Clearing the input directly can be overwritten by the old
  route query, hiding the recent list; use the app's Clear search button and
  verify the empty route and input before reopening suggestions on focus.

Home (`recent/played`, `history/heavy-rotation`, `recommendations`):

- Recently Played is missing, drops albums or stations, shows a menu on a
  station card, or does not follow its next page once. [Home shows Recently
  Played with albums and stations, and station cards have no menu]
- Heavy Rotation filters out stations or playlists. [Heavy Rotation keeps
  stations, albums and playlists unfiltered]
- A nested recommendation group is dropped, or merged into its parent. [a
  nested recommendation group becomes its own titled shelf]

MusicKit events (fixture controls in the header):

- A late duration leaves seek disabled. [a late duration enables seek and shows
  the total]
- An external volume change is not shown or not saved, or the app writes it
  back again. The control makes one "volume" write; any more is a loop. [an
  external volume change shows, saves to settings, and does not loop]
- External sign-out leaves recent searches or the signed-in UI in place. [external
  sign-out runs local cleanup and shows the signed-out UI]

## Audit fixes

Native-only and code-reviewed (no E2E):

- Item 1, pause on system suspend and on default output change
  (`src-tauri/src/system_events.rs`): the failure modes are listed in the
  module doc comment, and the pure decision logic has Rust unit tests. The
  event wiring is code-reviewed. The manual checks are under "Release-only
  evidence".
- Item 4, native command hardening (`docs/SECURITY.md`): code-reviewed. Every
  `#[tauri::command]` input cap and enum check in `src-tauri/src/` is reviewed.

Failure modes:

- Idle playback cap (item 2): playback that has run 4 h with no pointer,
  key, wheel, transport, queue, tray, or SMTC command is not paused. A pause
  fires during active use. The pause shows no "Paused after 4 hours without
  activity." notice. Two timers run, so the pause fires twice. The timer keeps
  running while paused or not playing.
- Cancel a stuck sign-in (item 5): Cancel leaves `auth.pending` set. An
  abandoned `authorize()` that later resolves leaves Arlet signed out. Its
  rejection shows an error instead of being ignored. A new sign-in click during
  an abandoned attempt does nothing. Cancel is missing from the titlebar
  connection menu, the Settings account card, or the session-expired notice.
- Offline recovery (item 6): a reload happens after an init failure that was
  not a network error, or after an expired developer token. A reload happens
  more than once within 30 s. A reload happens when init never failed. The
  offline banner's Reconnect disappears.
- Clipboard copy (item 7): a stalled plugin call blocks past 2 s without
  falling back to `navigator.clipboard`. The fallback is skipped after a plugin
  error. "Clipboard is busy" shows while either path succeeded. Neither path
  logs its result. The support-report E2E must read the real clipboard through
  the provider that succeeded (Tauri first, then the isolated WebView2 browser
  clipboard with test-only CDP permission), preserve and restore existing text,
  and report provider failures without recording clipboard contents.
- Ratings caches (item 10): `settled`, `generations`, or `added` grows past
  2000 entries. Eviction drops an in-flight entry, so a request repeats or a
  result is lost. A re-added key is not treated as the newest entry.
- Notice stacking (item 11): the session-expired and token-expiry notices
  overlap, or one is hidden while the other shows. The container takes space
  when neither notice is showing. Either notice overflows at phone width.
- Parked station seek (item 12): `seek` on a parked station moves the shown
  position or the resumed track. The scrubber stays enabled for a parked
  station. Seek is dropped on a normal queue.

E2E suite (`scripts/e2e-audit-fixes.js`, run after "artwork" in the native
run): idle cap and activity re-arm (6 s stand-in for 4 h, with the keydown at
2 s and reads at 7 s), a `windows-media-control` "pause" event, the
`online` event with healthy MusicKit (no reload; the reload after a failed
start, with Apple's CDN blocked, is `e2e-app.js` item 11), the diagnostics copy
answering within 6 s with "Copied" or the busy error (the logged path is
recorded when readable), cancel of a stuck sign-in from the notice, titlebar
and Settings (a held `configure({ hangAuthorize: true })` call is released
later and must still sign in; a new attempt during an abandoned one starts
fresh; a later expiry is detected), the notice stack container, and a parked
station's disabled scrubber and dropped seek; a manual "Sign in again" that is
cancelled or rejected, and a token MusicKit drops silently (second audit item
1); and a parked queue resumed with shuffle on, which keeps its saved order
(item 2). The suite ends signed in and
healthy. Artifacts under `e2e-artifacts/<timestamp>/`: the `audit fixes`
checks in `report.json`, `screenshot-audit-fixes-idle.png`,
`screenshot-audit-fixes-sign-in-pending.png`,
`screenshot-audit-fixes-expired.png`, and `audit-fixes-trace.json`.

The live MusicKit script check (item 3, `e2e-app.js`) fetches
`js-cdn.music.apple.com/musickit/v3/musickit.js` and fails with the list of
missing markers in its detail.

Code-reviewed, no E2E:

- Ratings caches (item 10): `settled`, `generations`, and `added` are capped
  at 2000 with oldest-first eviction that skips in-flight entries. Reaching
  2000 distinct lookups in one session is not practical in the fixture.
- Token-expiry notice in the stack (item 11): `developerTokenExpiresAt` comes
  from the embedded developer token in a release build, and the suite cannot
  change it. The suite checks only the `.notice-stack` container.

Second audit (spec items 1 to 5). Items 1 and 2 are driven by the native
suite (`scripts/e2e-audit-fixes.js`, checks `re-auth failures`, `lost token`
and `parked queue order`). The rest are code-reviewed:

- Failed manual re-auth (item 1): a cancelled "Sign in again" on a healthy
  session expires it when MusicKit is unauthorized, and does not when MusicKit
  holds a token again. A rejected or closed attempt expires it, logs the reason,
  and the notice signs in again. An abandoned attempt that completes later clears
  the notice. A token MusicKit drops without an event expires the session with
  no `/v1/me/storefront` probe. Failure modes: a closed, cancelled, or rejected
  re-auth leaves "Connected" with no token; a healthy session is probed while
  MusicKit reports it unauthorized; an account transition blocks the expiry.
- Parked queue order (item 2): Next, Previous, and Play on a parked queue, with
  shuffle on, each queue only the songs from the target index on, in saved
  order, and Play then seeks to the saved position. Previous steps back into
  history without queueing it. Restore from disk runs the same
  `resumeRestoredQueue` path, but a restart is not driven here. Past a song's
  first 3 seconds, Previous restarts it, as in Apple Music: MusicKit's
  `skipToPreviousItem` only restarts the first song or with Repeat One.
  Failure modes: Previous at 0:42 into a later song plays the song before it;
  the restart rebuilds or reselects the queue instead of seeking to 0:00; on
  a parked queue it queues from the song before, or resumes at the saved
  position instead of the start. A parked queue keeps only 20 songs before its
  Play, so Previous stops 20 songs back (see `repeat all wrap`).
- Repeat All (`repeat all wrap`): as in Apple Music, Repeat All loops through
  the whole album or playlist. A Play started mid-album begins MusicKit's
  queue at the chosen song, so MusicKit alone would loop from there. On the
  last song Arlet adds the next pass, from the album's first song, as the
  queue's rest; turning Repeat All off before that pass starts removes it. A
  parked queue wraps the same way. Failure modes: Next or the end of the last
  song loops back to the chosen song, so the songs before it never repeat;
  the pass stays after Repeat All is turned off, so playback runs past the
  album's end; a song added with Play Later after the pass is removed with
  it; Next on the last parked song does nothing; Previous on the first parked
  song restarts it instead of playing the last; the Windows media flyout and
  taskbar Next are disabled on the last song with Repeat All on. Songs before
  the chosen one (song 25 of a 30-song playlist): the pass starts 20 songs
  before the chosen one, so songs 1 to 4 never repeat; Previous on the first
  queued song stops stepping back after 20 songs instead of reaching song 1.
  A parked queue keeps every song before the chosen one. Checks: after a Play
  from song 25 and a park, Previous steps back 24 songs to song 1; after a
  resume with Repeat All on, the pass repeats all 30 songs. Failure modes: a
  parked queue keeps only the 20 songs before its Play, so Previous stops 20
  songs back and a resumed pass starts at song 5 (26 songs, not 30).
- Playing Next opens at the current song (`repeat all wrap`, the Playing Next
  check): the drawer scrolls so the current row is near its top, with the songs
  before it above, each time it opens. Failure modes: it opens at the top with
  the current row out of view on a parked queue of 20 or more earlier songs;
  a later song change while it stays open scrolls it. The later-change part is
  code-reviewed (`VirtualList` `revealIndex` applies once per mount).
- Lid close on Modern Standby (item 3): native-only. The decision logic (pause
  once on entering "lid closed and display off"; ignore the registration seed)
  is unit-tested in `src-tauri/src/system_events.rs`, and the wiring is
  code-reviewed. The desktop check is under "Release-only evidence".
- Newer release replaces a pending update (item 4), and a failed periodic check
  keeps a ready update (item 5), in `src/updater.ts`: code-reviewed, not driven.
  Reaching the updater needs the live release feed, and a pending update needs
  a signed installer downloaded from it. The E2E build does not stub that feed,
  and a fake feed would bypass the signed-updater check the flow keeps. Check
  these by hand on a release build: a newer release replaces a downloaded one,
  a same-version check keeps "ready", and a failed check keeps Install.

Stale sign-in after Sign out and Sign in (found after a real password change).
MusicKit replaces its API object, which carries the user token, on every
sign-in and sign-out. The fixture now does the same, and its replaced object
rejects `/v1/me` with a bare `403`, as the old token would. Driven by the check
`sign out then in`. Failure modes:

- The request wrapper keeps the API object from before the sign-in, so every
  library request sends the dead token and fails with `403` until a restart,
  while the titlebar says "Connected".
- The expiry check probes with a fresh API object, passes, and so never shows
  the banner while the real requests keep failing.
- A suspect error that arrives while a sign-in is still finishing is dropped
  and never checked again. It is now kept, and checked once the sign-in
  settles, with the probe cooldown reset.
- A refused request shows the bare status `403` instead of readable text.
- Sign-out cleanup is still pending when the Settings `Sign in` button first
  appears; clicking that disabled button cannot start authorization and must
  not be mistaken for a stale-API failure. Once the button is enabled, a click
  that still fails to authorize is a real sign-in failure.

## MusicKit parity

`scripts/e2e-musickit-parity.js` is the `musickit-parity` scenario. In the full
suite it runs second to last, after `catalog-extras` and before
`session-restore`, because its station checks fill the app's caches.
`session-restore` stays last because it signs out at the end. The fixture
(`scripts/e2e-music-fixture.js`) is being rebuilt to match live MusicKit v3
`3.2526.0`, so these checks assert MusicKit's real behavior rather than
Arlet's guess at it. The ground truth the fixture copies:

- `PlayerRepeatMode`: none 0, one 1, all 2.
- `PlayerShuffleMode`: off 0, songs 1.
- `PlaybackStates`: none 0, loading 1, playing 2, paused 3, stopped 4, ended 5,
  seeking 6, waiting 8, stalled 9, completed 10.
- `PlaybackBitrate`: STANDARD 64, HIGH 256.
- Autoplay: MusicKit keeps up to 10 `isAutoplay` songs after the user's songs
  while there are 50 or fewer unplayed user songs. `playLater` inserts before
  the autoplay songs (`appendTargetIndex`). Repeat on removes the autoplay
  songs. Shuffle and repeat are disabled while an autoplay song plays.
- Shuffle: the shuffler reshuffles on every `setQueue` while shuffle is on.
  Unshuffling a queue with duplicate IDs lands on a stale position.
- `changeToMediaAtIndex` calls `stop()` first, which publishes an empty
  now-playing item and the stopped state.
- Station queues ignore shuffle and repeat. `playNext`, `playLater`, and
  `clearQueue` throw `UNSUPPORTED_ERROR`.
- Non-subscribers get 30 s previews automatically. `hasMusicSubscription()` is
  async. The subscribe URL is on `finance-app.itunes.apple.com`.

Failure scenarios to cover before changing production code:

### Canary

- The fixture's enum or bitrate values drift from live MusicKit, so every other
  check passes against a model MusicKit does not use.
- MusicKit renames a playback state or changes a bitrate value, and the suite
  keeps the old number without failing.
- The live script stops keeping the queue model the fixture copies (autoplay,
  the shuffler, `stop()` before a change), and the fixture drifts silently.
- Arlet maps a repeat or shuffle enum differently from MusicKit, so the buttons
  show one mode while MusicKit plays another.
- The canary is skipped when MusicKit is not loaded, so the feature checks run
  against the fixture alone and report a pass.

Check names in `report.json`:

- `live MusicKit repeat and shuffle enums match Arlet's mapping`
- `live MusicKit playback states and bitrates match the E2E fixture`
- `live MusicKit script keeps the queue model the E2E fixture copies`
- `E2E fixture enums equal live MusicKit's`

### Repeat

- Repeat All loops one song because Arlet writes MusicKit repeat mode 1.
- Repeat One writes mode 2, so the whole queue repeats instead of one song.
- With Repeat One, a song that ends moves to the next song instead of playing
  again.
- With Repeat One, Next either stays on the same song or plays the next song
  and drops Repeat One.
- With Repeat One, Previous in the first 3 seconds goes to the last song
  instead of the previous one.
- With Repeat All, the last song ends into the chosen song rather than the
  first song of the list.

Check names in `report.json`:

- `Repeat All writes MusicKit repeat mode 2 and Repeat One writes 1`
- `with Repeat One, a song that ends plays again`
- `with Repeat One, Next plays the next song and keeps Repeat One`
- `with Repeat One, Previous in the first 3 seconds plays the previous song`
- `with Repeat All, the last song ends into the first song`

### Shuffle model

- Shuffle on moves the playing song out of first place, so the song that was
  playing is not the first one in the shuffled order.
- A Play with shuffle on starts a different song, because MusicKit reshuffles
  on `setQueue` and Arlet does not pass `startWith`.
- A parked queue resumed with shuffle on is reshuffled, so the saved order and
  the position the user left are lost.
- Turning shuffle off after a kept-order resume reshuffles the queue into a
  random order.
- A queue rebuild with shuffle on reshuffles the edited order, so an edit moves
  songs the user did not touch.
- Choosing a Playing Next song while Arlet holds MusicKit's shuffle off writes
  shuffle on first. MusicKit reshuffles, and the clicked position then plays a
  different song.

Check names in `report.json`:

- `shuffle on puts the playing song first and keeps playing it`
- `a Play with shuffle on starts the chosen song even though MusicKit reshuffles the queue`
- `a parked queue resumed with shuffle on keeps its saved order and still shows shuffle on`
- `turning shuffle off after a kept-order resume does not reshuffle`
- `a queue rebuild with shuffle on keeps the edited order`
- `choosing a Playing Next song while the shuffled order is held plays that song and keeps the order`

### Selection and stations

- Choosing a song in Playing Next calls `changeToMediaAtIndex`, which calls
  `stop()` first, so the player and Windows media controls briefly clear.
- During a station, Shuffle and Repeat show and fail when clicked, because
  station queues ignore both.
- During a station, Arlet's shuffle button shows on while MusicKit plays in
  order.
- Play Next during a station shows MusicKit's raw `UNSUPPORTED_ERROR` text
  instead of an explanation.
- Play Later or Clear during a station fails silently or shows the raw error.

Check names in `report.json`:

- `choosing a song in Playing Next never clears the player or the Windows media controls`
- `during a station, shuffle and repeat are hidden`
- `Play Next during a station explains it is unavailable instead of showing MusicKit's error`

### Autoplay

- Play Later songs show after the autoplay songs in Playing Next, while MusicKit
  plays them before the autoplay songs.
- Clear removes autoplay songs and MusicKit adds them straight back.
- Repeat on leaves autoplay songs queued, so they keep playing after the user's
  songs repeat.
- The Playing Next autoplay toggle hides the autoplay songs but leaves them
  playing, or turns autoplay off without saving the setting, so it is back on
  after a restart.
- Turning Autoplay off from Playing Next empties its section, the toggle goes
  with it, and Autoplay can only be turned back on in Settings.
- The saved session, a stream handoff, or Save as playlist includes upcoming
  autoplay songs the user never chose.
- The playlist refill counts autoplay songs as user songs, so it skips loading
  the rest of the playlist.
- Shuffle or Repeat can be clicked while an autoplay song plays, and the change
  silently does nothing or reorders the autoplay songs.
- An autoplay station Apple refuses is logged on every song end and shows an
  empty Autoplay heading.

Check names in `report.json`:

- `autoplay songs show under an Autoplay heading after the queue`
- `Play Later adds songs before the autoplay songs`
- `Clear removes queued songs and keeps the autoplay songs`
- `Repeat on removes autoplay songs and Repeat off brings them back`
- `the Playing Next autoplay toggle turns autoplay off, removes its songs, saves the setting, and stays to turn it back on`
- `shuffle and repeat are disabled while an autoplay song plays`
- `the saved session, stream handoff, and Save as playlist leave out upcoming autoplay songs`
- `the playlist refill ignores autoplay songs when counting what is left`
- `an autoplay station Apple refuses is logged once and shows no Autoplay heading`

### Shuffle across the collection

- Turning shuffle on mid-album never plays the songs before the start song, so
  the album's first tracks drop out of the queue.
- Turning shuffle off leaves a random order instead of returning to album order
  after the playing song.
- In a playlist with a song twice, shuffle off continues from the first
  occurrence rather than the one playing, so the wrong occurrence is selected.
- With shuffle on, a list over 500 songs is capped or paginated, so the songs
  before the start drop out.
- Unshuffling a queue with duplicate IDs lands on a stale position, and the
  queue shows the wrong song as playing.

Check names in `report.json`:

- `shuffle on mid-album includes the songs before the one you started from`
- `shuffle off returns to album order after the playing song`
- `shuffle off in a playlist with a song twice continues after the playing occurrence`
- `shuffle on for a list over 500 songs still includes the songs before the start`

### Audio quality

- Audio quality Automatic writes a bitrate, overwriting the one MusicKit chose.
- High and Standard write the wrong bitrate, so Settings shows one value while
  MusicKit streams another.
- The chosen quality is not saved, so it resets on the next launch.
- A MusicKit bitrate change (`playbackBitrateDidChange`) does not reach
  Settings, which keeps showing the old value.

Check names in `report.json`:

- `Audio quality High and Standard write MusicKit bitrate 256 and 64 and are saved`
- `Audio quality Automatic leaves MusicKit's bitrate as MusicKit chose it`
- `a MusicKit bitrate change shows in Settings`

### Previews only

- A non-subscriber sees a normal player with no Previews only notice, so 30 s
  clips look like a playback bug.
- A subscriber sees Previews only while `hasMusicSubscription()` is still
  pending, and the notice never clears.
- A non-subscriber's notice disappears and comes back on every recheck, such as
  each preview that fails with `SUBSCRIPTION_REQUIRED`.
- The Previews only notice has no Subscribe button, so there is no way to reach
  the Apple subscription.
- Subscribe opens a link on a host other than `finance-app.itunes.apple.com`.
- The Subscribe link opener accepts a non-Apple or non-https URL.

Check names in `report.json`:

- `without a subscription, Arlet shows Previews only with a Subscribe button`
- `with a subscription, no Previews only notice shows`
- `a subscription recheck keeps Previews only shown while the answer is pending`
- `open_subscribe_link refuses non-Apple and non-https links`

The Rust command `open_subscribe_link(url)` in `src-tauri/src/commands.rs`
accepts only `https`, host `apple.com` or `*.apple.com`, no userinfo, no port,
and at most 2048 bytes. Its Rust tests are written before the command. They
cover an `http` scheme, the other hosts `apple.com.evil.test` and
`evilapple.com`, userinfo, an explicit port, an over-long URL, non-URL text,
and an accepted `https://finance-app.itunes.apple.com/deeplink?p=subscribe`.

Artifacts: the report is grouped as above. The run writes six screenshots:
`screenshot-musickit-parity-repeat.png`, `screenshot-musickit-parity-shuffle.png`,
`screenshot-musickit-parity-station.png`,
`screenshot-musickit-parity-autoplay.png`,
`screenshot-musickit-parity-collection.png`, and
`screenshot-musickit-parity-preview.png`. The scenario also writes
`musickit-parity-trace.json`, the fixture snapshot transitions for each group.
The harness writes a file with that same name after the scenario returns, from
a snapshot taken after the scenario's reset, so the harness's copy replaces the
group trace. Focused run:
`npm run test:e2e:app -- --skip-build --scenarios musickit-parity`.

### Re-baselined checks (beta.5)

The fixture now matches live MusicKit, so the existing checks below are
re-baselined against it. Each must keep asserting Arlet's request (the
`setQueue` ids and `startWith`) separately from the order MusicKit holds. A
check that reads only the queue order MusicKit reports would pass for the wrong
request, and a check that reads only Arlet's request would miss a reshuffle.

- `scripts/e2e-desktop.js`: "system shuffle and repeat requests reach MusicKit",
  and "autoplay continues past the queue end when enabled" (it runs on the
  fixture's default refused station, where `finishWithAutoplay` appends an
  autoplay song at the queue end).
- `scripts/e2e-playlist-playback.js`: "shuffle can advance to a playlist
  occurrence before the clicked row and return", "shuffle off follows playlist
  order while preserving the clicked occurrence", "middle playlist occurrence
  keeps the full paginated queue and selects that duplicate", "Playing Next
  shows all playlist occurrences in MusicKit's shuffled order with the selected
  occurrence active" (renamed in beta.5 from "...in order with the selected
  occurrence active"), and "clicking Playing Next row 3 of 6 keeps the queue and
  selects that index".
- `scripts/e2e-queue-edit.js`: "editing with shuffle on keeps the explicit order
  and restores shuffle".
- `scripts/e2e-handoff-settings-regressions.js`: the `shuffleRebuild` group
  (cases `shuffle-rebuild-retains-mode` and `shuffle-explicit-off-wins`).
- `scripts/e2e-audit-fixes.js`: the `parkedQueueOrder` group.
- `scripts/e2e-discovery.js`: "overview search asks every group with topResults
  and a limit of 10". Its expected `types` now include `record-labels` and
  `activities`, the overview-only groups with no See all page.

## Catalog extras

`scripts/e2e-catalog-extras.js` is the `catalog-extras` scenario. It covers
Replay shelves on Home, record label pages, activity pages, Search groups for
record labels and activities, a Get Info song dialog, choosing a parent folder
when creating a playlist or folder, and the Edit in Apple Music context-menu
item on editable library playlists.

- Replay shelves on Home read
  `GET /v1/me/music-summaries?filter[year]=latest&views=top-artists,top-albums,top-songs`.
  With no Replay data, the shelves are hidden and no error is shown.
- Record label pages read
  `GET /v1/catalog/{sf}/record-labels/{id}?views=latest-releases,top-releases`.
  An album's "More" panel links its record label. A library album reads the
  label from its catalog twin (`include=record-labels` on the catalog album);
  the library album request never asks for record labels, which Apple does not
  document for library albums.
- Activity pages read `GET /v1/catalog/{sf}/activities/{id}?include=playlists`
  and list at most 10 playlists.
- Search has record label and activity groups.
- Get Info opens a song info dialog with composer, genre, release date, disc and
  track, duration, content rating, ISRC, label, and copyright. It is text only,
  and nothing in it is navigable.
- Creating a playlist or folder lets you choose a parent folder.
- Edit in Apple Music appears on an editable library playlist in the sidebar
  pin, the playlist list on `#/library/playlists`, and the playlist page header.
  Its click calls `open_subscribe_link` with
  `https://music.apple.com/library/playlist/{id}` once. Search results, albums,
  songs, catalog playlists, read-only playlists, folders, and Home cards do not
  show it. An E2E build (feature `e2e`) does not open a link: `open_in_default_browser`
  appends `{"url": ...}` to `opened-links.jsonl` in the isolated profile root,
  for every opener. The checks count that file's lines before and after each
  click: a shown area adds exactly one line with the playlist URL, and the
  absent probes add none.

Failure scenarios to cover before changing production code:

- Replay shows an error when the account has no Replay data, instead of hiding
  the shelves.
- Replay shows another year's data, or requests a year other than `latest`.
- A label page shows another label's releases, because it reuses a previous
  label's response.
- An album's record label link is missing, or opens the wrong label's page.
- An album's More section sits outside the centered page column instead of
  lining up with the album header.
- A library album request asks for `record-labels`, which Apple does not
  document for library albums and may refuse.
- An activity page loads more than 10 playlists, or pages past the first
  response without a limit.
- Search drops the new record label and activity groups, or files results under
  the wrong group.
- Get Info shows another song's fields, or renders the song's metadata as HTML
  instead of plain text.
- A playlist created "in" a folder lands at the root.
- Edit in Apple Music is missing from an editable library playlist in the
  sidebar pin, the playlist list, or the playlist page header.
- Edit in Apple Music shows in search results, on an album, on a song row
  (playlist page or album page), on a catalog playlist, on a read-only library
  playlist, on a folder, or on a Home card.
- Clicking Edit in Apple Music opens a URL that is not on `music.apple.com`, or
  names another playlist's ID.
- Clicking Edit in Apple Music opens the link more than once.
- A real browser page opens during the test, because a click reached the real
  `open_subscribe_link` command instead of the E2E build's recording path.

Check names:

- `Replay shows this year's top songs, albums, and artists`
- `Replay with no data shows an empty state, not an error`
- `a record label page shows its latest and top releases`
- `an album's More section lines up with its header, and its record label opens its label page`
- `an activity page lists its playlists`
- `Search shows record labels and activities`
- `Get Info shows the song's composer, ISRC, and label as plain text`
- `New playlist can be created inside a folder`
- `Edit in Apple Music shows for an editable library playlist in the sidebar, the playlist list, and the playlist page, and opens its music.apple.com library link once`
- `Edit in Apple Music is absent from search results, albums, songs, catalog playlists, read-only playlists, and folders`

Artifacts: `catalog-extras-groups.json` is the per-group trace: the fixture
requests and transitions each check caused, keyed `replayData`, `replayEmpty`,
`label`, `albumLink`, `activity`, `search`, `info`, `folder`, `editShown`, and
`editAbsent`. The Edit in Apple Music checks put each recorded
`opened-links.jsonl` line and each area's result in the report.json check
details. The harness
also writes `catalog-extras-trace.json`, but it does so after the scenario's
reset, so that file holds the post-reset snapshot and not the scenario's
requests. Screenshots: `screenshot-catalog-replay.png`,
`screenshot-catalog-label.png`, `screenshot-catalog-activity.png`, and
`screenshot-catalog-info.png`.

## UI audit fixes

`scripts/e2e-ui-audit.js` is the `ui-audit` scenario. It runs in the native
suite before Session restore. It writes `ui-audit-trace.json` and these
screenshots to the artifact folder: `screenshot-ui-audit-now-playing.png`,
`screenshot-ui-audit-narrow-player.png`, `screenshot-ui-audit-shelf.png`, and
`screenshot-ui-audit-queue.png`. Each check's `detail` holds the measured
values.

Failure scenarios to cover before changing production code:

- Now Playing's Up Next list stretches a few rows over the full panel height,
  leaving large gaps between rows. The list is a grid that grows to fill its
  panel.
- At 720 px wide or less, the absolutely positioned queue button in the player
  bar covers the Favorite button.
- A card shelf with only one or two cards stretches its grid columns while each
  card stops at its 320 px maximum width, so cards sit unevenly with large gaps.
  This applies to artist, album, label, and Home shelves.
- After keyboard navigation, the focused page heading (`h1` with
  `tabindex="-1"`) shows the browser's default focus ring.
- The playing row in Playing Next shows two tints, because the row container
  and the row button both use the active background.
- The selected Search source tab uses accent text on an accent tint and is hard
  to read.
- The licenses dialog lets Tab move focus behind it, does not return focus to
  the button that opened it, or shows "No packages found." when the license list
  fails to load instead of an error.
- A modal dialog (reset settings, keyboard shortcuts, Get Info, update ready,
  playlist dialogs, Now Playing, the narrow sidebar drawer, and licenses) lets
  Tab leave it, or loses its opener's focus on close, after the dialogs move to
  one shared focus-trap hook.
- Home marks its whole feed as a live region, so a screen reader reads the
  entire feed again on every refresh.
- Home's "Some Home sections could not be refreshed" notice has no button to
  try again.
- Home's date never updates after midnight.
- A Home section's eyebrow repeats its heading, for example "Recently played"
  above "Recently Played".
- A long record label description fills the page header instead of collapsing
  behind More.
- A Windows media control command (play, pause, next, previous, seek, shuffle)
  fails without any log line, or its listener fails to start without any log
  line.
- Text in the main views renders smaller than 11 px.
- On wide windows the content column stays at 960 px and leaves large empty
  margins. It should grow to 1180 px.
- The curator, record label, and activity pages behave differently for sign-in,
  loading, and error states after they move to one shared page scaffold.
- A screenshot taken right after a theme change captures the theme cross-fade.
  The `settings-*-narrow-dark.png` screenshots in `scripts/e2e-polish.js`
  showed a dimmed mid-transition frame. The screenshot must wait until the
  theme transition ends.

Check names:

- `Up Next rows in Now Playing stack without gaps when only a few songs are queued`
- `at 360 px the queue button does not cover the Favorite button`
- `a shelf with two cards keeps the same card width as a full shelf`
- `the page heading shows no focus outline after keyboard navigation`
- `the playing row in Playing Next has one even highlight`
- `the selected Search source tab uses the main text color`
- `the licenses dialog keeps Tab inside, returns focus to its opener, and shows an error when licenses fail to load`
- `modal dialogs keep Tab inside and return focus to their opener`
- `Home announces refreshes in one status line instead of the whole feed`
- `Home's refresh notice offers a Try again button`
- `a long record label description is collapsed behind More`
- `a failed Windows media control command is written to the log`
- `no text in the main views is smaller than 11 px`
- `the content column grows to 1180 px on wide windows`

Failure modes 11, 12, and 17 are checked by reading the code and by the
existing Home, curator, label, and activity checks staying green. They have no
new check. Failure mode 18 is guarded by the polish scenario waiting for the
theme transition before its dark screenshots.

## Release-only evidence

The following checks require a Windows release environment and are kept out of
the deterministic smoke gate:

- Azure Artifact Signing credentials and the signing client are required to
  prove Authenticode signatures on x64 and ARM64 installers.
- A real signed x64 and ARM64 canary installer is required to prove install,
  restart, architecture selection, and rollback behavior.
- A published, signed updater manifest and its installer/signature sidecar are
  required to prove the live stable or beta feed, and the update-ready dialog
  (it opens only once a real installer has downloaded; Install hands off to
  the NSIS installer). Use the existing read-only
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
- Lid close (second audit item 3), on a Modern Standby laptop with Apple Music
  playing: close the lid with the display off and no external monitor. Arlet
  pauses once, and the stream is released after about 1 min. Docked with the
  lid closed and an external display on, or the display timing out with the
  lid open, does not pause.
- Suspend and output change (item 1), on a real Windows desktop with Apple
  Music signed in and a second device on the same account:
  - Sleep or hibernate the PC while playing. Arlet is paused on resume, and
    the stream is released after about 1 min so the second device can play.
  - Unplug the headphones or disconnect Bluetooth while playing. Arlet pauses
    once. A default output change while paused does nothing.
  - Lock the screen while playing. Playback continues, by design.
- `End of track` pauses at the next item change, so a brief bleed of the next
  song may be audible on MusicKit before the pause lands. Listen for it on
  protected and unprotected tracks.
- A signed-in Apple Music account is required for the 0.2.0 behavior the
  fixture only models from MusicKit's documented and bundled shapes:
  - Starting a song mid-playlist with shuffle on plays that song first
    (`setQueue` `startWith`), and the shuffle button reflects `shuffleMode`.
  - Queue remove, move, and clear use `Queue.splice` without restarting audio.
    On a runtime without it, the same edits rebuild the queue and briefly
    restart audio, one edit at a time (see "Queue editing"'s forced-rebuild
    block, Phase 9: edits serialize per instance with a 20 s watchdog, and the
    double Move up and Move+Remove serial scenarios run there).
  - A library-only (uploaded) song plays from the `songs` descriptor.
  - Favorite, Dislike, clear, and Add to Library reach Apple (check the Music app).
  - Autoplay continues after the queue ends when enabled.
  - `Start Station` for a catalog song, a library song, and an artist; Top
    Songs for a library artist.
  - A restored session resumes at the saved song and position.

Beta.5 real-account checks, on a signed-in Apple Music account with Arlet's
developer token. The E2E harness does not run these:

1. Repeat All and Repeat One at a song's natural end, and Next and Previous with
   Repeat One.
2. Autoplay with Arlet's developer token: the status of
   `POST /v1/me/stations/continuous`, whether the Autoplay heading shows, and
   Play timing with autoplay on and off.
3. Bitrate: whether `playbackBitrateDidChange` fires, and which song the new
   quality starts on.
4. No-subscription account: previews play, the Previews only notice shows, and
   Subscribe opens the Apple page.
5. Shuffle mid-album, and a playlist with a duplicate song.
6. Clicking a Playing Next row: no flash in the player or the Windows media
   controls.
7. A station: Shuffle and Repeat are hidden, and Play Next shows the message.
8. A natural song end: the Windows media controls do not flicker.
9. A parked queue resumed with shuffle on keeps its order.
10. Replay on an account with no Replay data shows no error.
11. Album label links on library albums: the label comes from the catalog
    twin's `include=record-labels`.

These external gates are intentionally opt-in and must run only on the release
VM or a test machine with the appropriate credentials and signed artifacts.

`--skip-e2e` remains available for a non-release local diagnostic run, but
`test:all --require-clean-proof --skip-e2e` is rejected so a release quality
proof cannot be created with the built smoke gate omitted.
