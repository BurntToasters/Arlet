# Release Process

Arlet releases are built on a Windows release VM and orchestrated by Node.js
scripts (`scripts/`), following the same architecture as postal-snap (Windows
scope only). The pipeline is an explicit state machine: preflight → version
sync → licenses → quality gate → session → builds → signing → draft → verify
→ publish → verify.

## One-time setup (owner)

1. **Updater keypair.** Already generated for this project: the **public**
   key is committed in `src-tauri/tauri.conf.json`
   (`plugins.updater.pubkey`); the **private** key and its password live only
   in the gitignored `.env` on the dev machine (`TAURI_SIGNING_PRIVATE_KEY`,
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). Back them up offline and copy them
   to the release VM when cutting a release — losing them means shipping a
   new app identity, since installed clients pin the public key. To rotate,
   run `npx tauri signer generate -w <file> --ci`, replace both sides, and
   treat it as a breaking update event. Until the pubkey is set,
   `npm run release:preflight` fails by design.
2. **Azure Artifact Signing.** Once per release VM as Administrator:
   `npm run setup:win:artifact-signing`. Fill the `AZURE_*` variables in
   `.env` (see `.env.example`). Only the exact value `SKIP_WIN_CODESIGN=1`
   permits unsigned local builds; CI and releases never set it.
3. **GPG.** Set `GPG_KEY_ID` in `.env` for detached `.asc` signatures.
4. **Archive mirror.** Set `AFTER_PACK_LOC` in `.env` to an absolute archive
   directory **outside** the repository. Stable releases refuse to finalize
   without it: after verification, cleaned artifacts are mirrored there with
   hash checks, because `release:finalize` then resets the checkout.
   Betas skip the mirror unless `OVERRIDE_BETA_MIRROR_SKIP=1`.
5. **GitHub CLI.** `gh auth login` with rights to create/edit releases in
   `BurntToasters/Arlet` (override via `GH_REPO_OWNER`/`GH_REPO_NAME`).

## Version and branch policy

- `x.y.z-beta.n` releases from `beta`; `x.y.z` releases from `main`.
- `release:preflight` enforces the branch, a clean tree pushed to its
  upstream, synchronized versions (`package.json`, `tauri.conf.json`,
  `Cargo.toml`), updater pubkey presence, NSIS target config, and credential
  hygiene (no `.p8` in the worktree, `.env` never staged, no Vite-exposed
  MusicKit developer token).

## Standard flow (Windows release VM)

```text
npm run release:prepare          # bootstrap + test:all --skip-e2e + clean artifacts dir
npm run release:win              # warning + preflight + full win run (or release:win:resume to continue)
```

`release:win:continue` runs: session verify → licenses → draft (single
creator) → Rust targets → x64 + ARM64 NSIS builds (in-build Authenticode via
`bundle.windows.signCommand`, then a skip-if-signed safety pass) → updater
manifest generation → GPG sign + upload → beta-feed synchronization when the
version is a beta → mirror cleaned artifacts to `AFTER_PACK_LOC` + reset the
checkout (`release:finalize`) → draft verification (installers, checksums,
signatures, updater manifests, and manifest-to-sidecar references).

After every platform job finishes:

```text
npm run release:publish          # re-verifies the draft, then flips draft → published
npm run release:verify:published # downloads live updater metadata and validates it
```

## Updater channels and manifest assets

Arlet uses three application choices: **Auto** (the default), **Stable**, and
**Beta**. Auto follows the installed build: stable builds poll stable feeds and
`-beta.N` builds poll beta feeds. Stable and Beta explicitly select their
corresponding feed regardless of the installed version.

Each release generates six target-specific manifests:

```text
latest-windows-x86_64.json             latest-windows-aarch64.json
latest-windows-beta-x86_64.json        latest-windows-beta-x86_64-nsis.json
latest-windows-beta-aarch64.json       latest-windows-beta-aarch64-nsis.json
```

The stable generic files contain both the generic and NSIS target keys. The
beta generic files do the same, while the `-nsis` files contain only the exact
installer target used by the beta target command. All manifests use Tauri's
`pub_date` field and reference the signed installer asset on the exact release
tag.

Stable releases upload all six files to the published stable release, which
is GitHub's `/releases/latest` alias. Beta releases upload all six files to
their prerelease tag, then transactionally copy only the four beta manifests
onto the latest stable release. A GitHub asset lock, staging names, adjacent
rename swap, rollback, and orphan cleanup protect the live beta feed while
multiple release VMs are active. If a beta VM loses connectivity after
publication, run:

```text
npm run release:sync-beta-manifests
```

The recovery command requires the beta tag to be published, verifies every
beta manifest and its updater sidecar, and refuses to run until a published
stable `/releases/latest` exists. This stable-first gate prevents a beta from
becoming the stable feed by accident.

## Rules

- Never trust "upload succeeded": every publish is followed by a live
  download-and-validate step.
- A valid updater signature is not an Authenticode signature and vice versa;
  the pipeline checks both. Draft/live verification also checks that every
  manifest signature matches the corresponding `.sig` sidecar and that every
  referenced installer is downloadable.
- Never put `.p8` keys, Apple credentials, Authenticode credentials, or the
  updater private key in routine CI. CI builds unsigned smoke artifacts only.
- Release sessions expire after 24h and are bound to the exact
  commit/toolchain/lockfiles; stale sessions must not be resumed.
