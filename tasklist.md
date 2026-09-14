# Arlet Project Tasklist & Context

This document tracks our progress through the Arlet `plan.md` architecture brief to easily pick up where we left off.

## 📌 Status (2026-09-11 — read first)

- [ ] **Commit review:** gate-session + phase0-preflight work is UNCOMMITTED.
      `npm run test:all` green on dirty tree; commit then re-run for release
      proof.
- [ ] **Back up `.env` offline:** updater private key + password live only
      there (gitignored). Required on the release VM.
- [x] **Set `AFTER_PACK_LOC`:** this machine uses
      `C:/Users/Burnt/Documents/Arlet-release-archive` (outside the repo).
      Copy the same key to the release VM when cutting a stable release.
- [ ] **Manual gate next:** `.env` token → `npm run tauri:dev` →
      playback matrix → paste copied reports into feasibility docs (checklist
      below). Phase 0 UI includes matrix checklist, clipboard export,
      preview-vs-full label, and an unprivileged music.apple.com diagnostic
      (Apple ID only; no developer token).
- [ ] **Then:** gate PASS → Milestone 1 shell; gate FAIL → CastLabs spike,
      keep portable layers (plan §4.5/§25).

## ✅ Phase 0 Scaffolding (Completed)

- [x] **Project Scaffolding:** Initialized Tauri v2 project with vanilla TypeScript and Vite.
- [x] **Zinnia Script Porting:** Replicated Zinnia's script architecture, `package.json` configurations, and Git hooks (e.g., `pre-commit`, `commit-msg`, `sync-version`).
- [x] **Rust Backend Scaffolding:** Implemented core backend modules (`logging.rs`, `settings.rs`, `window_fx.rs` for Mica/Acrylic), matching Zinnia's best practices.
- [x] **MusicKit Frontend Integration:** Created a minimal, isolated test UI.
  - Implemented strong domain typing (`Track`, `Album`, `PlaybackState`).
  - Created strict wrappers around MusicKit JS (`auth.ts`, `player.ts`, `events.ts`, `normalize.ts`).
  - Unit tested MusicKit normalizers and application state machine (Vitest).
- [x] **Security & Tooling:** Configured strict CSP allowing Apple Music domains, configured `vitest`, `eslint`, and `tsc` which are currently fully passing.

## ✅ Release Tooling Port (Completed 2026-09-11)

> Full port per owner decision. Arlet-native reimplementations (not verbatim
> copies — Zinnia is MPL-2.0, Arlet is GPL-3.0-only) of the Zinnia release
> architecture, scoped to Windows-only distribution (no 7-Zip, archive
> fixtures, shell-extension MSIX, macOS/Linux, or flatpak).

- [x] **Licenses:** `generate-npm-licenses.js` (8 entries OK),
      `generate-cargo-licenses.js` (530 entries; 44 unresolved texts = warning,
      `--require-complete` fail-closed gate for releases).
- [x] **Dist/session:** `dist-tools.js` (`clean`, `clean-release-artifacts`,
      `clean-all`, `list`), `release-session.js` (exact commit/toolchain/
      lockfile quality-gate + build-session proofs).
- [x] **Test gate:** `test-all.js` (typecheck → lint → format → vitest →
      node `--test scripts` → cargo fmt → clippy `-D warnings` → cargo test →
      offline built frontend smoke) — all green; live account, signing, and
      release-feed checks remain explicit external gates (see
      `docs/TESTING.md`).
- [x] **Windows build/sign:** `tauri-windows-build.js` (NSIS only),
      `launch-vs-devshell.ps1`, `setup-windows-artifact-signing.ps1`,
      `windows-artifact-sign.ps1`, `verify-windows-authenticode.ps1`.
- [x] **Release flow:** `release-warning.js`, `release-preflight.js` (branch +
      version-sync + updater-pubkey + `.p8`/dev-token leak gates),
      `ensure-draft-release.cjs`, `wait-for-draft-release.cjs`,
      `publish-release.cjs`, `gpg-sign.js`, `validate-updater-manifest.js`,
      `verify-release-draft.js`, `verify-release-published.js`,
      `run-release.js` (Windows-only).
- [x] **Maintenance:** `vi.js`, `npm-safe-update.mjs`, `cargo-safe-update.mjs`.
- [x] **Unblocked gate:** `npm run licenses` and therefore `npm run tauri:dev`
      work again (were `MODULE_NOT_FOUND`-broken by dead aliases).
- [x] **Hygiene fixed along the way:** `cargo fmt` normalization,
      3 clippy `needless_return` errors in `window_fx.rs`, repo-wide
      `prettier --write` (format:check was red on 12 pre-existing files).

## ✅ Phase 0 Prototype Hardening (Completed 2026-09-11)

- [x] `src/musickit/errors.ts`: `mapErrorToCode` per plan §19 (8 tests).
- [x] `src/platform/redact.ts`: frontend sensitive-value redaction mirroring
      `logging.rs` (3 tests); wired into `events.ts` error path and the
      Phase 0 diagnostics `log()` in `app-init.ts`.
- [x] `events.ts` no longer hardcodes `PLAYBACK_FAILED`.
- [x] Gates green: typecheck, eslint + comment-lint, prettier, vitest 29/29,
      `cargo test` 10/10 ×2, `cargo fmt --check`, `cargo clippy -D warnings`.

## ✅ Prod-Readiness Pass (Completed 2026-09-11)

> Everything below the manual gate. The Milestone 1 UI shell is deliberately
> held until the Phase 0 gate passes (plan §4: no full UI before proven
> protected playback; escape strategy keeps portable layers first).

- [x] **Signing wired:** `src-tauri/tauri.windows.conf.json` was dead config —
      `signCommand` moved into `tauri.conf.json` (`bundle.windows`), dead file
      removed, plan layout line corrected. Proven by a real
      `tauri build --bundles nsis` invoking the sign script per binary.
- [x] **Updater keypair:** generated; pubkey committed to `tauri.conf.json`,
      private key + password in gitignored `.env` (this machine only — back
      up offline, copy to release VM when cutting a release). Bundle build
      now exits 0 and emits `Arlet_0.1.0_x64-setup.exe` + `.sig`.
- [x] **Token abstraction:** `src/musickit/token.ts` (`DeveloperTokenProvider`;
      env provider for dev, HTTPS-service provider for prod) + 5 tests;
      `bootstrap.ts` takes an optional provider (default: env).
- [x] **Diagnostics for gate evidence:** `get_app_info` now returns
      os/arch/WebView2 version/debug flag (+ Rust test); Phase 0 UI logs the
      environment line at startup for pasting into the feasibility report.
- [x] **CI:** `.github/workflows/ci.yml` — PR trailer policy, Ubuntu quality
      gate (`test:all` + version-sync check), unsigned Windows
      x64/ARM64 `--no-bundle` smoke builds, npm + cargo audits, `ci-gate`
      aggregator. Holds no secrets/keys by design.
- [x] **Docs:** `docs/RELEASE.md` (operator flow), `docs/SECURITY.md`
      (capabilities/CSP/tokens/logging/signing),
      `docs/WINDOWS_MEDIA_INTEGRATION.md` (Milestone 4 target spec, deferred);
      `ARCHITECTURE.md` updated (scripts, CI, new modules).

## ✅ Icon Workflow (Completed 2026-09-11)

> Ported from postal-snap's `icons:normalize` pattern (Arlet-native
> implementation; postal-snap is MPL-2.0). Current art is Zinnia placeholder
> imagery pending the in-progress Arlet design.

- [x] Sources live in `src-tauri/icons/`: `app-icon.png` (desktop, moved from
      repo root via `git mv`) + optional `app-icon-macos.png` (padded macOS
      source; skipped with a warning until macOS builds exist).
- [x] `scripts/normalize-icons.js` (`icons:normalize`): regenerates derived
      icons via `tauri icon` in place, then copies only `icon.icns` from a
      staging run of the macOS source. No other script may invoke it.
- [x] `scripts/normalize-icons.test.js` (5 tests via `test:scripts`,
      wired into `test:all`): explicit-only wiring, source layout, fail-fast
      on missing source, macOS skip + icns-only-copy paths with cleanup.
- [x] Verified live `tauri icon` to a temp dir (full set generated, exit 0);
      committed art untouched. When the new design lands, drop in the
      source(s) and run `npm run icons:normalize`.

## ✅ Audit + AFTER_PACK_LOC Restore (Completed 2026-09-11)

- [x] **Updater loop closed:** audited the v2 updater source — NSIS updates
      run the `-setup.exe` itself (no `.nsis.zip`), so exe + exe.sig is the
      complete artifact set. Added `generate-updater-manifests.js`
      (`release:updater-manifests`, 6 tests): versioned `latest-windows-*.json`
      from signed installer pairs, fail-closed, proven with the real Tauri
      `.sig`. Wired before signing; draft verification now requires both.
- [x] **AFTER_PACK_LOC restored:** my mistake — it is the archive mirror, not
      a dead var. Ported `post-release-assets.js` + `finalize-release-assets.js`
      (6 tests): boundary-checked (absolute, non-symlink, outside repo, not
      release/), atomic staging + hash verify + rollback, beta skip policy,
      stable-requires-mirror gate. `release:win:continue` ends with
      `release:finalize` (mirror → reset → clean); proven live against a temp
      archive. `.env.example` entry restored.
- [x] **Redaction parity:** Rust `redact_sensitive` only replaced the first
      token per entry — now loops like the frontend helper, with a
      multi-token test on both sides.
- [x] **No dual signatures:** in-build `signCommand` is primary; the
      post-build pass takes `-SkipIfSigned` (verified against a signed
      system binary).
- [x] **Missing styles:** `src/styles/` was empty while `index.html` linked
      both sheets — added minimal Phase 0 `tokens.css` + `base.css` per plan
      §7.3 (tokens, focus visibility, reduced motion); `vite build` bundles
      them.
- [x] **Warts:** RELEASE.md flow no longer double-runs preflight, added
      `validate:updater` script name, ARCHITECTURE.md scripts table current.

## ✅ Phase 0 Gate Session Tooling (Completed 2026-09-11)

- [x] `src/phase0/gate-session.ts`: plan §4.2 checklist (23 items), session
      timer, fetch + PerformanceObserver host capture, feasibility +
      network-surface markdown export, clipboard helper.
- [x] Phase 0 UI wired: matrix checkboxes (sessionStorage), copy buttons,
      session duration + failure capture in diagnostics.
- [x] `scripts/phase0-preflight.js` (`phase0:preflight`, `phase0:gate`):
      token presence check (never prints value), toolchain + Windows/WebView2
      versions for the feasibility report.
- [x] Tests: `gate-session.test.ts`, `lifecycle.test.ts`, `player.test.ts`,
      `phase0-preflight.test.js`; `get_app_info` includes `rustc_version` +
      `windows_build`.
- [x] Vite `envDir` is the repo root. MusicKit token is `MUSICKIT_DEVELOPER_TOKEN`
      in `.env`, served by a debug-only Tauri command (not a `VITE_` var).
- [x] Consecutive 20-track queue: search limit 25, **Queue 20 consecutive**,
      skip next/prev over the queued results.
- [x] Lifecycle diagnostics: visibility, focus, online/offline, audio device
      change logged into the Phase 0 console.

## ✅ Phase 0 Diagnostic Webview + Preview Detection (Completed 2026-09-11)

- [x] Unprivileged `music.apple.com` webview (`music_diagnostic.rs`, plan §4.3):
      zero permissions, `local: false`, remote URL scoped to Apple Music.
      Opens from the Phase 0 UI even if MusicKit init fails. No DOM scrape,
      no script injection.
- [x] Preview vs full: `classifyPlaybackKind` + now-playing **Playback kind**
      label. `normalizeTrack` prefers catalog `durationInMillis` over the
      30s preview `playbackDuration`.
- [x] Tests: `preview.test.ts`, extra `normalize.test.ts` case, capability
      JSON asserts in `music_diagnostic.rs`.

## ✅ Phase 0 Token Mint Helper (Completed 2026-09-11)

- [x] `scripts/mint-musickit-token.js` (`phase0:mint-token`): ES256 JWT from
      `MUSICKIT_TEAM_ID` / `MUSICKIT_KEY_ID` / `MUSICKIT_P8_PATH`. `.p8` must
      be outside the repo. Writes `MUSICKIT_DEVELOPER_TOKEN` into `.env`;
      never prints the JWT or private key.

## ⏳ Phase 0 Manual Feasibility Gate (Next Steps — needs owner)

> **Goal:** Prove or disprove reliable full Apple Music subscriber playback in Evergreen WebView2 before investing in the full UI.

- [ ] Copy `.env.example` keys into `.env` and either paste a developer JWT
      as `MUSICKIT_DEVELOPER_TOKEN`, or set `MUSICKIT_TEAM_ID`,
      `MUSICKIT_KEY_ID`, and `MUSICKIT_P8_PATH` (absolute path **outside**
      the repo) then `npm run phase0:mint-token`.
- [ ] Run `npm run phase0:preflight` (or `npm run phase0:gate` to preflight then launch).
- [ ] Launch the app via `npm run tauri:dev` if not using `phase0:gate`.
- [x] Optional without a developer token: **Open music.apple.com diagnostic**
      — verified 2026-09-11: unprivileged window loads Apple Music web UI.
      Still needs owner Apple ID sign-in to test full tracks.
- [x] MusicKit Sign In popup: Tauri 2 was swallowing `window.open`. Main
      window is now created from Rust with `on_new_window` allowing only Apple
      auth hosts. Restart `npm start` and Sign In should show Apple's sheet.
- [ ] Click "Sign In" to authorize your Apple Music account.
- [ ] Search a catalog term with at least 20 songs, then **Queue 20 consecutive**.
      Clicking a result queues from that index so skip next/prev can be tested.
- [ ] Work through the **Feasibility Matrix** checklist in the app UI as you
      verify each case (session timer + track counter help the 20-track / 2-hour
      cases).
- [ ] Verify the following functionality:
  - Full playback (not just 30-second previews).
  - Seeking, volume control, and skipping.
  - 20+ consecutive tracks without DRM/Media errors.
- [ ] Click **Copy feasibility report** and paste into
      `docs/MUSICKIT_TAURI_FEASIBILITY.md` (fill Windows build + Node/Rust
      lines if blank).
- [ ] Click **Copy network surface** and paste into
      `docs/MUSICKIT_NETWORK_SURFACE.md`; tighten CSP in `tauri.conf.json` if
      new hosts appear.

## 🚀 Future Milestones (Pending Feasibility Gate)

_See `plan.md` for full milestone details._

- [ ] **Milestone 1:** Core structure (Navigation, Window management, layout shell)
- [ ] **Milestone 2:** Playback & Queue (Robust state synchronization, media session integration)
- [ ] **Milestone 3:** User Library (Albums, playlists, infinite scroll fetching)
- [ ] **Milestone 4:** OS Integration (Windows SMTC, Mica effects refinement)
- [ ] **Milestone 5:** Polish & Performance
- [ ] **Milestone 6:** Release Engineering
