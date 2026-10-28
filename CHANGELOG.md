> [!NOTE]
> 🅱️ This is a Beta build.

# ⬇️ Downloads

| <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/windows.png" /> Windows                                                                                                          | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/mac.png" /> macOS | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/linux.png" /> Linux |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/Arlet/releases/download/v0.4.0-beta.2/Arlet-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/Arlet/releases/download/v0.4.0-beta.2/Arlet-Windows-arm64.exe) |                                                                                                         |                                                                                                           |

> Arlet requires Windows 10 version 22H2 (build 19045) or newer.

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal gpg signatures — they are for Tauri V2's
> updater to verify the integrity of updates before downloading and installing.
>
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public
> Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
>
> This app is currently unstable. Bugs, issues, and rough edges are expected.

### ℹ️ Enjoying Arlet? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

Arlet! An Apple Music client for Windows built on Tauri V2!

## Changes in `v0.4.0-beta.2:`

- **Fix:** (add release notes)

## Changes in `v0.4.0-beta.1:`

- **Ver:** Updated version to `v0.4.0-beta.1`.
- **UI:** Artwork colors bloom behind Now Playing, the mini player, and album, playlist, and curator headers. Now Playing's bloom moves during playback and pauses when playback stops.
- **UI:** Popovers, dialogs, drawers, notifications, and the song selection bar use consistent frosted surfaces in light and dark themes.
- **UI:** Media search suggestions show artwork thumbnails and item types alongside their titles. Text suggestions and recent searches remain text-only.
- **UI:** `Settings` > `About` keeps the installed version and active update channel visible, with runtime details and readable project links behind `Show More` / `Hide More`. Debug Mode and Reset are grouped in a collapsed `Advanced` section, and the layout fits narrow windows.
- **UI:** Now Playing's bloom respects reduced-motion preferences. High-contrast mode hides player blooms and uses solid surfaces for popovers, dialogs, and notices.
- **Testing:** Expanded native end-to-end checks cover artwork fallbacks, bloom playback state, reduced motion, frosted surfaces, and settings disclosures, including keyboard controls and narrow layouts. Runs save reports and screenshots for review.

## Changes in `v0.3.0:`

### IMPORTANT: THIS IS A SECURITY UPDATE. UPDATE NOW!

- **Security - HTTPS certificates:** Updated certificate verification to reject the compromised eMudhra (emSign) intermediate certificate authorities. Please install this update promptly. This includes `rustls-webpki 0.103.16` and `webpki-root-certs 1.0.10`.
- **Ver:** Promoted 0.3.0 from beta to stable. The changes below include the improvements from all six 0.3.0 betas.
- **NEW - Library sorting and filters:** Sort Albums, Artists, Songs, and Playlists, filter by text, and show favorites or explicit and clean content where supported. Arlet loads the rest of the section so filters cover your whole library, and remembers sorting and filter choices.
- **NEW - Select several songs:** Ctrl+click or Shift+click selects songs in Songs and on album and playlist pages. Play them next or later, add them to a playlist, or favorite them together. Drag songs onto a pinned sidebar playlist to add them.
- **NEW - Mini player:** The player bar button or Ctrl+Shift+M opens a small player with artwork, playback controls, progress, and an optional always-on-top setting. Exit it to restore the full window without interrupting playback.
- **NEW - Windows controls:** Arlet has taskbar playback buttons, a tray tooltip showing the current song, and an option to launch when you sign in to Windows. Startup opens in the tray when the tray icon is on, and minimized otherwise; uninstalling removes the startup entry. `Ctrl+/` or `?` opens the keyboard shortcut list.
- **NEW - Discovery:** Search has suggestions, recent searches, a top result, and `See all` results. Browse adds genres and city and daily charts; Radio adds genres and live station text. Curators have pages with their playlists.
- **NEW - Artist and album pages:** Artist pages have a banner, portrait, top songs, every album, and shelves for the latest release, singles, EPs, live albums, and compilations. Album pages show more music, runtime, year, and disc groups.
- **NEW - Automatic pause:** Playback pauses on sleep, when headphones disconnect, and after four hours without activity. A closed laptop lid with an external monitor still on keeps playing.
- **Fix - Playback on other devices:** After one minute paused, Arlet releases its Apple Music stream so it no longer interrupts playback on your phone. Resume returns to the same song and position; stations restart as stations.
- **Fix - Sign-in:** Expired or ended Apple Music sessions now show a banner with `Sign in again` and `Sign out`, keeping your library, pins, and queue. Sign-in can be cancelled, and signing out and back in refreshes personal pages without restarting Arlet.
- **Fix - Playback errors:** Apple Music errors explain what to try, such as stopping playback on another device or signing in again, instead of showing raw error codes. Errors received during sign-in are checked again when it finishes.
- **Fix - Playback and queues:** Library-only songs start faster, unavailable songs are skipped or retried appropriately, shuffle keeps its order after a pause, and long playlists resume and save as playlists in full. Queue edits and Windows media controls stay in sync.
- **Fix - Saving your place:** Quitting, installing an update, or resetting settings saves the latest playback position first. The window hides promptly while quitting.
- **Fix - Updates and connectivity:** Arlet reconnects after an offline start. A newer downloaded update replaces an older pending one only when ready, and a failed background check keeps the ready update available. Expired Apple Music access tells you to install the latest version.
- **UI:** Favorites use a star and Apple Music's wording. Artwork fills consistently sized cards, artist pictures load again, and Now Playing has artwork colors and fullscreen controls. Pages show loading placeholders, actions show confirmations, and keyboard and screen reader support is improved.
- **Improvement - Home and menus:** Home shows richer Apple Music content, cards have a menu and `Copy Apple Music link`, and Settings → About opens the project, release notes, and license in your browser without freezing Arlet.
- **Fix - Clipboard and notices:** Copying Apple Music links and diagnostics retries a busy clipboard and responds sooner. Expired sign-in and update notices no longer overlap.
- **Improvement - Speed and memory:** Long lists draw only visible rows, artwork downloads at its displayed size, ratings are requested together, and song details are reused. Library maintenance runs in the background and less-used views load when opened.
- **Improvement - Diagnostics:** Web view crashes leave a short log entry even with Debug Mode off. A weekly check warns if Apple changes the web player behavior Arlet relies on.
- **Security:** Apple Music paging rejects links outside Apple Music, built-in commands limit accepted data sizes, and interrupted library cache saves no longer leave partial data.
- **Testing:** Existing end-to-end checks cover the new discovery views, library sorting and filters, song selection and dragging, mini player window restoration, sign-in recovery, playback pauses, long queues, and saved sessions. Native runs save reports and screenshots for review.
- **PKG:** Updated dependencies, including the emergency certificate verification and trust store fixes.

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
- **Code Signing:** Windows releases are fully signed using Azure Artifact Signing.
- **Windows installers:** Separate x64 and Arm64 installers are provided for their respective architectures.
