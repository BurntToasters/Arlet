# Security Model

## Webview privileges

Tauri capabilities are a real boundary, not documentation. Permissions are
granted per window label in `src-tauri/capabilities/`; the default set covers
only version, window management, updater, restart, notifications, settings,
logging, window effects, and opening the diagnostic window. There is no
`shell` plugin, no arbitrary command execution, and remote Apple origins get
no filesystem/shell/updater access.

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
  binary, or CI log. Production obtains short-lived developer tokens from a
  small HTTPS token service (`DeveloperTokenProvider`; see
  `src/musickit/token.ts`).
- Local Phase 0 reads `MUSICKIT_DEVELOPER_TOKEN` from `.env` (gitignored;
  copy `.env.example` → `.env`, same as postal-snap). `npm run
phase0:mint-token` can mint that JWT from `MUSICKIT_TEAM_ID`,
  `MUSICKIT_KEY_ID`, and an absolute `MUSICKIT_P8_PATH` **outside** the
  repo; it never prints the JWT or `.p8`. `dotenv -e .env -- tauri
dev` loads it into the Rust process. A debug-only `get_developer_token`
  command hands it to MusicKit. Release builds refuse that command. Production
  obtains short-lived tokens from a small HTTPS token service. The service
  provider exists in `src/musickit/token.ts` but is not wired into
  `src/musickit/bootstrap.ts` yet; release-mode MusicKit intentionally refuses
  the debug token command. Hosting/configuring that service and adding its
  exact origin to the release CSP are pre-release prerequisites. Do not publish
  a release until this production path is wired and smoke-tested.

## Logging

Auth data is toxic: Apple passwords, Music User Tokens, developer private
keys, cookies, full `Authorization` headers, the updater private key, and
token-service bearer values are never logged. Both the Rust logger
(`src-tauri/src/logging.rs`) and the frontend (`src/platform/redact.ts`)
redact JWT-shaped values; request logs record method/path/status/duration
only. Both redactors have unit tests.

## Signing separation

Windows Authenticode (Azure Artifact Signing), Tauri updater signatures, and
GPG detached signatures are three independent mechanisms; one is never
accepted as proof of another. See `docs/RELEASE.md`.

## Reporting

Do not file public issues for suspected vulnerabilities. Open a private
security advisory on the GitHub repository so the issue can be fixed before
disclosure.
