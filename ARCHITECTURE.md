# Architecture

Arlet is a [Tauri 2](https://tauri.app) app: a Preact + TypeScript + CSS
frontend backed by a Rust native layer. The application is a Windows-first
Apple Music client using MusicKit on the Web for subscription playback.

The current implementation decisions were approved by the owner on
2026-09-13: the Preact shell, Acrylic default with Mica/Solid fallback and a
user-selectable material, the persistent bottom player, the custom frameless
titlebar with native Snap Layout support, and the development-only diagnostics
drawer are intentional. Protected playback remains the Phase 0 gate. Release
builds embed a validated MusicKit developer token at compile time (see
`docs/SECURITY.md`).

```
frontend (src/, TS)  ──invoke()──▶  Rust commands (src-tauri/src/)
        ▲                                   │
        └────────── events ────────────────┘
```

## Backend (`src-tauri/src/`)

`main.rs` is glue only (state registration, builder, command registry). Logic is
split into focused modules:

| Module                | Responsibility                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `commands.rs`         | App information, token serving, and the async `open_support_page` / `open_about_link` commands (URLs fixed in Rust)                                                      |
| `token_policy.rs`     | Developer-token validation shared with `build.rs` embedding                                                                                                              |
| `library_cache.rs`    | SQLite library cache behind fixed commands: WAL, a separate read-only connection for reads, immediate write transactions, schema migrations, deferred VACUUM when sparse |
| `playback_session.rs` | Local-only queue snapshot with a size cap, restored paused after restart                                                                                                 |
| `webview_recovery.rs` | Reloads/restarts after WebView2 process failures                                                                                                                         |
| `pins.rs`             | Validated local playlist pins next to settings                                                                                                                           |
| `windows_media.rs`    | System Media Transport Controls session and timeline                                                                                                                     |
| `system_events.rs`    | Suspend and default-output-change pauses, emitted as the media "pause" command                                                                                           |
| `music_diagnostic.rs` | Unprivileged `music.apple.com` webview (Phase 0 DRM probe)                                                                                                               |
| `auth_popup.rs`       | Main-window creation and Apple auth popup allowlist                                                                                                                      |
| `settings.rs`         | Settings load/save/reset with backup and startup parsing                                                                                                                 |
| `window_state.rs`     | Main window size, position, and maximized state                                                                                                                          |
| `tray.rs`             | System tray: playback commands, Show, and Quit                                                                                                                           |
| `logging.rs`          | Opt-in (Debug Mode) rolling log with redaction; crash lines                                                                                                              |
| `window_fx.rs`        | Windows Acrylic/Mica effects with Solid fallback                                                                                                                         |
| `window_snap.rs`      | Native Windows Snap Layout maximize-button overlay                                                                                                                       |

## Frontend (`src/`)

The shell uses Preact for component composition and hooks. `state.ts` remains a
small explicit application store; the controller owns MusicKit and persistence,
while diagnostics is a separate bounded store containing only sanitized values.
Views and components call the controller through the Preact context rather than
invoking native commands directly. Components that stay mounted subscribe with
`useAppSlices(...)`, which re-renders only when a named top-level slice changes
and types the result as a `Pick` of the state, so a slice that was not
requested cannot be read. A single field is read with
`useAppSelector(selector, equal?)`, which re-renders only when the selected value
changes under `equal` (default `Object.is`; `shallowEqual` is provided for
objects and arrays). Views select only the slices or fields they read, and no
component subscribes to the whole store. Playback position ticks replace
`state.playback` but are not a `playback` slice change: `useAppSlices` compares
that slice without `positionSeconds` and `durationSeconds`, and readers of
position use `usePlaybackPosition()`. Keep the playback slice out of shell-level
subscriptions, and keep the volume drag's per-input change to `playback.volume`
with settings persisted once the drag settles.

Views are route-level code split: `views/RouteView.tsx` loads Settings, Curator,
Browse, and Radio on demand through `components/lazy.tsx` (`lazyView`). Each
shows its skeleton while the chunk loads and an EmptyState with retry if it
fails. `UpdateReadyModal` loads `ReleaseNotes` the same way. Routes are hash
based; a curator page is `#/curator/{id}?kind=apple|curator`, where `apple`
reads an Apple editorial curator and `curator` reads a curator.

### Module layout

| Path                                                                                | Responsibility                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.tsx`                                                                          | Preact mount, router/store/controller creation, boot                                                                                            |
| `state.ts`                                                                          | Explicit renderable application state, subscriptions, and reset helpers                                                                         |
| `state-types.ts`                                                                    | State types, including Browse, Radio, and Search paging (`SearchPagingState`); re-exported by `state.ts`                                        |
| `app/App.tsx`                                                                       | Shell composition and development diagnostics wiring                                                                                            |
| `app/MediaSessionSync.tsx`                                                          | Mirrors playback into the Windows media session                                                                                                 |
| `app/DevDiagnostics.tsx`                                                            | Development diagnostics drawer; subscribes only while it is open                                                                                |
| `app/context.tsx`                                                                   | Preact contexts and application-state subscription                                                                                              |
| `app-init.ts`                                                                       | Native environment, settings, and diagnostics startup                                                                                           |
| `app/controller.ts`                                                                 | Composition root: MusicKit lifecycle, auth, and wiring of the `controller-*` modules                                                            |
| `app/controller-support.ts`                                                         | Shared response normalizers and error helpers                                                                                                   |
| `app/controller-settings.ts`                                                        | Settings persistence, the debounced volume save, and settings setters                                                                           |
| `app/controller-pins.ts`                                                            | Pinned playlists: local persistence, name/artwork resolution, and toggling                                                                      |
| `app/controller-account.ts`                                                         | Sign-in, re-auth, sign-out, session expiry, and MusicKit authorization changes                                                                  |
| `app/library-cache-coordinator.ts`                                                  | Account-scoped library cache reads and writes for the controller                                                                                |
| `app/library-loader.ts`                                                             | Library, Home, and detail loading; cache-first, offline read-only mode                                                                          |
| `app/discovery.ts`                                                                  | Browse charts, genres and shelf paging, radio genres and stations, catalog and library search, suggestions, and "See all" paging                |
| `app/ratings.ts`                                                                    | Rating requests and rating state, batched for the rows on screen                                                                                |
| `app/playback.ts`                                                                   | Queue and transport commands over MusicKit; transport and playback modes                                                                        |
| `app/playback-play.ts`                                                              | Play requests and `playTracks`, with the Play timing log                                                                                        |
| `app/playback-insert.ts`                                                            | Play Next and Play Later: inserting tracks into the queue                                                                                       |
| `app/queue-continuation.ts`                                                         | Refills the queue with the rest of a capped playlist as it plays                                                                                |
| `app/playback-session.ts`                                                           | Saves and restores the queue snapshot through the Rust session command                                                                          |
| `app/stream-release.ts`                                                             | Parks the queue and stops MusicKit after 1 minute paused, so the Apple Music stream lease is handed back to other devices                       |
| `app/idle-guard.ts`                                                                 | Pauses playback after 4 hours of playing with no pointer, key, wheel or playback command                                                        |
| `app/session-health.ts`                                                             | Verifies a suspected Apple sign-in expiry with one rate-limited `/v1/me/storefront` probe; only a 401 or 403 marks the session expired          |
| `app/collection-playback.ts`                                                        | Shared start rules for albums, playlists, and song lists (start index, shuffle, Play timing)                                                    |
| `app/playlist-editing.ts`                                                           | Search, create, and add to library playlists                                                                                                    |
| `app/sleep-timer.ts`, `app/shortcuts.ts`, `app/auto-skip.ts`, `app/queue-window.ts` | Sleep timer, keyboard shortcut actions, skipping songs that fail on their own, and the first-batch queue window used by Play                    |
| `library/cache.ts`                                                                  | Client for the Rust library-cache commands (memory cache in tests); scope is the current account                                                |
| `components/`                                                                       | Titlebar, sidebar, player, queue, artwork, and diagnostics UI                                                                                   |
| `components/lazy.tsx`                                                               | `lazyView`: loads a route surface on demand, with loading and failed states                                                                     |
| `components/VirtualGrid.tsx`                                                        | Virtualized card grid for the Library view                                                                                                      |
| `components/VirtualList.tsx`                                                        | Virtualized song lists; lists at or below a small size render in full                                                                           |
| `components/CardActions.tsx`                                                        | Card shell with the card's "..." action button and context-menu attributes                                                                      |
| `components/Skeleton.tsx`                                                           | Labelled loading regions and shape placeholders                                                                                                 |
| `components/SearchSuggestions.tsx`, `components/SearchCards.tsx`                    | Search suggestion listbox and result tiles                                                                                                      |
| `components/VolumeControl.tsx`                                                      | Volume slider with spoken values                                                                                                                |
| `components/context-target.ts`, `components/context-menu-items.ts`                  | Context-menu targets and the menu item model (items, separators, keyboard skipping)                                                             |
| `components/use-visible-ratings.ts`                                                 | Collects rating ids of mounted rows and requests them in one batch                                                                              |
| `components/window-fullscreen.ts`                                                   | Reads the main window's fullscreen state; reports false when unknown                                                                            |
| `views/`                                                                            | Home, search, settings, route, and placeholder views                                                                                            |
| `views/CuratorView.tsx`                                                             | Curator and Apple curator pages, with playlist groups and paged playlists                                                                       |
| `views/ArtistShelves.tsx`, `views/AlbumShelves.tsx`                                 | Artist pages (Top Songs, albums) and album shelves                                                                                              |
| `views/detail-meta.ts`, `views/detail-context.ts`                                   | Detail header facts (runtime, year, disc groups) and library or catalog origin                                                                  |
| `routing/router.ts`                                                                 | Hash routes (including `#/curator/{id}?kind=`) and browser-history navigation                                                                   |
| `musickit/`                                                                         | MusicKit bootstrap, auth, catalog, normalization, events, player                                                                                |
| `musickit/search.ts`                                                                | Catalog search: result groups in display order, page sizes, suggestions                                                                         |
| `musickit/browse.ts`                                                                | Charts, shelves, and genres for Browse and Radio (page size `BROWSE_PAGE_LIMIT`)                                                                |
| `musickit/curators.ts`                                                              | Curator and Apple curator pages, titled playlist groups, and playlist curator references                                                        |
| `musickit/live-metadata.ts`                                                         | Live radio text and metadata, length-capped so a stream cannot fill the UI                                                                      |
| `musickit/response.ts`                                                              | Shared readers for Apple response bodies (`findResourceArray`, `findNextValue`, `findTotal`), and `safeNextPath` for validating next-page paths |
| `musickit/library.ts`                                                               | Library composition root: re-exports the `library-*` modules for the rest of the app                                                            |
| `musickit/library-pages.ts`                                                         | Paged library reads, `LIBRARY_PAGE_LIMIT`, and batch-id limits                                                                                  |
| `musickit/library-detail.ts`                                                        | Album, playlist, and artist detail reads                                                                                                        |
| `musickit/library-home.ts`                                                          | Home recommendation groups and their normalization                                                                                              |
| `musickit/library-ratings.ts`                                                       | Reads and writes ratings for songs, albums, and playlists                                                                                       |
| `musickit/library-folders.ts`                                                       | Playlist and playlist folder creation                                                                                                           |
| `musickit/library-mutations.ts`                                                     | Adding songs to a playlist and adding items to the library                                                                                      |
| `musickit/token.ts`                                                                 | Native token provider (env in debug, embedded in release)                                                                                       |
| `musickit/preview.ts`                                                               | Preview/full-track classification helper                                                                                                        |
| `musickit/errors.ts`                                                                | Map failures to typed `AppErrorCode` values                                                                                                     |
| `diagnostics/`                                                                      | Sanitized bounded store, native adapter, lifecycle/network hooks                                                                                |
| `platform/`                                                                         | Native window/settings bridges and sensitive-value redaction                                                                                    |
| `phase0/`                                                                           | Feasibility checklist, network capture, lifecycle probes, reports                                                                               |
| `styles/`                                                                           | `tokens.css` plus `base.css`, an ordered index of `styles/base/*`                                                                               |

### Apple Music Integration

MusicKit on the Web is the playback authority. The app uses:

- MusicKit JS CDN for the player runtime
- Apple Music API for catalog/library queries
- Apple's authorization flow for subscriber access

The `musickit/` directory wraps all Apple SDK interactions behind normalized
interfaces so the rest of the app never handles raw MusicKit objects. The
developer token always comes from Rust: debug builds read `.env` at runtime,
release builds serve the token `build.rs` validated and embedded.

## Testing

- Frontend: end to end only, through the native E2E below. There is no
  frontend unit suite; lint and typecheck cover the rest.
- Release tooling: `npm run test:scripts` (Node's test runner) covers the
  changelog parser, updater manifests, signer pinning, and release rules.
- Backend: `cargo test`; unit tests live beside each module, including command
  validation and Windows-targeted code paths where practical.
- Native E2E artifacts: each run writes to its own folder under `e2e-artifacts/`,
  and `scripts/e2e-app.js` keeps only the newest run folders.
- Full gate: `node scripts/test-all.js` (typecheck, lint, format, script
  tests, cargo fmt, Clippy `-D warnings`, cargo test, and the offline build smoke).
- Native E2E: `npm run test:e2e:app` (Windows) builds a release binary and
  drives the real app over WebView2's DevTools Protocol; see
  `docs/TESTING.md`. Titlebar, material, DPI, protected playback, and
  lifecycle behavior still need manual Windows validation.

## Release automation (`scripts/`)

Node.js is the build/release control plane; the shipped app never requires
Node. Arlet-native scripts inspired by Zinnia's architecture (Windows-only):

| Area               | Scripts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Licenses           | `generate-npm-licenses.js`, `generate-cargo-licenses.js` → `public/` (gitignored)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Quality/session    | `test-all.js`, `release-session.js`, `dist-tools.js`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Windows build/sign | `tauri-windows-build.js`, `launch-vs-devshell.ps1`, `setup-windows-artifact-signing.ps1`, `windows-artifact-sign.ps1`, `verify-windows-authenticode.ps1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Release flow       | `release-policy.cjs` + `release-preflight.js` (stable override and `.p8`/dev-token leak gates), `release-warning.js`, `ensure-draft-release.cjs`, `wait-for-draft-release.cjs`, `publish-release.cjs`, `gpg-sign.js`, `updater-signature-verifier.js` + `src-tauri/examples/verify_updater_signatures.rs`, `generate-updater-manifests.js` (`latest-windows-*.json`), `validate-updater-manifest.js`, `verify-release-draft.js`, `verify-release-published.js`, `post-release-assets.js` + `finalize-release-assets.js` (`AFTER_PACK_LOC` archive mirror), `run-release.js`, `finalize-reset.js` (guarded post-release reset), `github-cli.cjs` |
| Maintenance        | `vi.js`, `npm-safe-update.mjs`, `cargo-safe-update.mjs`, `sync-version.js`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Phase 0 gate       | `phase0-preflight.js` (`phase0:preflight`, `phase0:gate`; token check without printing secrets), `mint-musickit-token.js` (`phase0:mint-token`; ES256 JWT from a `.p8` outside the repo)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Icons              | `normalize-icons.js` (`icons:normalize`, tested by `normalize-icons.test.js` via `test:scripts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

In-build Authenticode signing runs via `bundle.windows.signCommand` in
`src-tauri/tauri.conf.json` (no-op under `SKIP_WIN_CODESIGN=1`); the build
driver then signs installer artifacts and verifies all signatures.

## CI (`.github/workflows/ci.yml`)

Routine CI holds no signing keys or Apple material: commit-message policy
(PRs), full quality gate on Ubuntu, unsigned `--no-bundle` smoke builds plus
Windows Clippy on x64 + ARM64 (`ARLET_SKIP_MUSICKIT_TOKEN=1`; never
published), and npm/cargo audits, aggregated by a `ci-gate` job.

## Security

- Tauri capabilities grant narrow permissions per window label.
- CSP uses an exact MusicKit CDN/auth allowlist plus the current provisional
  Apple subdomain wildcards for image/connect/media traffic. The observed
  network surface is still pending; see `docs/MUSICKIT_NETWORK_SURFACE.md`.
- No `shell` plugin. No filesystem access for remote content.
- The `.p8` key is never shipped. Release builds embed only a validated,
  expiring developer JWT; ship a new release before it expires.
