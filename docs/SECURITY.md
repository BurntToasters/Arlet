# Security Model

## Webview privileges

Tauri capabilities are a real boundary, not documentation. Permissions are
granted per window label in `src-tauri/capabilities/`; the default set covers
only version, window management, updater, clipboard text, the
library cache (fixed Rust commands, no SQL), settings, pins, the saved
playback session (fixed load/save/delete commands, size- and item-capped),
logging, window effects, the Windows media session, and opening the diagnostic
window. There is no `shell`, `dialog`, `notification`, `process`, or
`global-shortcut` plugin, no arbitrary command execution, and remote Apple
origins get no filesystem/shell/updater access.

The tray icon is Tauri's core `tray-icon` feature, built in Rust. Its menu
emits the same `windows-media-control` event as the Windows media buttons and
grants the webview no additional permissions.

The Phase 0 `music-diagnostic` window loads `https://music.apple.com/` with an
empty permission list, `local: false`, and remote URL scope limited to that
origin. It has zero Tauri commands. Do not scrape Apple's DOM, inject scripts
into that page, or add privileges to that capability unless a later gate
failure documents a narrowly scoped need.

MusicKit `authorize()` uses `window.open` to `authorize.music.apple.com`. Tauri
2 denies webview popups unless `on_new_window` allows them. The main window is
created from Rust (`create: false`) so that handler can allow only Apple auth
hosts and `about:blank`. Allowed popups use WebView2's default window (no Tauri
IPC). Never log the authorize URL; the query string is the developer JWT.

Content Security Policy in `src-tauri/tauri.conf.json` currently uses exact
hosts for the MusicKit CDN and authorization frame, plus provisional
`https://*.apple.com` and `https://*.mzstatic.com` subdomain wildcards for
image, connect, and media traffic. The observed host list is still pending;
`docs/MUSICKIT_NETWORK_SURFACE.md` records that status and the provisional
surface. Reconcile those entries after a fresh Phase 0 export. Never broaden
CSP or capabilities to make a bug disappear; document the required origin
first.

## Apple Music credentials

- There are two token classes: the **developer token** (signed from your
  Media Services private key) and the **Music User Token** (the subscriber's,
  managed by MusicKit). Keep them conceptually separate everywhere.
- **Never ship the `.p8` private key** in the app, installer, repo, bundle,
  binary, or CI log. Only the signed developer JWT is shipped.
- `MUSICKIT_DEVELOPER_TOKEN` lives in `.env` (gitignored; copy
  `.env.example` → `.env`). `npm run phase0:mint-token` mints it from
  `MUSICKIT_TEAM_ID`, `MUSICKIT_KEY_ID`, and an absolute `MUSICKIT_P8_PATH`
  **outside** the repo; it never prints the JWT or `.p8`.
- **Debug builds** read the token from the process environment at runtime
  (`dotenv -e .env -- tauri dev`).
- **Release builds** embed the token at compile time. `src-tauri/build.rs`
  reads it from the release machine's `.env` and validates it with
  `src-tauri/src/token_policy.rs` (ES256 JWT, integer `exp`, at least 30 days
  left), or fails the build. At runtime `get_developer_token` serves only the
  embedded token, never the user's environment, and reports an expired token
  as "install the latest update". `release-preflight.js` runs the same check
  before a draft release exists.
- The embedded JWT can be extracted from the binary, as with any MusicKit web
  app. Its lifetime is the exposure window: Apple caps it at 6 months, so a
  new release must ship before the embedded token expires.
- Release tokens carry no `origin` claim. Apple accepts an origin-restricted
  token for catalog requests but refuses library (`/v1/me`) requests, even
  from `http://tauri.localhost`, so 0.1.0 cannot load anyone's library.
  `build.rs` and `release:preflight` reject one, and the native E2E checks
  the embedded token has none. The claim only limited browsers anyway: a
  native client can send any `Origin` header.
- Mint on a machine that holds the `.p8`, and copy only the JWT to the
  release machine.
- `ARLET_SKIP_MUSICKIT_TOKEN=1` builds a release binary without a token for
  unpublished CI smoke builds only. `tauri-windows-build.js` and the release
  preflight refuse it.

## Logging

Auth data is toxic: Apple passwords, Music User Tokens, developer private
keys, cookies, full `Authorization` headers, the updater private key, and
token-service bearer values are never logged. Both the Rust logger
(`src-tauri/src/logging.rs`) and the frontend (`src/platform/redact.ts`)
redact JWT-shaped values and values labelled by a token key
(`Music-User-Token`, `media-user-token`, `musicUserToken`, `developerToken`).
The frontend also redacts the exact developer and Music User Token values
once MusicKit has produced them. Request logs record method/path/status/
duration only. Both redactors have unit tests.

## Third-party script

MusicKit JS loads from Apple's CDN at runtime and runs in the main webview, so
it can call every command the main window is granted. It cannot be pinned with
Subresource Integrity because Apple updates it in place. The mitigation is to
keep the grant small: the webview has no generic SQL, filesystem, shell,
dialog, notification, or process access, and the library cache is reachable
only through fixed, size-bounded commands (`src-tauri/src/library_cache.rs`).
Clipboard read remains for paste in the context menu. Tauri's isolation
pattern is the next step if the grant ever needs to grow.

## Sign-out

Signing out stops playback, revokes MusicKit authorization, clears the SQLite
library cache, and deletes the local pinned-playlist file, so the next Apple ID
on the same Windows account starts clean.

## Signing separation

Windows Authenticode (Azure Artifact Signing), Tauri updater signatures, and
GPG detached signatures are three independent mechanisms; one is never
accepted as proof of another. See `docs/RELEASE.md`.

## Reporting

Do not file public issues for suspected vulnerabilities. Open a private
security advisory on the GitHub repository so the issue can be fixed before
disclosure.
