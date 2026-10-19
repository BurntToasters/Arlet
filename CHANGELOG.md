# ⬇️ Downloads

| <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/windows.png" /> Windows                                                                                                          | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/mac.png" /> macOS | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/linux.png" /> Linux |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/Arlet/releases/download/v0.3.0-beta.5/Arlet-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/Arlet/releases/download/v0.3.0-beta.5/Arlet-Windows-arm64.exe) |                                                                                                         |                                                                                                           |

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

## Changes in `v0.3.0-beta.5:`

- **Fix - Signing back in:** After signing out and back in, your library, Home, and other personal pages load right away. Before, they kept failing with `403` until Arlet was restarted, because Arlet kept sending requests with the sign-in from before. A refused request now explains what to do instead of showing a bare `403`.
- **Fix - Expired sign-in check:** Errors that arrive while a sign-in is still finishing are now checked once it's done, so an expired sign-in shows its banner instead of leaving the app saying `Connected`.
- **UI - Favorites:** "Love" is now "Favorite" with a star, matching Apple Music. Favorited items show "Undo Favorite", and favorited songs show up in your Favorite Songs playlist in Apple Music.
- **Testing:** End-to-end tests now sign out and back in without a restart and check that library requests use the new sign-in and that a refused request never shows a bare `403`. The test version of Apple Music now replaces its connection on every sign-in, like the real one, so this can't come back unnoticed. The Favorite checks use the new wording.

## Changes in `v0.3.0-beta.4:`

- **Fix - "More than one device is trying to play music":** Arlet no longer pauses Apple Music on your phone while it sits paused, idle, or in the tray. A paused player kept renewing its stream with Apple in the background, so Apple counted Arlet as still playing. Now, after one minute paused, Arlet hands the stream back. It still shows the same song paused at the same spot, and pressing Play takes a moment longer to pick up where you left off.
- **NEW - Pause on sleep:** Arlet pauses when your PC goes to sleep or hibernates, and on laptops when the lid is closed and the screen turns off. A closed lid with an external monitor still on keeps playing.
- **NEW - Pause when headphones disconnect:** Unplugging headphones or losing a Bluetooth connection pauses playback instead of switching to your speakers. Plugging headphones in keeps playing.
- **NEW - Still listening?:** After 4 hours of playback with no activity in Arlet, it pauses and says so. Using the tray, media keys, or the Windows media controls counts as activity.
- **Fix - Sign-in expired:** After an Apple ID password change, Arlet no longer shows a bare `MEDIA_LICENSE` box while still saying `Connected`. A banner explains that the sign-in expired, with `Sign in again` and `Sign out`. Your library, pins, and queue are kept, and signing in again picks up where you were.
- **Fix - Ended sessions:** When Apple Music ends Arlet's session by itself, Arlet now shows the same banner instead of silently signing you out and clearing your library, pins, and queue.
- **NEW - Sign in again:** `Settings` → `Account` has a `Sign in again` button to refresh your Apple Music sign-in by hand. If that sign-in is cancelled, Arlet shows the expired banner instead of staying `Connected` without a sign-in.
- **NEW - Cancel sign-in:** A sign-in that is stuck on `Signing in…` can be cancelled from the title bar menu, Settings, or the banner.
- **Fix - Playback errors:** Errors from Apple Music now say what to try, for example to stop playback on another device or to sign in again, instead of showing a raw error code.
- **Fix - Shuffle after a pause:** With shuffle on, resuming after a pause or a restart no longer brings back songs you already heard. `Next` and `Previous` on a resumed queue keep the same order.
- **Fix - Stations:** Resuming a paused station restarts the station instead of playing its last few songs. While it waits to resume, its progress bar can't be dragged.
- **Fix - Offline start:** If Arlet started without a connection, it now reloads by itself when the connection comes back. The `Reconnect` button still works too.
- **Fix - Copying:** `Copy Apple Music link` and `Copy diagnostics report` now try a second way to reach the clipboard before saying it's busy, and answer sooner.
- **Fix - Updates:** A newer release now replaces an older update that downloaded but wasn't installed yet. The older one stays installable until the newer one has fully downloaded. A failed background check no longer hides an update that is ready to install.
- **Fix - Notices:** The expired sign-in banner and the "install the latest update" notice no longer overlap when both show.
- **Security:** Arlet's built-in commands now limit the size of everything they accept, such as now-playing text and saved library pages, so a misbehaving page can't feed them oversized data.
- **Improvement - Memory:** Saved ratings no longer grow for as long as Arlet stays open.
- **Testing:** End-to-end tests now check that a paused player hands its stream back after a minute and resumes at the same song and position. They also check that an expired or lost sign-in shows the banner without deleting anything, that `Sign in again` asks Apple for a fresh sign-in, and that cancelling a sign-in works. Further checks cover the 4-hour pause, the system pause signal, shuffle not repeating heard songs, and parked stations. A weekly check now warns if Apple changes the parts of Apple Music's web player that these fixes rely on. Test runs also no longer risk locking your Windows account through the web view's autofill, and a flaky artist page check was fixed.

## Changes in `v0.3.0-beta.3:`

- **Fix - Artwork sizes:** Cards on Home, Radio, Search, artist pages, and in your library are the same width again, with square artwork. In beta 2, each card was only as wide as its title, so artwork was tiny on short titles and huge on long ones, and the Play button sat beside the artwork instead of on it.
- **Fix - Artist pictures:** Artists in your library and their artist pages show the artist's picture again, instead of an icon or initials.
- **Fix - Artists without a picture:** Their placeholder icon is square again, instead of a thin strip.
- **Fix - Latest release:** The latest release at the top of an artist page is a little wider than other cards again.
- **Testing:** End-to-end tests now check that card artwork fills its card and is square, that cards in a row share a width, that the Play and `...` buttons sit on the artwork, and that artist pictures show in the library and on artist pages.

## Changes in `v0.3.0-beta.2:`

- **Improvement - Faster rendering:** Long lists, such as the library grid, the Up Next queue, and long song lists, only draw the rows you can see, so they stay smooth with large libraries. Playback progress no longer redraws the whole window.
- **Improvement - Sized artwork:** Artwork is requested at the size it's shown, so small covers download less and large ones stay sharp.
- **Improvement - Faster cache:** The library cache starts without waiting on maintenance, which now runs in the background.
- **Improvement - Fewer Apple requests:** Ratings for the songs, albums, and playlists on screen are requested together, and song details already on hand are reused instead of looked up again.
- **Improvement - Smaller startup:** Settings, Browse, Radio, curator pages, and release notes load when you first open them, so Arlet has less to load at startup.
- **NEW - Artist shelves:** Artist pages add shelves for `Latest Release`, `Singles & EPs`, `Live Albums`, and `Compilations`, next to `Top Songs` and `Albums`.
- **NEW - Album shelves:** Album pages show shelves of more music from the same source.
- **NEW - Search suggestions:** Search suggests matches as you type, lists your recent searches, and shows a top result. Each group of results has a `See all` button that loads more.
- **NEW - Browse charts and genres:** Browse lists genres, and its charts include city and daily charts. Each chart has a `Load more` button.
- **NEW - Radio genres:** Radio lists station genres, and live stations show their current song and other live text.
- **NEW - Curator pages:** Curators and Apple's editorial curators have their own pages, with their playlists grouped under their titles.
- **Improvement - Home:** Home shows richer resources from Apple Music.
- **Fix - Changes made in Apple Music:** When Apple Music signs out, changes the volume, or reports a different song length, Arlet follows it, so the player and Now Playing stay correct.
- **Improvement - Album and artist details:** Detail pages show the runtime and year, and albums with several discs are grouped by disc.
- **Improvement - Card actions:** Cards have a `...` button for their menu, and `Copy Apple Music link` copies the link to an item.
- **Improvement - Loading:** Pages show placeholder shapes while they load, so the layout doesn't jump when the content arrives.
- **Improvement - Now Playing:** Now Playing has a tint taken from the artwork's colors, clearer controls, and a fullscreen view.
- **Improvement - Success messages:** Actions that succeed, such as `Add to Library`, now show a short confirmation.
- **Improvement - About:** Settings → About has links to the project page, the release notes, and the license, opened in your browser.
- **Improvement - Keyboard and screen readers:** Menus, search suggestions, the volume slider, and cards are easier to use with the keyboard and with screen readers.
- **Fix - Paging:** Arlet only follows Apple's next-page links that point at Apple Music, so a malformed reply can't send requests somewhere else.
- **Fix - Saving the library cache:** A cache save that is interrupted no longer leaves half-written data behind.
- **Fix - Opening links:** Links from Settings open in your browser without freezing the window.
- **Testing:** End-to-end tests now check that long lists draw only what's visible, that artwork is sized to its place, that ratings are requested together, that the lazy views load on first use, that the artist and album shelves, search suggestions, `See all`, Browse charts and genres, Radio genres, and curator pages work, that Apple Music sign-out, volume, and song length changes are followed, that card actions, skeletons, Now Playing, success messages, and the About links behave, that paging rejects links outside Apple Music, and that old test run folders are cleaned up.
- **Fix - Quitting:** Quitting Arlet while a song plays, from the tray or by closing the window with the tray off, now saves where you were. Before, up to the last 30 seconds could be lost.
- **Fix - Playing Next:** Moving a song up or down moves the song you picked, even if the queue changed a moment before.
- **Improvement - Faster starts:** Songs that are only in your library (such as uploads) now start as quickly as other songs. If Apple Music can't start a song from the details Arlet sends, Arlet retries the usual way once instead of showing an error.
- **Fix - Songs Apple Music removed:** If a song can't start from its details and Apple Music no longer has it, Arlet skips it (or plays your library copy) instead of failing the whole Play.
- **Fix - Resuming after a restart:** A long playlist now resumes in full after you restart Arlet. Before, it stopped about 100 songs later. Restored songs also keep their explicit rating.
- **Fix - Media keys:** The keyboard's Previous key and the Windows media controls now work on the first song you play, like the Previous button in Arlet. Next stays available while more songs of a long playlist are still to be added.
- **Fix - Save as playlist:** `Save as playlist` in `Playing Next` now saves every song of a long playlist, including the ones not yet added to the queue.
- **Fix - Updates and Reset:** Installing an update or resetting settings now saves where you were first, as quitting does.
- **Fix - Expired versions:** A version of Arlet whose Apple Music access has expired now says to install the latest update, instead of saying you're offline.
- **Fix - Quitting:** With the tray icon off, closing the window now hides it at once while Arlet saves and quits.
- **Fix - Windows media controls:** The media overlay no longer stays out of date after a failed update, and the tray's `Play/Pause` plays again after playback has stopped.
- **Improvement - Crash records:** If Windows' web view crashes, a short note is now saved in the log even with `Debug Mode` off, so the problem can be found.
- **Improvement - Fewer requests:** Songs added to the queue in the background, and with `Play Next` or `Play Later`, are sent with their details, so Apple Music no longer looks each one up.
- **Release:** A release now needs a developer token with at least 150 days left, so it never expires before the weekly reminder to ship a new release.
- **Testing:** End-to-end tests now check that quitting saves the latest position, that library-only songs are queued as library songs, that a song Apple Music can't start from its details plays after one retry (or is skipped when Apple Music no longer has it), that a web view crash is logged, that the saved session and `Save as playlist` hold the whole playlist, that restored songs keep their explicit rating, that background additions send song details, that Windows offers Previous on the first song, and that an expired version shows the update notice.

## Changes in `v0.3.0-beta.1:`

- **NEW - Artist pages:** Artists get their own look: a banner over a soft, blurred photo of the artist, a round portrait, and a larger name. `Top Songs` shows the top ten, in two columns on wide windows, and `Albums` lists every album newest first, with its year.
- **Fix - Artist albums:** Artist pages from Apple Music (such as artists you open from a song) no longer say `No albums found`, and artists with more than 25 albums now list all of them.
- **Improvement - Faster starts:** Playing a song from a playlist or album page starts from the songs already on screen instead of loading them again. Arlet also hands Apple Music the song details it already has, so Apple Music no longer looks each song up before it starts.
- **Testing:** End-to-end tests now check that playing from a playlist page makes no extra requests and sends song details, that an artist lists every album newest first with years, and that the artist banner keeps its content inside it. A run with the real Apple Music developer token measures how song details skip Apple Music's lookup.

## Changes in `v0.2.6:`

- **Fix - Faster playlist starts:** Clicking a song now starts it directly. Arlet no longer queues the songs before it first and then switches to it, which took over a second. A playlist starts once the song you picked has loaded instead of waiting for every page, and only that song and the next 15 are queued before it plays; the rest is added while it plays. `Playing Next` now begins at the song you clicked, and `Previous` still goes back through the playlist.
- **Fix - Playlists failing to play:** Large playlists no longer fail with `Unable to read body as JSON`. That came from asking Apple for 500 songs at once; Arlet now asks for fewer and retries once if Apple's reply is unreadable.
- **Fix - Pinned playlists:** Pinned playlists keep their names in the sidebar instead of showing `Playlist` until you open them.
- **Fix - Playlist header:** Playlists with a large cover image no longer push their title, `Play all`, and `Shuffle` out of the header.
- **Fix - Artists:** When Apple doesn't name a song's artists, the player shows the song's artist text instead of `Artist 1, Artist 2`, and the right-click menu names each artist instead of listing several identical `Go to artist` items.
- **Fix - Ratings and song details:** Songs from library playlists no longer fail to load their rating, album, and artists.
- **Testing:** End-to-end tests now check that a clicked song starts MusicKit's queue with no re-select, that `Previous` steps back through the playlist (but not into a queue replaced elsewhere), that a first batch with no playable song moves on to the next, that a large playlist starts before its later pages load, that pins keep their names, that a large cover stays inside the header, that unnamed artists show the song's artist text, and that library playlist songs load their rating and details.

## Changes in `v0.2.5:`

- **NEW - Debug Mode:** A `Debug Mode` switch at the bottom of Settings, off by default. Arlet only saves its log file (`arlet.log`) while it's on, and turning it on or off takes effect right away. `Copy diagnostics report` works either way. If Arlet crashes or can't open its window, a short note about it is still saved so the problem can be found.
- **NEW - Songs list:** Clicking a song in `Songs`, `Recently Added`, or `Recently Played` now plays it and then the rest of the list, like the Apple Music app. Before, only that one song was queued.
- **Fix - Playlists and albums:** Clicking a song in a playlist that changed since you opened it (for example, a song added on another device) now plays the song you clicked, not whichever song moved into its place. If the song was removed, Arlet says so.
- **Fix - Add to Library:** Adding an item now confirms with `Added to your library.` and shows it in your Library without a manual refresh.
- **Fix - Signing in:** Closing the Apple Music sign-in window no longer clears your saved library and queue.
- **Fix - Diagnostics report:** If another app is holding the clipboard, `Copy diagnostics report` now tells you after a few seconds instead of doing nothing.
- **Fix - Settings:** If the settings file is damaged, Arlet's window style and tray icon now come from the backup at startup, matching the rest of your settings.
- **Fix - Stability:** One failing part of the app can no longer stop the player, queue saving, or the sleep timer from updating.
- **Improvement - Diagnostics:** The log now records how long each song takes to start playing, broken into steps, to help track down slow starts.
- **Testing:** End-to-end tests now check that Debug Mode keeps the log file off by default, starts and stops it right away, and is turned off by `Reset settings`, and that every Play records how long it took. They also cover playing a playlist that changed after it was opened and the `Songs` list queue. Arlet is now tested end to end only; the separate frontend unit tests were removed.

## Changes in `v0.2.4:`

- **Fix - Play next / later:** Adding a whole album or playlist to the queue no longer cancels an album or playlist you started playing while it loaded.
- **Fix - Signing out and in:** Volume, mute, the shuffle and repeat buttons, and the token reminder stay correct. Signing in as a different account no longer shows the old account's songs, ratings, Browse, Radio, or search results, and those pages reload instead of staying on a spinner.
- **Fix - Resuming your queue:** Pressing play on a restored queue only jumps to your saved spot if nothing else was started in the meantime. Pausing while a song is still loading now sticks, and pressing Space while it loads pauses it.
- **Fix - Pinned playlists:** A damaged pins file no longer overwrites your last good backup, and Arlet falls back to the backup when it loads.
- **Fix - Artists:** An artist in your library now lists every album they have, not only those on the first page of your library. If Apple can't return that list, Arlet shows the albums from your library instead of none.
- **Fix - Sleep timer:** `End of track` now pauses with Repeat One on, and when the same song is queued twice in a row. A timer set in minutes now pauses as soon as your PC wakes up if it ran out while the PC was asleep.
- **Fix - Queue editing:** Removing or moving songs no longer fails because one song in the queue can't be played. That song is skipped, and Arlet tells you.
- **Fix - Library:** Scrolling to the end of a long list while it refreshes no longer throws the refresh away, and a library that fails to clear on sign-out is never shown to the next account.
- **Fix - Apple limits:** When Apple asks Arlet to slow down, it now waits and retries as Apple asks. Playlist and editorial artwork that used to show as broken images now loads.
- **Fix - Menus and dialogs:** `Tab` closes the right-click menu, scrolling inside it no longer closes it, and opening it offline no longer shows an error. A slow reply can't close a playlist dialog you opened afterwards. The update prompt now opens above menus and dialogs.
- **Fix - Updates:** An open update prompt no longer closes by itself when Arlet checks for updates in the background.
- **Fix - Settings:** The drop-down menus show a focus outline again when you use the keyboard. Settings are saved in order, and a failed reset no longer blocks later saves.
- **Fix - Release notes:** Words like `snake_case_name` are no longer shown partly in italics.
- **Fix - Windows:** The window position and size are saved as you move it, and restore correctly on a second monitor with different scaling. If Windows' web view keeps closing right after Arlet starts, Arlet now stops and tells you instead of restarting forever. Startup errors show a message instead of silently exiting.
- **Security:** The main window can no longer be sent to another website, the Apple music diagnostic window stays on Apple sites, and Windows only fetches now-playing artwork from Apple's servers.
- **Improvement - Library cache:** The saved library now lives in your local app data instead of roaming with your Windows profile, cleans up songs you no longer have, and shrinks itself when it has grown large.
- **Improvement - Speed:** Large libraries scroll and update faster, and the diagnostics view no longer slows the app down while open.
- **Improvement - Logs:** The previous log file is kept when a new one starts, and `Clear logs` removes both.
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
