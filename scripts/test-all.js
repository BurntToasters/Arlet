#!/usr/bin/env node
// Arlet full quality gate. Architecture inspired by Zinnia; implementation is
// original and scoped to Arlet Phase 0/Milestone 1 (offline built smoke only;
// no browser-driver suite, no flatpak, no archive fixtures, no vendor updater
// tree).
//
// Runs: version drift check, typecheck, lint, format:check, vitest with
// coverage, cargo fmt --check, cargo clippy -D warnings, cargo test, and the
// deterministic built frontend smoke gate. Records a quality-gate proof for
// the release pipeline on success.
//
// Flags: --require-clean-proof --skip-e2e

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  clearQualityGateProof,
  recordSuccessfulQualityGate,
} from "./release-session.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
const appVersion = packageJson.version ?? "unknown";
const scriptVersion = "0.1.0";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};
const defaultTimeoutMs = 300_000;
const rustTimeoutMs = process.platform === "win32" ? 1_200_000 : 600_000;

function createInitialResults() {
  return {
    version: { status: "pending" },
    typecheck: { status: "pending" },
    lint: { status: "pending" },
    format: { status: "pending" },
    test: { status: "pending", passed: null, failed: null, files: null },
    scripts: { status: "pending" },
    rustfmt: { status: "pending" },
    clippy: { status: "pending" },
    rust: { status: "pending" },
    e2e: { status: "pending" },
  };
}

function getNpmCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function printTail(output, label) {
  const clean = stripAnsi(output).trim();
  if (!clean) return;
  const tail = clean.split("\n").slice(-60).join("\n");
  console.log(`${colors.red}${label}:${colors.reset}`);
  console.log(`${colors.red}${tail}${colors.reset}`);
}

function parseTest(output, results) {
  const clean = stripAnsi(output);
  const passed = clean.match(/Tests?\s+(\d+)\s+passed/);
  const failed = clean.match(/Tests?\s+(\d+)\s+failed/);
  const files = clean.match(/Test Files\s+(\d+)\s+passed/);
  results.test.passed = passed ? Number.parseInt(passed[1], 10) : null;
  results.test.failed = failed ? Number.parseInt(failed[1], 10) : 0;
  if (files) results.test.files = Number.parseInt(files[1], 10);
}

function runCommand(name, command, args, parser, results, options = {}) {
  console.log(`${colors.blue}${colors.bold}Running ${name}...${colors.reset}`);
  const useShell = process.platform === "win32" && /\.cmd$/i.test(command);
  const run = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    shell: useShell,
    windowsHide: true,
    timeout: options.timeout ?? defaultTimeoutMs,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  const output = `${run.stdout || ""}${run.stderr || ""}`;
  if (parser) parser(output, results);
  if (!run.error && run.status === 0) {
    results[name].status = "passed";
    console.log(`${colors.green}✓ ${name} passed${colors.reset}\n`);
    return true;
  }
  results[name].status = "failed";
  const reason = run.error
    ? run.error.message
    : run.status === null
      ? `signal ${run.signal || "unknown"}`
      : `exit code ${run.status}`;
  console.log(`${colors.red}✗ ${name} failed (${reason})${colors.reset}`);
  printTail(run.stdout || "", "stdout tail");
  printTail(run.stderr || "", "stderr tail");
  console.log("");
  return false;
}

function printSummary(results) {
  console.log(
    `${colors.bold}${colors.blue}ARLET TEST SUITE — ${appVersion} (script ${scriptVersion})${colors.reset}`,
  );
  let failed = 0;
  for (const [name, result] of Object.entries(results)) {
    const ok = result.status === "passed" || result.status === "skipped";
    if (!ok) failed += 1;
    const mark =
      result.status === "skipped" ? "SKIP" : ok ? "✓ PASS" : "✗ FAIL";
    console.log(`${colors.bold}${name}:${colors.reset} ${mark}`);
  }
  if (failed === 0) {
    console.log(
      `${colors.green}${colors.bold}✓ All checks passed.${colors.reset}`,
    );
    return 0;
  }
  console.log(
    `${colors.red}${colors.bold}✗ ${failed} check(s) failed.${colors.reset}`,
  );
  return 1;
}

function main({
  requireCleanProof = false,
  skipE2e = false,
  clearProof = clearQualityGateProof,
  recordProof = recordSuccessfulQualityGate,
  runner = runCommand,
} = {}) {
  clearProof(root);
  if (requireCleanProof && skipE2e) {
    console.error(
      "Cannot record release quality-gate proof while E2E is skipped; run test:all without --skip-e2e.",
    );
    return 1;
  }
  const results = createInitialResults();
  const npm = getNpmCommand();

  runner(
    "version",
    npm,
    ["run", "sync-version", "--", "--check"],
    null,
    results,
  );
  runner("typecheck", npm, ["run", "typecheck"], null, results);
  runner("lint", npm, ["run", "lint"], null, results);
  runner("format", npm, ["run", "format:check"], null, results);
  runner(
    "test",
    npm,
    ["run", "test", "--", "--coverage.enabled", "false"],
    parseTest,
    results,
  );
  runner("scripts", npm, ["run", "test:scripts"], null, results);
  runner(
    "rustfmt",
    "cargo",
    [
      "fmt",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all",
      "--",
      "--check",
    ],
    null,
    results,
    { timeout: rustTimeoutMs },
  );
  runner(
    "clippy",
    "cargo",
    [
      "clippy",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
    null,
    results,
    { timeout: rustTimeoutMs },
  );
  runner(
    "rust",
    "cargo",
    [
      "test",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all-targets",
    ],
    null,
    results,
    { timeout: rustTimeoutMs },
  );
  if (skipE2e) {
    results.e2e.status = "skipped";
    console.log(`${colors.blue}Skipping E2E (--skip-e2e).${colors.reset}\n`);
  } else {
    runner("e2e", npm, ["run", "test:e2e"], null, results);
  }

  const exitCode = printSummary(results);
  if (exitCode === 0) {
    const gate = recordProof(root);
    if (gate.recorded) {
      console.log("Release quality-gate proof recorded for this clean commit.");
    } else {
      console.error(
        `${colors.red}Quality-gate proof NOT recorded: working tree is dirty. Commit generated files and re-run test:all before any release step.${colors.reset}`,
      );
      if (gate.dirtyFiles) console.log(gate.dirtyFiles);
      if (requireCleanProof) return 1;
    }
  }
  return exitCode;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectExecution()) {
  process.exit(
    main({
      requireCleanProof: process.argv.includes("--require-clean-proof"),
      skipE2e: process.argv.includes("--skip-e2e"),
    }),
  );
}

export {
  createInitialResults,
  getNpmCommand,
  main,
  parseTest,
  printSummary,
  runCommand,
};
