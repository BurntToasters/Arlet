# Arlet

A better Windows Apple Music client, built with Tauri v2 and MusicKit on the
Web. Arlet is in alpha development.

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
