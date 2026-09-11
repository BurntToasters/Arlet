#!/usr/bin/env node
// Arlet safe npm updater. Architecture inspired by Zinnia; implementation is original.
// Updates within declared semver ranges, verifies the tree, and re-syncs versions.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const MINIMUM_NPM_VERSION = "12.0.1";

export function parseVersion(value) {
  const match = String(value)
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return match.slice(1).map(Number);
}

export function isVersionAtLeast(value, minimum) {
  const current = parseVersion(value);
  const required = parseVersion(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (current[index] > required[index]) return true;
    if (current[index] < required[index]) return false;
  }
  return true;
}

export function usesWindowsCmdShell(command) {
  return process.platform === "win32" && /\.cmd$/i.test(command);
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runNpm(args) {
  const npm = npmCommand();
  console.log(`> npm ${args.join(" ")}`);
  const result = spawnSync(npm, args, {
    cwd: root,
    stdio: "inherit",
    shell: usesWindowsCmdShell(npm),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} exited with ${result.status}`);
  }
}

function checkNpmVersion() {
  const result = spawnSync(npmCommand(), ["--version"], { encoding: "utf8" });
  const version = (result.stdout || "").trim();
  if (!version || !isVersionAtLeast(version, MINIMUM_NPM_VERSION)) {
    throw new Error(
      `npm ${MINIMUM_NPM_VERSION}+ is required (found: ${version || "unknown"}).`,
    );
  }
}

function main() {
  checkNpmVersion();
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const expectedManager = String(pkg.packageManager || "");
  if (expectedManager && !expectedManager.startsWith("npm@")) {
    console.warn(
      `[npm-safe-update] Unexpected packageManager: ${expectedManager}`,
    );
  }
  runNpm(["update", "--save"]);
  runNpm(["dedupe"]);
  runNpm(["run", "sync-version"]);
  console.log("[npm-safe-update] Done. Review git diff and run test:all.");
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectExecution()) {
  try {
    main();
  } catch (error) {
    console.error(
      `[npm-safe-update] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
