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

| Module         | Responsibility                                              |
|----------------|-------------------------------------------------------------|
| `commands.rs`  | General app commands (version info, diagnostics)            |
| `settings.rs`  | Atomic settings load/save with backup                       |
| `logging.rs`   | Rolling local diagnostics log with sensitive-value redaction |
| `window_fx.rs` | Windows Mica / Acrylic effects with opaque fallback         |

## Frontend (`src/`)

No framework. State is a single mutable object in `state.ts`; modules
communicate via direct calls.

### Module layout

| Path              | Responsibility                                    |
|-------------------|---------------------------------------------------|
| `main.ts`         | Thin entry; boot lives in `app-init.ts`           |
| `app-init.ts`     | Initialization, MusicKit setup, UI wiring         |
| `state.ts`        | Centralized application state                     |
| `domain/`         | Internal types: `Track`, `Album`, `PlaybackState` |
| `musickit/`       | MusicKit integration: bootstrap, auth, player     |
| `styles/`         | CSS tokens and base styles                        |

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

## Security

- Tauri capabilities grant narrow permissions per window label.
- CSP restricts script/connect/media sources to known Apple domains.
- No `shell` plugin. No filesystem access for remote content.
- Developer tokens are never shipped in production builds.
