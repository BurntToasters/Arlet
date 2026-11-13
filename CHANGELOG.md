<!-- > [!NOTE]
> 🅱️ This is a Beta build. -->

# ⬇️ Downloads

| <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/windows.png" /> Windows                                                                                            | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/mac.png" /> macOS | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/linux.png" /> Linux |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/Arlet/releases/download/v0.4.0/Arlet-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/Arlet/releases/download/v0.4.0/Arlet-Windows-arm64.exe) |                                                                                                         |                                                                                                           |

> Arlet requires Windows 10 version 22H2 (build 19045) or newer.

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures — they are for Tauri V2's
> updater to verify the integrity of updates before downloading and installing.
>
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public
> Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
>
> Arlet is currently in beta. Bugs, issues, and rough edges are expected.
> `v1.0.0` will be the first stable release.

### ℹ️ Enjoying Arlet? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Arlet! An Apple Music client for Windows built on Tauri V2!

## Changes in `v0.5.0-beta.1:`

- **Security:** Arlet now downloads its signed Apple Music access token at launch and keeps the last valid copy for offline use, so Apple Music access no longer runs out with an app version. Versions 0.4.0 and older keep the token they were built with.
- **UI:** The Apple Music access notice says "Restart Arlet to refresh it." when access expires within 14 days or has expired.
- **UI:** If Arlet cannot download Apple Music access and has no saved copy, the offline banner appears, and Reconnect tries again.

## Changes in `v0.4.0:`

- **NEW - Edit in Apple Music:** Open a playlist you can edit on music.apple.com to rename it, reorder or remove songs, or delete it.
- **NEW - Autoplay:** Autoplay songs have their own heading and toggle. Play Later queues before them, Clear keeps them, and enabling Repeat turns them off. Autoplay is not saved into queues, playlists, or handoffs.
- **NEW - Audio quality:** Choose High (256 kbps, the default), Standard (64 kbps), or Automatic. The setting applies from the next song, and Settings shows the current bitrate.
- **NEW - Replay:** Replay shelves are available on Home.
- **NEW - Record labels:** Browse record label pages linked from albums and find them in Search.
- **NEW - Activities:** Browse activity pages and find activities in Search.
- **NEW - Get Info:** View song details in a Get Info dialog.
- **NEW - Folder choice:** Choose a folder when creating a playlist or folder.
- **Fix:** Repeat One and Repeat All now work and display correctly. Repeat One moves between songs with Next and Previous; Repeat All loops the full album or playlist, including restored queues.
- **Fix:** Shuffle covers the entire album or playlist, including songs before the starting track. Turning it off restores the original order after the current song, including duplicate tracks. Restored queues and queue edits are not reshuffled.
- **Fix:** Seeking in the player bar and Now Playing holds the released position through playback updates, slow seeks, and overlapping seeks.
- **Fix:** Previous restarts the current song after three seconds; from the starting song, it moves back through the full album or playlist instead of stopping at a fixed look-back limit.
- **Fix:** Queue edits apply in order, and a stalled edit is abandoned and reloaded instead of leaving the queue stuck.
- **Fix:** Play Next and Play Later during queue setup apply to the incoming queue. A failed setup preserves a restored queue, and choosing a song in Playing Next no longer flashes the player or Windows media controls.
- **Fix:** Save as playlist handles queues over 100 songs in batches and reports partial failures without losing songs that were already saved.
- **Fix:** Cached album and playlist pages keep their last complete results after a failed refresh. Browse shelves recover after refresh failures, and Load more no longer adds results from a shelf being replaced.
- **Fix:** Artist pages keep albums that already loaded and fall back to catalog albums when Apple cannot load library albums.
- **Fix:** Late search results no longer replace songs playing from Library, and a queue rebuild no longer undoes a newer Pause.
- **Fix:** Pinned playlists keep custom covers after a restart and show the playlist icon when a cover cannot load. The mini player also recovers on a connected display after its monitor is disconnected.
- **Fix:** Failed favorites lookups settle into a recoverable error state, and the Open Source Licenses dialog reports loading errors instead of showing an empty list.
- **Security:** Signing out blocks retained library data, pinned playlists, and saved queues until cleanup succeeds. Cleanup failures are reported, and a parked queue is retained only when signing back into the same account.
- **Security:** Context-menu Paste uses a trusted-gesture and editable-target check; the main window no longer has a generic clipboard-read permission.
- **Security:** Updater dependencies were updated to address archive-extraction vulnerabilities while retaining system proxy support.
- **UI:** Artwork blooms appear behind Now Playing, the mini player, and album, playlist, and curator headers. They move with playback, respect reduced-motion preferences, and are hidden in high-contrast mode.
- **UI:** Popovers, dialogs, drawers, notifications, and the song selection bar use consistent frosted surfaces in light and dark themes; high-contrast mode uses solid surfaces.
- **UI:** Media search suggestions show artwork and item types alongside titles; text suggestions and recent searches remain text-only.
- **UI:** Settings > About keeps the installed version and update channel visible, with runtime details and project links behind Show More. Debug Mode and Reset are grouped under Advanced, and the layout fits narrow windows.
- **UI:** Dialogs keep Tab inside, close with Escape, and return focus to the control that opened them. Keyboard shortcuts stay inactive behind dialogs.
- **UI:** Layouts work better at both sizes: wide windows use a page column up to 1180 px, text in main views stays at least 11 px, and narrow player controls no longer overlap. Up Next spacing, header buttons, and small shelves and grids are also more consistent.
- **UI:** Stations hide Shuffle and Repeat, and Play Next, Play Later, and Clear explain when they are unavailable.
- **UI:** Home refresh errors include a Try again button and a concise screen-reader status; long record label descriptions are folded behind More.
- **Codebase:** With Debug Mode on, failed Windows media control commands and media session updates are written to the log.
- **Docs:** Added MusicKit feature coverage and documented why MusicKit JS loads from Apple's servers without a pinned version, along with how Arlet limits that risk.

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
- **Code Signing:** Windows releases are fully signed using Azure Artifact Signing.
- **Windows installers:** Separate x64 and Arm64 installers are provided for their respective architectures.
