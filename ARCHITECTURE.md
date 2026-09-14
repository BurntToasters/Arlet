# Architecture

Arlet is a [Tauri 2](https://tauri.app) app: a Preact + TypeScript + CSS
frontend backed by a Rust native layer. The application is a Windows-first
Apple Music client using MusicKit on the Web for subscription playback.

The current implementation decisions were approved by the owner on
2026-09-13: the Preact shell, Acrylic default with Mica/Solid fallback and a
user-selectable material, the persistent bottom player, the custom frameless
titlebar with native Snap Layout support, and the development-only diagnostics
drawer are intentional. Protected playback remains the Phase 0 gate. The
production HTTPS developer-token service is a pre-release prerequisite and is
not wired into the release runtime yet.

```
frontend (src/, TS)  ──invoke()──▶  Rust commands (src-tauri/src/)
        ▲                                   │
        └────────── events ────────────────┘
```

## Backend (`src-tauri/src/`)

`main.rs` is glue only (state registration, builder, command registry). Logic is
split into focused modules:

| Module                | Responsibility                                               |
| --------------------- | ------------------------------------------------------------ |
| `commands.rs`         | App information and debug-only developer-token lookup        |
| `music_diagnostic.rs` | Unprivileged `music.apple.com` webview (Phase 0 DRM probe)   |
| `auth_popup.rs`       | Main-window creation and Apple auth popup allowlist          |
| `settings.rs`         | Settings load/save/reset with backup and startup parsing     |
| `logging.rs`          | Rolling local diagnostics log with sensitive-value redaction |
| `window_fx.rs`        | Windows Acrylic/Mica effects with Solid fallback             |
| `window_snap.rs`      | Native Windows Snap Layout maximize-button overlay           |

## Frontend (`src/`)

The shell uses Preact for component composition and hooks. `state.ts` remains a
small explicit application store; the controller owns MusicKit and persistence,
while diagnostics is a separate bounded store containing only sanitized values.
Views and components call the controller through the Preact context rather than
invoking native commands directly.

### Module layout

| Path                  | Responsibility                                                    |
| --------------------- | ----------------------------------------------------------------- |
| `main.tsx`            | Preact mount, router/store/controller creation, boot              |
| `main.ts`             | Compatibility entry that delegates to `main.tsx`                  |
| `app/App.tsx`         | Shell composition and development diagnostics wiring              |
| `app/context.tsx`     | Preact contexts and application-state subscription                |
| `app/controller.ts`   | MusicKit lifecycle, auth, search, playback, settings actions      |
| `app-init.ts`         | Native environment, settings, and diagnostics startup             |
| `state.ts`            | Explicit renderable application state and subscriptions           |
| `domain/`             | Internal `Track`, `Album`, and `PlaybackState` types              |
| `components/`         | Titlebar, sidebar, player, queue, artwork, and diagnostics UI     |
| `views/`              | Home, search, settings, route, and placeholder views              |
| `routing/router.ts`   | Hash routes and browser-history navigation                        |
| `musickit/`           | MusicKit bootstrap, auth, catalog, normalization, events, player  |
| `musickit/token.ts`   | Debug Tauri token provider and unwired HTTPS service provider     |
| `musickit/preview.ts` | Preview/full-track classification helper                          |
| `musickit/errors.ts`  | Map failures to typed `AppErrorCode` values                       |
| `diagnostics/`        | Sanitized bounded store, native adapter, lifecycle/network hooks  |
| `platform/`           | Native window/settings bridges and sensitive-value redaction      |
| `phase0/`             | Feasibility checklist, network capture, lifecycle probes, reports |
| `styles/`             | Theme tokens, shell layout, accessibility, and responsive CSS     |

### Apple Music Integration

MusicKit on the Web is the playback authority. The app uses:

- MusicKit JS CDN for the player runtime
- Apple Music API for catalog/library queries
- Apple's authorization flow for subscriber access

The `musickit/` directory wraps all Apple SDK interactions behind normalized
interfaces so the rest of the app never handles raw MusicKit objects. The
developer token provider is selected by the bootstrap layer: the current local
debug path reads an environment token through Rust, while the HTTPS service
provider is implemented but not wired. Release-mode Rust deliberately refuses
the debug token command until that production service is configured.

## Testing

- Frontend: Vitest + jsdom. Tauri mocks in `src/__tests__/setup-dom.ts`; shell
  and diagnostics components have focused render/store tests.
- Backend: `cargo test`; unit tests live beside each module, including command
  validation and Windows-targeted code paths where practical.
- Full gate: `node scripts/test-all.js` (typecheck, lint, format, Vitest,
  cargo fmt, Clippy `-D warnings`, cargo test, and the e2e hook).
- Native titlebar, material, DPI, protected playback, and lifecycle behavior
  still require manual Windows validation. `scripts/test-e2e.js` is intentionally
  a documented no-op until a WebDriver/Tauri harness is added.

## Release automation (`scripts/`)

Node.js is the build/release control plane; the shipped app never requires
Node. Arlet-native scripts inspired by Zinnia's architecture (Windows-only):

| Area               | Scripts                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Licenses           | `generate-npm-licenses.js`, `generate-cargo-licenses.js` → `public/` (gitignored)                                                                                                                                                                                                                                                                                                                                                             |
| Quality/session    | `test-all.js`, `release-session.js`, `dist-tools.js`                                                                                                                                                                                                                                                                                                                                                                                          |
| Windows build/sign | `tauri-windows-build.js`, `launch-vs-devshell.ps1`, `setup-windows-artifact-signing.ps1`, `windows-artifact-sign.ps1`, `verify-windows-authenticode.ps1`                                                                                                                                                                                                                                                                                      |
| Release flow       | `release-preflight.js` (+ `.p8`/dev-token leak gates), `release-warning.js`, `ensure-draft-release.cjs`, `wait-for-draft-release.cjs`, `publish-release.cjs`, `gpg-sign.js`, `generate-updater-manifests.js` (`latest-windows-*.json`), `validate-updater-manifest.js`, `verify-release-draft.js`, `verify-release-published.js`, `post-release-assets.js` + `finalize-release-assets.js` (`AFTER_PACK_LOC` archive mirror), `run-release.js` |
| Maintenance        | `vi.js`, `npm-safe-update.mjs`, `cargo-safe-update.mjs`, `sync-version.js`                                                                                                                                                                                                                                                                                                                                                                    |
| Phase 0 gate       | `phase0-preflight.js` (`phase0:preflight`, `phase0:gate`; token check without printing secrets), `mint-musickit-token.js` (`phase0:mint-token`; ES256 JWT from a `.p8` outside the repo)                                                                                                                                                                                                                                                      |
| Icons              | `normalize-icons.js` (`icons:normalize`, tested by `normalize-icons.test.js` via `test:scripts`)                                                                                                                                                                                                                                                                                                                                              |

In-build Authenticode signing runs via `bundle.windows.signCommand` in
`src-tauri/tauri.conf.json` (no-op under `SKIP_WIN_CODESIGN=1`); the build
driver then signs installer artifacts and verifies all signatures.

## CI (`.github/workflows/ci.yml`)

Routine CI holds no signing keys or Apple material: commit-message policy
(PRs), full quality gate on Ubuntu, unsigned `--no-bundle` smoke builds on
Windows x64 + ARM64, and npm/cargo audits, aggregated by a `ci-gate` job.

## Security

- Tauri capabilities grant narrow permissions per window label.
- CSP uses an exact MusicKit CDN/auth allowlist plus the current provisional
  Apple subdomain wildcards for image/connect/media traffic. The observed
  network surface is still pending; see `docs/MUSICKIT_NETWORK_SURFACE.md`.
- No `shell` plugin. No filesystem access for remote content.
- Developer tokens are never shipped in production builds. The production HTTPS
  token service must be wired and configured before a release can initialize
  MusicKit.
