# Release Process

Arlet releases are built on a Windows release VM and orchestrated by Node.js
scripts (`scripts/`), following the same architecture as Zinnia. The pipeline
is an explicit state machine: preflight → version sync → licenses → quality
gate → session → builds → signing → draft → verify → publish → verify.

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
  hygiene (no `.p8` in the worktree, no dev MusicKit token configured,
  no staged `.env.local`).

## Standard flow (Windows release VM)

```text
npm run release:prepare          # bootstrap + test:all --skip-e2e + clean artifacts dir
npm run release:win              # warning + preflight + full win run (or release:win:resume to continue)
```

`release:win:continue` runs: session verify → licenses → draft (single
creator) → Rust targets → x64 + ARM64 NSIS builds (in-build Authenticode via
`bundle.windows.signCommand`, then a skip-if-signed safety pass) → updater
manifest generation (`latest-windows-*.json`) → GPG sign + upload → mirror
cleaned artifacts to `AFTER_PACK_LOC` + reset the checkout (`release:finalize`)
→ draft verification (installers, checksums, signatures, updater manifests).

After every platform job finishes:

```text
npm run release:publish          # re-verifies the draft, then flips draft → published
npm run release:verify:published # downloads live updater metadata and validates it
```

## Rules

- Never trust "upload succeeded": every publish is followed by a live
  download-and-validate step.
- A valid updater signature is not an Authenticode signature and vice versa;
  the pipeline checks both.
- Never put `.p8` keys, Apple credentials, Authenticode credentials, or the
  updater private key in routine CI. CI builds unsigned smoke artifacts only.
- Release sessions expire after 24h and are bound to the exact
  commit/toolchain/lockfiles; stale sessions must not be resumed.
