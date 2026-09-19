# Arlet Agent Notes

Arlet is a Windows-first Tauri v2 application with a Preact/TypeScript frontend
and Rust backend. Preserve unrelated work in the shared worktree and keep
changes scoped to the requested subsystem.

## Validation

- Run `npm run typecheck`, `npm run lint`, and `npm run format:check`.
- Run focused Vitest or Node tests before `npm run test:all`.
- Do not run formatting commands across the repository when unrelated files
  are modified.

## Updater and Releases

- Startup update checks download silently; the existing update dialog opens
  only after the installer is ready.
- Release notes come from updater manifest `notes` through Tauri
  `Update.body`. Do not add a separate GitHub API request.
- Author each release in `CHANGELOG.md` under exact heading
  ``## Changes in `vX.Y.Z` `` or ``## Changes in `vX.Y.Z-beta.N` ``.
- Release tooling extracts only that section, stops at the next level-two
  heading, and rejects missing, duplicate, empty, or over-64-KiB notes.
- Treat release-note Markdown as untrusted. Keep rendering dependency-free,
  avoid `dangerouslySetInnerHTML`, and never make rendered links navigable.
- Preserve stable/beta target behavior and signed-updater verification when
  changing manifests or update flow.
