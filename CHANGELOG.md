# ⬇️ Downloads

| <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/windows.png" /> Windows                                                                                                    | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/mac.png" /> macOS | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/linux.png" /> Linux |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/Arlet/releases/download/v0.1.2/Arlet_0.1.2_x64-setup.exe) / [arm64](https://github.com/BurntToasters/Arlet/releases/download/v0.1.2/Arlet_0.1.2_arm64-setup.exe) |                                                                                                         |                                                                                                           |

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

## Changes in `v0.1.2:`

- **UI:** The song that is playing now is highlighted in playlists, albums, your library, search, and Browse. Animated bars replace its track number while it plays.
- **Fix - Queue:** Fixed an issue where the queue could stay on the previous song after a song from your library started playing.
- **Codebase:** Release builds now check with Apple that the MusicKit developer token works before anything is built.

## Changes in `v0.1.1:`

### IMPORTANT: v0.1.0 could not load your library. Update now!

Sorry about this one! In v0.1.0, signing in worked, but Home, Library, and every other part of your Apple Music library failed with a `403` error. v0.1.1 fixes it. If you are on v0.1.0, Arlet downloads this update in the background and asks you to restart when it is ready.

- **Fix - Library:** Fixed an issue where Home, Library, Recently Played, Recommendations, and playlists failed to load with a `403` error after signing in.
- **NEW - Reset settings:** `Settings` > `Reset` restores the default theme, window material, volume, and update settings, then restarts Arlet.
  - You stay signed in, and your pinned playlists and library are kept. Use `Sign out` in `Settings` to sign out.
- **Testing:** End-to-end tests now cover the settings reset and check that release builds use a developer token that can load your library.

## Changes in `v0.1.0:`

### The first public alpha of Arlet :)

- **NEW - Sign in:** Sign in with your Apple Music account and play your music with MusicKit.
- **NEW - Home:** Home shows recently played playlists, heavy rotation, and recommendations.
- **NEW - Browse:** Browse Apple Music charts and radio stations.
- **NEW - Search:** Search the Apple Music catalog and your library.
- **NEW - Library:** Library views for recently added, recently played, artists, albums, songs, and playlists, with playlist folders.
  - The library is cached for fast startup.
- **NEW - Playlists:** Create playlists and folders, add songs to playlists, and pin playlists to the sidebar.
- **NEW - Queue:** Play now, play next, play later, shuffle, and repeat.
- **Windows:** Media keys and the Windows media overlay show the current song and its progress.
- **UI:** Light, dark, or system theme with Acrylic, Mica, or solid window material.
- **Updater:** Automatic updates on the stable or beta channel.

## ℹ️ Release Info

- **GPG Signed:** My public key is attached to every release to ensure authenticity.
- **GPG Key:** You can get my public GPG key here: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc.
- **Code Signing:** Windows releases are fully signed using Azure Artifact Signing.
- **Windows installers:** Separate x64 and Arm64 installers are provided for their respective architectures.
