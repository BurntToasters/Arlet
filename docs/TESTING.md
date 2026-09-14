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
