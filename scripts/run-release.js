#!/usr/bin/env node
// Arlet release runner (Windows-only). Architecture inspired by Zinnia;
// implementation is original.
//
// Usage:
//   node scripts/run-release.js win [--resume]
// --resume skips prerelease:prepare and continues an existing session.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function parseReleaseArgs(argv) {
  const flags = argv.filter((arg) => arg.startsWith("-"));
  const known = new Set(["--resume"]);
  const unknown = flags.filter((flag) => !known.has(flag));
  if (unknown.length > 0) {
    throw new Error(`Unknown release flag: ${unknown.join(", ")}`);
  }
  const platforms = argv.filter((arg) => !arg.startsWith("-"));
  if (platforms.length !== 1 || platforms[0] !== "win") {
    throw new Error("Usage: node scripts/run-release.js win [--resume]");
  }
  return { platform: "win", resume: flags.includes("--resume") };
}

function runNpm(script, extraArgs = []) {
  const npm = npmCommand();
  const useShell = process.platform === "win32" && /\.cmd$/i.test(npm);
  const result = spawnSync(npm, ["run", script, ...extraArgs], {
    cwd: root,
    stdio: "inherit",
    shell: useShell,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm run ${script} exited with ${result.status}`);
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectExecution()) {
  try {
    const { resume } = parseReleaseArgs(process.argv.slice(2));
    if (!resume) {
      runNpm("prerelease:prepare");
    }
    runNpm("release:win:continue");
  } catch (error) {
    console.error(
      `run-release: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
