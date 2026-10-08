<p align="center">
  <img src="src-tauri/icons/64x64.png" width="64" height="64" alt="Arlet app icon" />
</p>

<h1 align="center">Arlet</h1>

<p align="center">
  A better Windows Apple Music client, built with Tauri v2 and MusicKit on the
  Web. Arlet is in alpha development.
</p>

<!-- arlet-downloads:start -->
<p align="center">
  <a href="https://github.com/BurntToasters/Arlet/releases/download/v0.1.2/Arlet_0.1.2_x64-setup.exe"><img src="https://img.shields.io/badge/Download-Windows_x64-e8584c?style=for-the-badge" alt="Download Arlet for Windows x64" /></a>
  <a href="https://github.com/BurntToasters/Arlet/releases/download/v0.1.2/Arlet_0.1.2_arm64-setup.exe"><img src="https://img.shields.io/badge/Download-Windows_Arm64-e8584c?style=for-the-badge" alt="Download Arlet for Windows Arm64" /></a>
</p>
<!-- arlet-downloads:end -->

<p align="center">
  <sub>Windows 10 22H2 or newer. <a href="https://github.com/BurntToasters/Arlet/releases/latest">All releases and signatures</a></sub>
</p>

## Screenshots

<p align="center">
  <img src="media/arlet2.png" width="900" alt="Arlet's Recently Added page: a grid of album and playlist artwork from the Apple Music library" />
  <br />
  <sub>Your library: recently added albums and playlists.</sub>
</p>

<table>
  <tr>
    <td width="50%" align="center">
      <img src="media/arlet1.png" alt="Arlet's Browse page listing Apple Music top songs with artwork, artists, and durations" />
      <br />
      <sub>Browse Apple Music charts.</sub>
    </td>
    <td width="50%" align="center">
      <img src="media/arlet3.png" alt="Arlet's Settings page with account, update channel, theme, and window material options" />
      <br />
      <sub>Settings: account, updates, theme, and Mica or Acrylic.</sub>
    </td>
  </tr>
</table>

## Requirements

- Windows 10 version 22H2 (build 19045) or newer, or Windows 11. Older
  Windows versions are not supported.
- An Apple Music subscription for full-length playback.

## Development

1. Install Node.js (see `engines` in `package.json`), npm 12, and the Rust
   toolchain (`npm run rust:update`).
2. `npm ci`
3. Copy `.env.example` to `.env` and set `MUSICKIT_DEVELOPER_TOKEN`
   (`npm run phase0:mint-token` can mint it from your Media Services key).
4. `npm start`

## Checks

- `npm run test:all`: typecheck, lint, format, Vitest, script tests, Rust
  fmt/Clippy/tests, and the offline build smoke.
- `npm run test:e2e:app`: native E2E against a release build (Windows).

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): code layout and data flow.
- [docs/SECURITY.md](docs/SECURITY.md): capabilities, tokens, logging.
- [docs/RELEASE.md](docs/RELEASE.md): release machine setup and flow.
- [docs/TESTING.md](docs/TESTING.md): test boundaries and E2E.
