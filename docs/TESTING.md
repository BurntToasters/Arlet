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
`src-tauri/target/e2e` with a synthetic MusicKit token, moves the per-user
Arlet data folders aside, launches the app with WebView2 remote debugging, and
drives it over the DevTools Protocol. It restores the data folders afterwards
and writes `e2e-artifacts/<timestamp>/report.json` (binary SHA-256, commit,
per-check results), `screenshot.png`, and the run's `arlet.log`. Close every
running Arlet first; the app is single-instance. `--skip-build` reuses the
last E2E binary. `npm run test:all -- --require-clean-proof` (every release
proof) runs this suite on Windows, so no release is recorded without it.

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
11. With Apple's CDN unreachable, the cached library is not shown.
12. A renderer crash leaves a blank window, or leaves no line in `arlet.log`
    (WebView2 failures are written even with Debug Mode off).

The harness itself must not lose the real data folders:

- Ctrl+C during a run leaves them moved aside. The run now restores them
  before exiting.
- A run killed outright (a `test:all` timeout, a closed terminal) cannot
  restore, and Windows gives it no signal to catch. The test profile carries
  a marker file, so the next run puts the backup back before it starts.
- Data without that marker is never deleted. With more than one backup, or
  unmarked data in place, the run stops and asks for a manual restore.
- Deleting the test profile fails (a WebView2 process still holds a file),
  and the run stops before it renames any backup back, so Arlet opens on the
  test profile until the next run.

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
  reorders a shuffled queue.
- A failed repeat or queue action is silent.
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

## Layout

- A horizontal scrollbar appears in the player or content area.
- Long pinned playlist names wrap into tall blocks in the sidebar and push
  the account row under the player bar instead of ending in an ellipsis.
- A pinned playlist that is not in the loaded playlist list shows as a
  generic "Playlist" until it is opened. Its name is now saved with the pin.
- A playlist with a large cover image pushes its title, Play all, and
  Shuffle out of the header to the far right (the art's wrapper took the
  image's natural width).

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
- Moving a song in Playing Next moves a different song when the queue
  shifted after the user picked it (a sync or top-up); the move must follow
  the song's ID. (Code-reviewed; the existing move checks cover the normal
  path, and the shift itself is not driven here.)
- `Save as playlist` saves only the songs already handed to MusicKit and
  leaves out the rest of a long playlist that the drawer says is coming.

## Ratings and library

- A ratings request uses the wrong ID kind (library vs catalog path).
- A queued song whose type says library but whose ID is a catalog ID (as
  MusicKit reports library playlist songs) is looked up on the library path:
  Apple answers 400 for its rating and 404 for its album and artists.
- When Apple names none of a song's artists, the player shows "Artist 1,
  Artist 2" instead of the song's artist text.
- Add to Library gives no confirmation and the item does not appear in
  Library until a manual refresh.
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
  open after a successful add.
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
Debug Mode off, because nothing else records it. That path is not driven
here.

## Rendering performance

`scripts/e2e-performance.js` runs inside the native suite against the MusicKit
fixture. It measures CDP `Performance` metric deltas (ScriptDuration,
LayoutCount, RecalcStyleCount, Nodes, JSHeapUsedSize) for steady playback, a
volume drag, a large library, Up Next, and artwork sizes. Every number is
written to the check `detail` and lands in `report.json`.

The metrics are relative. A report records numbers from one machine and one
run. Two ceilings are set; a check fails when its count is above one:

- `LIBRARY_CARD_MAX` (600): `.library-card` elements mounted in one library
  grid. The grid is virtualized, so this measures the viewport window, not the
  library size. The album and artist checks also require the scroll loop to
  reach the end (no `.library-load-more`) and the fixture to have answered all
  5000 items, counted by distinct id. Each step scrolls `.content-scroll` to
  its bottom and samples the mounted card count.
- `UP_NEXT_ROW_MAX` (120): `.now-playing-queue > li` rows that are not
  `aria-hidden`. The virtual spacer rows are not counted.

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

## UI polish and accessibility

`scripts/e2e-polish.js` runs inside the native suite (before Session restore)
against the `polish` fixture ids in `scripts/e2e-music-fixture.js`. It drives
the real UI over CDP and reads the fixture's snapshot for requests, queue and
volume. Each check is written to `report.json` with its observed values in
`detail`. The runner also writes `screenshot-polish.png` (the state at the end
of the scenario) and `polish-trace.json`; the per-check screenshots are not
written.

A check that fails names the gap in its `detail`. The album header menu has no
copy-link item (the hero carries no catalog URL), which is the one known gap at
this writing. A check failing means the source is behind the target below, not
that the test is wrong.

Toasts: a success toast carries `action-toast-success`. An error toast has no
class of its own, so the checks match it as an `.action-toast` that is not a
success.

F11 works while focus is in a text field or a dialog, by design: it has no
text-editing meaning, so it is a window action everywhere (`src/app/shortcuts.ts`).

Failure modes this pass must not have:

Album and playlist headers:

- A header button (Add to Library, Love, Pin/Unpin, "…") acts on the wrong
  item, such as the first track or the previously opened album.
- A header button does not reflect state: Love's `aria-pressed`, the Pin or
  Unpin label, or Add to Library's done state is stale after the library or
  ratings change.
- Love sends two requests for one click, or none.
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

- Love or Dislike writes a rating for another song, the wrong value, or drops
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
- A loved heart on a song row shows for an unloved song, or for the wrong row.
- QueueDrawer leaves focus on removed or hidden content after Esc.
- Search tabs ignore Arrow keys, or move focus without moving `aria-selected`.
- The explicit badge has no accessible name, or its name is only "explicit".
- A page state (loading, empty, error) renders without an `h1`.

Checks in `scripts/e2e-polish.js`, by the failure mode each one guards (the
check name is the `report.json` name):

| Check                                                                                                                               | Guards                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| polish fixture data reachable                                                                                                       | fixture route renders (kept from the first pass)                            |
| album metadata: year, song count, runtime from 703 s, genre                                                                         | invented values; total length                                               |
| sparse album shows only its song count                                                                                              | invented values; "NaN" or "0 min"; More shown with no content               |
| More toggle expands and collapses, with aria-expanded matching the panel                                                            | More toggle state                                                           |
| editorial notes are plain text: no markup element, no script ran                                                                    | notes render HTML or run script                                             |
| record label and copyright appear under More                                                                                        | label or copyright for the wrong item                                       |
| playlist description renders as plain text                                                                                          | description HTML or script                                                  |
| Disc 1 and Disc 2 headings group the four tracks in album order                                                                     | disc grouping                                                               |
| rows show per-disc track numbers                                                                                                    | disc numbering (not a listed failure mode; the spec for this pass)          |
| clicking the first row of Disc 2 starts MusicKit's queue at that song: [d2 t1, d2 t2] at index 0                                    | disc grouping breaks click-to-play                                          |
| the Disc 2 Play was given the whole album from the page: no track pages fetched                                                     | album re-fetched before Play                                                |
| Previous from Disc 2 track 1 plays Disc 1 track 2 (the album's earlier songs are kept)                                              | earlier songs dropped from Previous history                                 |
| a single-disc album shows no Disc heading                                                                                           | single-disc "Disc 1" heading                                                |
| header Love toggles once per click, sending one PUT then one DELETE                                                                 | Love sends two requests or none; aria-pressed                               |
| More actions opens the album menu and its target is the album                                                                       | "..." acts on the wrong item                                                |
| context menu has no leading, trailing or double separators                                                                          | separators doubled, leading or trailing                                     |
| ArrowDown visits each menu item once, wraps, and never lands on a separator                                                         | separators reachable by arrow keys                                          |
| album header menu offers Copy Apple Music link                                                                                      | copy-link missing (expected to fail; see above)                             |
| Escape closes the album menu and returns focus to its More button                                                                   | menu focus                                                                  |
| Pin and Unpin flip the playlist header label both ways                                                                              | Pin or Unpin label stale                                                    |
| album card carries its Apple Music link on the card shell                                                                           | copy-link URL                                                               |
| keyboard Tab from the card reaches its Play button, then its More actions button                                                    | card "..." not focusable                                                    |
| card menu offers Copy Apple Music link and has clean separators                                                                     | copy-link on a card                                                         |
| copy-link shows the success toast, not the error style                                                                              | success styled as error                                                     |
| copy-link copies the album's exact Apple Music URL                                                                                  | copy-link URL (read back only when the clipboard allows)                    |
| card Play starts the album from its first track                                                                                     | card Play starts the wrong collection                                       |
| Arrow, Home and End keys move selection, focus and the tabpanel label together                                                      | search tabs ignore Arrow keys                                               |
| open animation moves the dialog when motion is allowed (baseline)                                                                   | baseline for the reduced-motion check                                       |
| Now Playing controls carry their state labels                                                                                       | controls missing or stale labels                                            |
| volume slider reads a percentage and reaches the player                                                                             | volume writes or reads wrong                                                |
| seek slider reads m:ss of m:ss, not a raw number                                                                                    | slider aria-valuetext "NaN" or raw number                                   |
| artwork bgColor tints Now Playing through --now-playing-tint                                                                        | tint missing                                                                |
| a track without bgColor keeps the plain surface                                                                                     | tint on a track without bgColor                                             |
| closing Now Playing returns focus to the artwork button and unmounts it                                                             | focus after close; dialog left mounted                                      |
| reduced motion: opening Now Playing runs no transform animation                                                                     | animation with reduced motion                                               |
| reduced motion: closing Now Playing unmounts within 400 ms                                                                          | exit transition with reduced motion                                         |
| opening Playing Next moves focus to its heading                                                                                     | queue drawer focus                                                          |
| Escape closes Playing Next and returns focus to its toggle                                                                          | queue drawer focus after Esc                                                |
| a rejected rating shows the error style and rolls Love back                                                                         | error styled as success; rollback                                           |
| radio first load shows a labelled role=status skeleton, removed once data renders                                                   | skeleton stuck or unlabelled                                                |
| a failed first load ends the skeleton instead of keeping it                                                                         | skeleton on a failed load                                                   |
| Ctrl+R refresh keeps album cards on screen and shows no skeleton                                                                    | refresh replaces data with a skeleton                                       |
| About links are enabled type=button elements labelled Project page, Release notes and License, with no href or target (not clicked) | About link navigates the window, is missing, or is disabled                 |
| a route change moves focus to the page h1                                                                                           | route focus                                                                 |
| viewport override switches the shell to the compact layout (720 px)                                                                 | environment: the webview ignores the override (a failing check, not a skip) |
| opening the compact drawer moves focus into it                                                                                      | compact drawer focus                                                        |
| Escape closes the compact drawer and focuses the menu button                                                                        | compact drawer Esc                                                          |
| Tab on the last drawer control wraps to the first one                                                                               | compact drawer focus trap                                                   |
| F11 enters window fullscreen; the Now Playing button then reads Exit full screen                                                    | fullscreen state disagrees with the window                                  |
| Escape in Now Playing closes it and leaves fullscreen                                                                               | fullscreen sticks after Esc                                                 |

Fullscreen is read from the window size against the screen, because the app
uses window fullscreen and not DOM fullscreen (`document.fullscreenElement`
stays null).

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
