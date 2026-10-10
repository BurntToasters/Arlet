# ⬇️ Downloads

| <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/windows.png" /> Windows                                                                                            | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/mac.png" /> macOS | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/linux.png" /> Linux |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/Arlet/releases/download/v0.2.4/Arlet-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/Arlet/releases/download/v0.2.4/Arlet-Windows-arm64.exe) |                                                                                                         |                                                                                                           |

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

## Changes in `v0.2.4:`

- **Fix - Play next / later:** Adding a whole album or playlist to the queue no longer cancels an album or playlist you started playing while it loaded.
- **Fix - Signing out and in:** Volume, mute, the shuffle and repeat buttons, and the token reminder stay correct. Signing in as a different account no longer shows the old account's songs, ratings, Browse, Radio, or search results, and those pages reload instead of staying on a spinner.
- **Fix - Resuming your queue:** Pressing play on a restored queue only jumps to your saved spot if nothing else was started in the meantime. Pausing while a song is still loading now sticks, and pressing Space while it loads pauses it.
- **Fix - Pinned playlists:** A damaged pins file no longer overwrites your last good backup, and Arlet falls back to the backup when it loads.
- **Fix - Artists:** An artist in your library now lists every album they have, not only those on the first page of your library.
- **Fix - Library:** Scrolling to the end of a long list while it refreshes no longer throws the refresh away, and a library that fails to clear on sign-out is never shown to the next account.
- **Fix - Apple limits:** When Apple asks Arlet to slow down, it now waits and retries as Apple asks. Playlist and editorial artwork that used to show as broken images now loads.
- **Fix - Menus and dialogs:** `Tab` closes the right-click menu, scrolling inside it no longer closes it, and opening it offline no longer shows an error. A slow reply can't close a playlist dialog you opened afterwards. The update prompt now opens above menus and dialogs.
- **Fix - Settings:** The drop-down menus show a focus outline again when you use the keyboard. Settings are saved in order, and a failed reset no longer blocks later saves.
- **Fix - Release notes:** Words like `snake_case_name` are no longer shown partly in italics.
- **Fix - Windows:** The window position and size are saved as you move it, and restore correctly on a second monitor with different scaling. If Windows' web view keeps closing right after Arlet starts, Arlet now stops and tells you instead of restarting forever. Startup errors show a message instead of silently exiting.
- **Security:** The main window can no longer be sent to another website, the Apple music diagnostic window stays on Apple sites, and Windows only fetches now-playing artwork from Apple's servers.
- **Improvement - Library cache:** The saved library now lives in your local app data instead of roaming with your Windows profile, cleans up songs you no longer have, and shrinks itself when it has grown large.
- **Improvement - Speed:** Large libraries scroll and update faster, and the diagnostics view no longer slows the app down while open.
- **Improvement - Logs:** The previous log file is kept when a new one starts.
- **Testing:** End-to-end tests now cover search, adding to playlists, creating playlists, and the diagnostics report, and the checks no longer rely on fixed waits. Every release now has to pass the full app tests first.

## Changes in `v0.2.3:`

- **Fix - Shuffle:** Turning shuffle on while a song is playing no longer shows a different song's title and artist in the player.
- **Fix - Scroll bar:** A stray horizontal scroll bar no longer appears around the player controls, and pages never scroll sideways.
- **Fix - Sidebar:** Long playlist names stay on one line and end with `…`. Hover over a name to see all of it. The account row at the bottom of the sidebar is no longer hidden behind the player.
- **Fix - Pinned playlists:** A pinned playlist shows its name even when it isn't in your loaded playlist list yet.
- **Testing:** End-to-end tests now cover turning shuffle on mid-song, long sidebar names, the sidebar and page ending above the player, and any sideways scrolling.

## Changes in `v0.2.2:`

- **Fix - Long playlists and albums:** Playlist and album pages now list every song instead of stopping at the first 100. The first songs show right away and the rest load in the background. Returning to a long playlist keeps your place instead of jumping back to the top.
- **NEW - Endless queue:** Playing a playlist longer than 500 songs now keeps going. Arlet adds the next songs as the queue runs low, and `Playing Next` shows how many are still to come. Shuffle keeps drawing from the whole playlist.
- **Fix - Queue:** Starting something else, playing a station, or `Clear` drops the rest of a long playlist, so its songs never end up in a different queue.
- **Testing:** End-to-end tests now cover long playlist pages, queue refills, and queues replaced mid-playlist.

## Changes in `v0.2.1:`

- **Fix - Playback:** Playlists and albums that include songs removed from Apple Music, or songs that are temporarily unavailable, now play. Arlet skips those songs and tells you how many it skipped, instead of failing with `Can't play`.
- **Fix - Starting song:** The song you click now always plays first, even when unavailable songs are skipped or shuffle is on. If the song you clicked is unavailable, the next available song starts.
- **Fix - Skipping:** When a song can't be played as it starts, Arlet now skips to the next song, like Apple Music. It stops after three failures in a row, and never skips for account problems such as an inactive subscription.
- **Fix - Play next and Play later:** One unavailable song no longer stops the rest of an album or playlist from being added.
- **Fix - Song lists:** Songs Apple Music can't stream are dimmed and can't be started from their row.
- **Fix - Large playlists:** Playing a very large playlist queues up to 500 songs around the one you chose, so it starts quickly and stays within Apple Music's request limits. Shuffle still picks from the whole playlist.
- **Testing:** End-to-end tests now cover removed and unplayable songs, songs that fail as they start, and very large playlists.

## Changes in `v0.2.0:`

- **NEW - Now Playing:** Click the artwork at the bottom left to open a full-window view with large artwork, controls, and `Up Next`. Press `Esc` to close it.
- **NEW - Radio:** `Start Station` in song and artist menus, in `Now Playing`, and on artist pages starts an Apple Music station based on that song or artist.
- **NEW - Top Songs:** Artist pages list the artist's top songs, with `Play`, `Shuffle`, and `Station` buttons.
- **NEW - Queue editing:** Remove, reorder (buttons or drag and drop), and clear songs in `Playing Next`, or save the whole queue as a playlist. Long queues now scroll smoothly.
- **NEW - Queue whole albums and playlists:** Album and playlist menus have `Play next` and `Play later`, which add every song without interrupting what is playing.
- **NEW - Shuffle:** Albums and playlists have a `Shuffle` button next to `Play`, and their menus have a `Shuffle` action.
- **NEW - Love and Dislike:** Love or dislike songs, albums, and playlists from their menus, or use the heart next to the playing song. Catalog items have an `Add to Library` action.
- **NEW - Go to album:** Click the song title at the bottom left to open the album or single it belongs to.
- **NEW - Go to artist:** Each credited artist under the title is its own link, so songs with several artists take you to the right page.
- **NEW - Context menus:** Every song menu now has `Go to album` and `Go to artist` actions. Playing songs and menus never change what is playing when you navigate.
- **NEW - Keyboard shortcuts:** `Space` plays and pauses, `Ctrl` + `←`/`→` skips, `Ctrl` + `↑`/`↓` changes volume, `Shift` + `←`/`→` seeks 10 seconds, and `M` mutes. Shortcuts never fire while you're typing, and `Settings` lists them all.
- **NEW - Mute:** Click the speaker icon to mute and unmute without losing your volume level.
- **NEW - Sleep timer:** Pause after 15, 30, 45, or 60 minutes, or at the end of the current song, from the timer button in the player.
- **NEW - Pick up where you left off:** Arlet remembers your queue and position and brings them back paused after a restart. Turn this off in `Settings` > `Playback`.
- **NEW - Autoplay:** When Apple Music supports it, `Settings` > `Playback` can keep similar music playing after your queue ends.
- **NEW - Tray icon:** Closing the window now keeps Arlet playing in the tray. Click the tray icon to show or hide Arlet, or right-click it for play/pause, next, previous, `Show Arlet`, and `Quit`. Turn off `Settings` > `Window` > `Show tray icon` to have the close button quit Arlet instead.
- **Windows:** The Windows media controls can now seek and change shuffle and repeat.
- **Fix - Playlists:** Playing a song in a playlist now keeps going through the rest of the playlist instead of stopping after that one song. `Play` also shows that it's working while a long playlist loads.
- **Fix - Albums:** Playing a song from an album detail page now continues through the album the same way.
- **Fix - Play now:** `Play now` from a song's menu in a playlist or album starts that exact entry in the full list, including songs that appear more than once.
- **Fix - Shuffle:** The shuffle button now shows the real shuffle state and turns shuffle on and off reliably. With shuffle on, the song you pick plays first and the rest are shuffled after it.
- **Fix - Playback:** The `Can't play` badge now clears once a song plays. Choosing a song in `Playing Next` keeps the songs before it, so `Previous` still works.
- **Fix - Repeat:** Errors from the repeat button are now shown instead of ignored.
- **Playback:** Repeat and shuffle settings carry over when you start a song from a playlist. From a song's menu, `Play next` and `Play later` add only that song.
- **Note:** Apple Music doesn't let other apps rename or delete playlists or remove songs from them, so Arlet can't either.
- **Testing:** End-to-end tests now cover playlist and album playback, shuffle and repeat, song navigation, failed lookups, queue editing, shortcuts and mute, ratings, Now Playing, radio and artist pages, the sleep timer, autoplay, Windows media controls, the tray icon, and session restore. Each run saves a repeatable report with screenshots.

## Changes in `v0.1.3:`

- **NEW - Support Me:** A small `Support Me` link with a heart sits above `Settings` in the sidebar. It opens https://rosie.run/support in your browser.
- **NEW - Window position:** Arlet now opens at the size and position you left it, including maximized. It falls back to the default if that spot is on a monitor that is no longer connected, and `Reset settings` forgets it.
- **Logo:** The title bar now shows the current Arlet icon instead of the old one.
- **Windows:** Installers are now named `Arlet-Windows-x64.exe` and `Arlet-Windows-arm64.exe`, so download links always point at the latest release.
- **Fix - UI:** Fixed an issue where a red outline sometimes appeared around the main part of the window after using the keyboard.
- **Fix - Search:** The `Apple Music` / `Your Library` switch is now centered with the rest of the Search page.
- **Fix - Settings:** The `Open-source licenses` and `Reset settings` windows now dim the whole app instead of a band down the middle.
- **UI:** `Settings` > `Appearance` now only shows a window material message when Windows can't use the one you picked.
- **Testing:** End-to-end tests now check that dialogs dim the whole window and that the page outline stays hidden.

## Click below for the full `v0` Changelog

<details>
<summary>Full v0 changelog</summary>

Nothing yet :)
</details>

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
- **Code Signing:** Windows releases are fully signed using Azure Artifact Signing.
- **Windows installers:** Separate x64 and Arm64 installers are provided for their respective architectures.
