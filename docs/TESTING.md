# Testing Boundaries

## Offline application smoke

`npm run test:e2e` is an offline smoke gate for the production frontend. It
builds the Vite output, confirms that `dist/index.html` references the local
entrypoint and stylesheet, and checks the emitted bundle for the native
diagnostics, updater target, startup-check, and update-modal paths. It also
checks the source-level startup order: persisted settings load, MusicKit
initialization, and then the startup updater check.

This gate does not open Tauri, authorize Apple Music, download an update, or
contact a release service. It therefore does not prove that protected playback
works, that an Apple account can authorize, or that a live updater feed is
reachable.

## Native app E2E

`npm run test:e2e:app` (Windows only, opt-in) builds a release binary into
`src-tauri/target/e2e` with a synthetic MusicKit token, moves the per-user
Arlet data folders aside, launches the app with WebView2 remote debugging, and
drives it over the DevTools Protocol. It restores the data folders afterwards
and writes `e2e-artifacts/<timestamp>/report.json` (binary SHA-256, commit,
per-check results), `screenshot.png`, and the run's `arlet.log`. Close every
running Arlet first; the app is single-instance. `--skip-build` reuses the
last E2E binary.

Failure modes it covers:

1. A release build cannot embed the token, or serves the runtime env instead.
2. The window never renders its shell.
3. A corrupt `settings.json` silently resets preferences (backup ignored).
4. A long multibyte log entry panics and aborts the process.
5. Music User Tokens reach the log file unredacted.
6. The registry Windows-build lookup or media-session commands fail.
7. Removed plugins (`dialog`, `notification`) are still reachable.
8. The app does not run on `http://tauri.localhost`, so origin-scoped
   tokens would break.
9. A cache written by the former SQL plugin is lost on upgrade, the fixed
   cache commands fail, or the generic SQL plugin is still reachable.
10. The open-source licenses dialog is empty.
11. With Apple's CDN unreachable, the cached library is not shown.
12. A renderer crash leaves a blank window.

It also writes `screenshot-offline.png`. CI runs this gate on Windows x64 and
uploads the report as the `e2e-report` artifact.

`npm run test:e2e:app:real` embeds the real `MUSICKIT_DEVELOPER_TOKEN` from
`.env` instead and adds a check that Apple's catalog API accepts it from the
release origin and that it carries no `origin` claim. That proves the token
on this machine; `release:preflight` checks the release VM's token against
Apple separately. Library (`/v1/me`) requests need a signed-in user, so
confirm them by hand on an installed build.
The E2E binary then contains that token; it stays in `src-tauri/target/e2e`.

It does not sign in to Apple Music or play protected audio.

## Song navigation and playlist playback

The native E2E gate also reloads the production frontend with a deterministic
MusicKit fixture injected through WebView2 DevTools. The application still
uses its real components, controller, request adapter, router, and playback
event handlers. The fixture replaces the external provider only; it does not
prove protected Apple Music audio playback.

Failure scenarios to cover before changing production code:

- A song title opens the wrong album or single, or navigation interrupts playback.
- Multiple artists collapse into one destination, or punctuation in an artist
  name creates invented artists.
- Catalog and library IDs use the wrong route or lookup endpoint; absent
  relationships cause guessed links, repeated requests, or an unhandled error.
- A late lookup changes a newer song's links or a closed/replaced context menu.
- Player links or context-menu actions cannot be reached by keyboard.
- Starting a middle playlist row queues only that song or discards earlier
  songs from shuffle; duplicate occurrences select the wrong position.
- Playback stops after the selected song, queue display disagrees with the
  provider, or next/previous and repeat settings change unexpectedly.
- Playlist pagination is truncated, loops forever, or replaces a working queue
  after a page request fails.
- Context-menu Play now loses playlist context; Play next or Play later adds
  the entire playlist instead of the selected song.

The report records the fixture seed and per-scenario results. Additional
artifacts retain navigation/playback screenshots and provider queue transitions
so the fixture run is repeatable and auditable. Run `npm run test:e2e:app` on
Windows with every existing Arlet instance closed. A separate signed-in check
must confirm real track completion, shuffle, and repeat on Apple Music.

## Release-only evidence

The following checks require a Windows release environment and are kept out of
the deterministic smoke gate:

- Azure Artifact Signing credentials and the signing client are required to
  prove Authenticode signatures on x64 and ARM64 installers.
- A real signed x64 and ARM64 canary installer is required to prove install,
  restart, architecture selection, and rollback behavior.
- A published, signed updater manifest and its installer/signature sidecar are
  required to prove the live stable or beta feed. Use the existing read-only
  release verification commands after publishing; they must not be replaced by
  provider-account fixtures.
- Apple developer-token/account credentials are required for the manual
  MusicKit authorization and protected full-track playback matrix.

These external gates are intentionally opt-in and must run only on the release
VM or a test machine with the appropriate credentials and signed artifacts.

`--skip-e2e` remains available for a non-release local diagnostic run, but
`test:all --require-clean-proof --skip-e2e` is rejected so a release quality
proof cannot be created with the built smoke gate omitted.
