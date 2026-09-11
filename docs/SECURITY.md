# Security Model

## Webview privileges

Tauri capabilities are a real boundary, not documentation. Permissions are
granted per window label in `src-tauri/capabilities/`; the default set covers
only version, window management, updater, restart, notifications, settings,
logging, and window effects. There is no `shell` plugin, no arbitrary command
execution, and remote Apple origins get no filesystem/shell/updater access.

Content Security Policy in `src-tauri/tauri.conf.json` allows only the exact
Apple domains MusicKit needs (see `docs/MUSICKIT_NETWORK_SURFACE.md`) plus
the configured token-service origin. Never broaden CSP or capabilities to
make a bug disappear; document the required origin first.

## Apple Music credentials

- There are two token classes: the **developer token** (signed from your
  Media Services private key) and the **Music User Token** (the subscriber's,
  managed by MusicKit). Keep them conceptually separate everywhere.
- **Never ship the `.p8` private key** in the app, installer, repo, bundle,
  binary, or CI log. Production obtains short-lived developer tokens from a
  small HTTPS token service (`DeveloperTokenProvider`; see
  `src/musickit/token.ts`).
- Local development tokens live only in `.env.local` (gitignored).
  `release:preflight` refuses a production release if a `.p8` file exists in
  the worktree, if a dev-token variable is set, or if credential files are
  staged.

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
