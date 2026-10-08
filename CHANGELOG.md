# ⬇️ Downloads

| <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/windows.png" /> Windows                                                                                            | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/mac.png" /> macOS | <img height="20" src="https://raw.githubusercontent.com/BurntToasters/bcls/main/media/linux.png" /> Linux |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/Arlet/releases/download/v0.1.3/Arlet-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/Arlet/releases/download/v0.1.3/Arlet-Windows-arm64.exe) |                                                                                                         |                                                                                                           |

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

## Changes in `v0.1.3:`

- **NEW - Support Me:** A small `Support Me` link with a heart sits above `Settings` in the sidebar. It opens https://rosie.run/support in your browser.
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
