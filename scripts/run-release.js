#!/usr/bin/env node
// Arlet release runner (Windows-only), mirroring Zinnia's run-release.js.
//
// Usage:
//   node scripts/run-release.js win [--skip-check]
// Runs prerelease:prepare, the release:prepare steps (bootstrap, quality gate,
// clean artifacts and build session), then release:win:continue.
// --skip-check sets FORCE_UPLOAD=1 for the commit fence.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecutionOf } from "./direct-execution.mjs";
import { usesWindowsCmdShell } from "./npm-safe-update.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONTINUE_SCRIPTS = {
  win: "release:win:continue",
};

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function parseReleaseArgs(argv) {
  const flags = argv.filter((arg) => arg.startsWith("-"));
  const knownFlags = new Set(["--skip-check"]);
  const unknown = flags.filter((flag) => !knownFlags.has(flag));
  if (unknown.length > 0) {
    throw new Error(`Unknown release flag: ${unknown.join(", ")}`);
  }
  const platforms = argv.filter((arg) => !arg.startsWith("-"));
  if (platforms.length !== 1 || !CONTINUE_SCRIPTS[platforms[0]]) {
    throw new Error(
      `Usage: node scripts/run-release.js <${Object.keys(CONTINUE_SCRIPTS).join("|")}> [--skip-check]`,
    );
  }
  return {
    platform: platforms[0],
    skipCheck: flags.includes("--skip-check"),
    continueScript: CONTINUE_SCRIPTS[platforms[0]],
  };
}

function runNpm(script, extraArgs = [], envOverrides = {}) {
  const npm = npmCommand();
  const result = spawnSync(npm, ["run", script, ...extraArgs], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    shell: usesWindowsCmdShell(npm),
    env: { ...process.env, ...envOverrides },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function main(argv = process.argv.slice(2), runner = runNpm) {
  const { skipCheck, continueScript } = parseReleaseArgs(argv);
  if (skipCheck) {
    // The flag name undersells it: FORCE_UPLOAD also lifts the commit
    // fences in the draft, verify, and publish steps (betas only).
    console.warn(
      "[release] --skip-check sets FORCE_UPLOAD=1: the release commit fences are bypassed for this beta.",
    );
  }
  runner("prerelease:prepare");
  runner("workspace:bootstrap");
  // Arlet's quality-gate proof requires E2E, so unlike Zinnia it is not skipped.
  runner("test:all", ["--", "--require-clean-proof"]);
  runner("dist:clean-release-artifacts");
  runner(continueScript, [], skipCheck ? { FORCE_UPLOAD: "1" } : {});
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return isDirectExecutionOf(import.meta.url);
}

if (isDirectExecution()) {
  try {
    main();
  } catch (error) {
    console.error(
      `run-release: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
