# Architecture

Arlet is a [Tauri 2](https://tauri.app) app: a vanilla TypeScript + HTML + CSS
frontend backed by a Rust native layer. The application is a Windows-first
Apple Music client using MusicKit on the Web for subscription playback.

```
frontend (src/, TS)  ──invoke()──▶  Rust commands (src-tauri/src/)
        ▲                                   │
        └────────── events ────────────────┘
```

## Backend (`src-tauri/src/`)

`main.rs` is glue only (state registration, builder, command registry). Logic is
split into focused modules:

| Module         | Responsibility                                               |
| -------------- | ------------------------------------------------------------ |
| `commands.rs`  | General app commands (version info, diagnostics)             |
| `settings.rs`  | Atomic settings load/save with backup                        |
| `logging.rs`   | Rolling local diagnostics log with sensitive-value redaction |
| `window_fx.rs` | Windows Mica / Acrylic effects with opaque fallback          |

## Frontend (`src/`)

No framework. State is a single mutable object in `state.ts`; modules
communicate via direct calls.

### Module layout

| Path                 | Responsibility                                                  |
| -------------------- | --------------------------------------------------------------- |
| `main.ts`            | Thin entry; boot lives in `app-init.ts`                         |
| `app-init.ts`        | Initialization, MusicKit setup, UI wiring                       |
| `state.ts`           | Centralized application state                                   |
| `domain/`            | Internal types: `Track`, `Album`, `PlaybackState`               |
| `musickit/`          | MusicKit integration: bootstrap, auth, player                   |
| `musickit/token.ts`  | Developer-token providers (env for dev, HTTPS service for prod) |
| `musickit/errors.ts` | Map failures to typed `AppErrorCode` values                     |
| `platform/redact.ts` | Frontend sensitive-value redaction (mirrors `logging.rs`)       |
| `styles/`            | CSS tokens and base styles                                      |

### Apple Music Integration

MusicKit on the Web is the playback authority. The app uses:

- MusicKit JS CDN for the player runtime
- Apple Music API for catalog/library queries
- Apple's authorization flow for subscriber access

The `musickit/` directory wraps all Apple SDK interactions behind normalized
interfaces so the rest of the app never handles raw MusicKit objects.

## Testing

- Frontend: Vitest + jsdom. Tauri mocks in `src/__tests__/setup-dom.ts`.
- Backend: `cargo test`; unit tests live beside each module.
- Full gate: `node scripts/test-all.js` (typecheck, lint, format, vitest,
  cargo fmt, clippy `-D warnings`, cargo test, e2e). E2E is a documented
  no-op until the Milestone 1 shell exists.

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
- CSP restricts script/connect/media sources to known Apple domains.
- No `shell` plugin. No filesystem access for remote content.
- Developer tokens are never shipped in production builds.
