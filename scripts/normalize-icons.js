#!/usr/bin/env node
// Arlet icon normalization. Workflow modeled on postal-snap's
// `icons:normalize`; implementation is original and self-contained.
//
// Committed sources live in `src-tauri/icons/`:
//   app-icon.png        desktop/full-bleed source (all platforms)
//   app-icon-macos.png  padded macOS source (squircle masking needs padding)
// Regeneration is explicit only: run `npm run icons:normalize` after editing
// a source. No other script may invoke it, so committed icons change on
// purpose (enforced by normalize-icons.test.js).
//
// macOS source is optional until macOS builds exist (Windows-first MVP):
// when absent, the step warns and the committed `icon.icns` is left alone.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);

export function iconPaths(rootDir = repoRoot) {
  const iconsDir = join(rootDir, "src-tauri", "icons");
  return {
    iconsDir,
    desktopSource: join(iconsDir, "app-icon.png"),
    macosSource: join(iconsDir, "app-icon-macos.png"),
  };
}

function defaultTauriIconRunner(args, cwd) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const useShell = process.platform === "win32" && /\.cmd$/i.test(npm);
  const result = spawnSync(npm, ["run", "tauri", "--", "icon", ...args], {
    cwd,
    stdio: "inherit",
    shell: useShell,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `tauri icon ${args.join(" ")} exited with ${result.status}`,
    );
  }
}

function removeRetry(target) {
  rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
}

export function normalizeIcons({
  rootDir = repoRoot,
  runTauriIcon = defaultTauriIconRunner,
} = {}) {
  const { iconsDir, desktopSource, macosSource } = iconPaths(rootDir);
  if (!existsSync(desktopSource)) {
    throw new Error(`Desktop icon source is missing: ${desktopSource}`);
  }

  runTauriIcon([desktopSource], rootDir);

  if (!existsSync(macosSource)) {
    console.warn(
      "[icons:normalize] app-icon-macos.png not found; leaving icon.icns alone.",
    );
    return { macosIcns: false };
  }
  const staging = mkdtempSync(join(tmpdir(), "arlet-macos-icon-"));
  try {
    runTauriIcon([macosSource, "--output", staging], rootDir);
    cpSync(join(staging, "icon.icns"), join(iconsDir, "icon.icns"));
  } finally {
    removeRetry(staging);
  }
  return { macosIcns: true };
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    const result = normalizeIcons();
    console.log(
      `[icons:normalize] Done (macOS icns: ${result.macosIcns ? "regenerated" : "skipped"}).`,
    );
  } catch (error) {
    console.error(
      `[icons:normalize] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
