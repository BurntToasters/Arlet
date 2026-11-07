> [!NOTE]
> 🅱️ This is a Beta build.

# ⬇️ Downloads

| <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/windows.png" /> Windows                                                                                                          | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/mac.png" /> macOS | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/linux.png" /> Linux |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/Arlet/releases/download/v0.4.0-beta.7/Arlet-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/Arlet/releases/download/v0.4.0-beta.7/Arlet-Windows-arm64.exe) |                                                                                                         |                                                                                                           |

> Arlet requires Windows 10 version 22H2 (build 19045) or newer.

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures — they are for Tauri V2's
> updater to verify the integrity of updates before downloading and installing.
>
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public
> Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
>
> This app is currently unstable. Bugs, issues, and rough edges are expected.
> The `v0.4.0` betas are very unstable, and `v1.0.0` will be the first stable release.

### ℹ️ Enjoying Arlet? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Arlet! An Apple Music client for Windows built on Tauri V2!

## Changes in `v0.4.0-beta.7:`

- **Ver:** Updated version to `v0.4.0-beta.7`.
- **Fix:** Artist pages in your Library show all of the artist's albums again. Albums that already loaded stay when a later page fails, and Arlet falls back to the artist's catalog albums when Apple can't load the library albums.
- **Fix:** The More button on album and playlist pages lines up with the other header buttons.
- **Fix:** Up Next in Now Playing no longer spreads a few queued songs down the whole panel.
- **Fix:** In narrow windows, the queue button in the player bar no longer covers the Favorite button.
- **Fix:** A shelf or grid with only a few cards keeps the same card size as a full one.
- **Fix:** The Open Source Licenses dialog shows an error when the licenses can't be loaded, instead of "No packages found."
- **UI:** Every dialog keeps Tab inside it, closes with Escape, and returns focus to whatever opened it. This covers Now Playing, the keyboard shortcuts overlay, Get Info, the playlist dialogs, the reset and update dialogs, the licenses dialog, and the sidebar in narrow windows.
- **UI:** Wide windows use more of the screen: the page column grows to 1180 px instead of 960 px.
- **UI:** No text in the main views is smaller than 11 px, and page headings no longer show a focus outline after keyboard navigation.
- **UI:** The selected tab in Search and Diagnostics is easier to read, and the playing song in Playing Next has one even highlight.
- **UI:** When Home can't refresh, its notice has a `Try again` button. Screen readers hear one short status update instead of the whole Home feed.
- **UI:** Long record label descriptions are folded behind `More`.
- **Codebase:** With Debug Mode on, failed Windows media control commands (play, pause, next, and so on) and media session updates are written to the log.
- **Codebase:** All dialogs share one focus-handling hook. The controller, library loader, Library, Search, and album and playlist page code are split into smaller files. Curator, record label, and activity pages share one page layout.
- **Docs:** `SECURITY.md` explains why MusicKit JS is loaded from Apple's servers without a pinned version, and how Arlet limits that risk.
- **Testing:** Added a native end-to-end `ui-audit` scenario covering every fix above. Fixed timing flakes in the polish, ui-audit, and catalog-extras scenarios. Runs save reports, traces, and screenshots for repeatable verification.
- **Carry-forward:** Everything in `v0.4.0-beta.6` is still included below.

## Changes in `v0.4.0-beta.6:`

- **Ver:** Updated version to `v0.4.0-beta.6`.
- **NEW - Edit in Apple Music:** Right-click one of your playlists in the sidebar, on Library › Playlists, or on the playlist's page and choose `Edit in Apple Music`. It opens the playlist on music.apple.com in your browser, where you can rename it, reorder or remove songs, or delete it. Apple's public API doesn't allow these edits from inside Arlet. The option appears only on playlists you can edit.
- **Carry-forward:** Everything in `v0.4.0-beta.5` is still included below.

## Changes in `v0.4.0-beta.5:`

- **Ver:** Updated version to `v0.4.0-beta.5`.
- **Fix:** Repeat One and Repeat All were swapped. Repeat One now shows a Repeat-1 icon, and with Repeat One on, Next and Previous move between songs.
- **Fix:** Shuffle covers the whole album or playlist, including the songs before the one you started, as in Apple Music. Turning shuffle off returns to the album or playlist order after the current song, including playlists with the same song twice.
- **Fix:** Resumed queues and queue edits are no longer reshuffled, and choosing a song in Playing Next with shuffle on plays that song in the order you see.
- **Fix:** Choosing a song to play next no longer flashes the player or the Windows media controls.
- **UI:** On stations, Shuffle and Repeat are hidden, and Play Next, Play Later, and Clear explain why they're unavailable.
- **NEW - Autoplay:** Autoplay songs show under their own `Autoplay` heading with an on/off toggle. Play Later goes before them, and Clear keeps them. Turning Repeat on turns them off. They're never saved into your queue, a playlist, or a handoff.
- **NEW - Audio quality:** A new setting with High (256 kbps, the default), Standard (64 kbps), and Automatic. It applies from the next song, and Settings shows the current streaming bitrate.
- **UI:** Without an Apple Music subscription, Arlet shows a `Previews only` notice with a Subscribe button that opens Apple's page.
- **NEW - Replay:** Home has Replay shelves.
- **NEW - Record labels:** Record label pages, linked from albums, and Record Labels results in Search.
- **NEW - Activities:** Activity pages, and Activities results in Search.
- **NEW - Get Info:** A Get Info dialog for songs.
- **NEW - Folder choice:** When creating a playlist or folder, you can choose a folder for it.
- **Docs:** Added a MusicKit feature coverage document. It lists what Arlet supports, what it leaves out on purpose (such as lyrics, music videos, Lossless, and Atmos), and what Apple's public API doesn't allow.
- **Carry-forward:** Everything in `v0.4.0-beta.4` is still included below.

## Changes in `v0.4.0-beta.4:`

- **Ver:** Updated version to `v0.4.0-beta.4`.
- **Fix:** Queue edits now serialize per queue instead of racing: two quick Move up/down clicks apply in order on runtimes without MusicKit's `Queue.splice`; a watchdog abandons an edit that hangs more than 20 s and reloads the queue.
- **Fix:** Save as playlist sends the queue in batches: one create carries the first 100 tracks, then sequential adds of up to 100. If a batch fails, the playlist keeps the saved songs and the dialog reports how many were saved versus how many could not be added.
- **Fix:** A Play whose queue setup fails no longer discards a restored (parked) queue: the drawer keeps all songs, the saved position, and the saved session file; retrying Play starts the same queue.
- **Fix:** A cached playlist or album whose refresh fails on a later page no longer collapses to its first page: the previous full list stays, the cache keeps its last complete copy, and the failure shows an error note.
- **Fix:** Failed favorites lookups no longer leave the view stuck on "Checking favorites…"; it settles with a "Could not check favorites" state and works once the lookup succeeds.
- **Fix:** Shortcuts stay inert underneath open dialogs: the reset-settings confirmation (`role="alertdialog"`) plus Ctrl+K, Ctrl+R, and Alt+Arrow no longer act behind it, while Escape still cancels.
- **Fix:** Play Next or Play Later pressed while a queue setup is still running now applies against the new queue in order instead of landing in the old provider queue.
- **Security:** The main window no longer gets a generic clipboard-read permission. Context-menu Paste calls a single `paste_clipboard_text` command after a trusted-gesture and editable-target check.
- **Codebase:** Rust backend hardening: the music-diagnostic window opens asynchronously (fixes a Windows deadlock); it uses the E2E profile directory in test builds; the library cache caps per-section pages/bytes (512 pages / 64 MiB) evicting the oldest; the bundled-origin check compares the full origin including the port; reset-settings runs off the UI thread; settings temp files are removed after failed saves; the SMTC display-change key no longer collides on U+001F in titles.
- **Testing:** Added native end-to-end checks for batched save-as-playlist with partial failure (600-song sequential-add assertion, short-save single create, failed-add keeps 300 and stops), loader robustness for cached pages, restore integrity after a failed Play, clipboard paste permissions, shortcuts staying inert around dialogs, and Play Next/Later during a slow Play. Runs save reports, traces, and screenshots for repeatable verification.
- **Carry-forward:** Also fixed and tested in this release, building on `v0.4.0-beta.3`: progress-bar seeking, pinned playlist covers after a restart, Previous restarting a song more than 3 seconds in, Repeat All looping the whole collection, mini-player monitor rescue, Browse shelf recovery after a failed refresh, and late search/queue/mini-player fixes. All `v0.4.0-beta.3` changes are included below.

## Changes in `v0.4.0-beta.3:`

- **Ver:** Updated version to `v0.4.0-beta.3`.
- **Fix:** Clicking or dragging the progress bar seeks to where you release it, including when going back. Playback updates during a click no longer cancel it, and the playhead stays at the new position instead of jumping back while the song catches up. This applies to the player bar and Now Playing.
- **Fix:** Pinned playlists with custom covers show their cover after a restart instead of a blank image, and a cover that can't load shows the playlist icon.
- **Fix:** Previous more than 3 seconds into a song restarts it, as in Apple Music, instead of skipping to the song before. This includes a queue restored after Arlet restarts. Pressed on the song you started from, Previous steps back through the whole album or playlist instead of stopping 20 songs back.
- **Fix:** Repeat All loops through the whole album or playlist, as in Apple Music, when you start from a song in the middle. Before, it only looped from the song you picked. Turning Repeat All off on the last song stops at the end again, Next stays available on the last song in the Windows media flyout and taskbar, and a restored queue goes around from the last song to the first and back.
- **Fix:** Leaving the mini player after the monitor Arlet was on is disconnected opens the window on a connected screen, centred and at its usual size, instead of off-screen.
- **Fix:** A Browse shelf can load more again after a refresh fails while its next page is loading, instead of staying stuck until the next successful refresh, and Load more during a refresh no longer adds songs from the charts being replaced.
- **Fix:** Also fixed in `v0.4.0-beta.2`: a late search page no longer replaces songs playing from your Library, a queue rebuild no longer undoes a newer Pause, and the mini player keeps its layout after the window recovers from a crash.
- **Codebase:** Development and CI use Node.js `26.13.0` and npm `12.2.1`. Node.js `24.22.1` or newer still works but is deprecated, and Node.js 22 is no longer supported.
- **Codebase:** Beta releases update the beta update feed as soon as they are signed and uploaded again.
- **Testing:** Added native end-to-end checks that click and drag the progress bar with real mouse input during playback updates, slow seeks, and overlapping seeks. Runs save reports for review.

## Changes in `v0.4.0-beta.2:`

- **Ver:** Updated version to `v0.4.0-beta.2`.
- **Security:** Signing out blocks retained library data, pinned playlists, and saved queues until cleanup succeeds, preventing the previous account's data from reappearing after a failed deletion. Cleanup failures are reported, and signing in again to the same account keeps its parked queue.
- **Security:** Updated updater dependencies to address archive extraction vulnerabilities while keeping system proxy support.
- **UI:** Refined Now Playing's artwork bloom with softer colors, a shared reading scrim, and subtle grain. Playback and volume controls stay accessible in narrow layouts.
- **Codebase:** Branch setup helpers refuse to reset or replace branches when edited files, untracked files, or unpublished commits could be lost.
- **Codebase:** Release checks require more remaining Apple Music token lifetime, and weekly renewal warnings start earlier.
- **Testing:** Native end-to-end runs use isolated temporary profiles, bounded debugging connections, and verified process cleanup. Startup failures save runtime diagnostics and process logs for review.
- **Testing:** Added native account-cleanup failure checks and expanded artwork, clipboard, search, and keyboard coverage. Runs retain reports, traces, and screenshots for repeatable verification.
- **Tauri:** Updated Tauri to `2.12.5`.
- **PKG:** Updated packages.

## Changes in `v0.4.0-beta.1:`

- **Ver:** Updated version to `v0.4.0-beta.1`.
- **UI:** Artwork colors bloom behind Now Playing, the mini player, and album, playlist, and curator headers. Now Playing's bloom moves during playback and pauses when playback stops.
- **UI:** Popovers, dialogs, drawers, notifications, and the song selection bar use consistent frosted surfaces in light and dark themes.
- **UI:** Media search suggestions show artwork thumbnails and item types alongside their titles. Text suggestions and recent searches remain text-only.
- **UI:** `Settings` > `About` keeps the installed version and active update channel visible, with runtime details and readable project links behind `Show More` / `Hide More`. Debug Mode and Reset are grouped in a collapsed `Advanced` section, and the layout fits narrow windows.
- **UI:** Now Playing's bloom respects reduced-motion preferences. High-contrast mode hides player blooms and uses solid surfaces for popovers, dialogs, and notices.
- **Testing:** Expanded native end-to-end checks cover artwork fallbacks, bloom playback state, reduced motion, frosted surfaces, and settings disclosures, including keyboard controls and narrow layouts. Runs save reports and screenshots for review.

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
- **Code Signing:** Windows releases are fully signed using Azure Artifact Signing.
- **Windows installers:** Separate x64 and Arm64 installers are provided for their respective architectures.
