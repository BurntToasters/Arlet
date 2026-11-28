#!/usr/bin/env node
// Verifies the latest full native E2E report for the exact release commit.
// Publication must not treat the SSH-deferred quality gate as desktop proof.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertReleaseTreeClean } from "./release-session.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, "..");
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REPORT_DIRECTORY = "e2e-artifacts";
const EXPECTED_BINARY_PATH = "src-tauri/target/e2e/release/arlet.exe";

function asTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Release E2E report has an invalid ${label} timestamp.`);
  }
  return timestamp;
}

function validateReleaseE2eReport(
  report,
  expectedCommit,
  { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {},
) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Release E2E report is not an object.");
  }
  if (!/^[0-9a-f]{40}$/iu.test(String(expectedCommit ?? ""))) {
    throw new Error(
      "Could not resolve the exact release commit for E2E proof.",
    );
  }
  if (report.commit !== expectedCommit) {
    throw new Error(
      `Release E2E report commit ${report.commit || "unknown"} does not match release commit ${expectedCommit}.`,
    );
  }
  if (report.fullSuite !== true) {
    throw new Error("Release E2E report is not a full desktop scenario run.");
  }
  if (report.passed !== true) {
    throw new Error("Release E2E report did not pass.");
  }
  if (report.releaseProofEligible !== true) {
    throw new Error(
      "Release E2E report is not marked eligible for release proof.",
    );
  }
  if (report.platform !== "win32" || report.sshSession !== false) {
    throw new Error(
      "Release E2E report must come from an interactive Windows desktop, not SSH.",
    );
  }
  if (report.dirtyWorktree !== false) {
    throw new Error("Release E2E report was not run from a clean worktree.");
  }
  if (report.scenarioSelectionError) {
    throw new Error("Release E2E report has a scenario selection error.");
  }
  if (
    !Array.isArray(report.selectedScenarios) ||
    report.selectedScenarios.length === 0 ||
    report.selectedScenarios.some(
      (scenario) => typeof scenario !== "string" || !scenario.trim(),
    ) ||
    new Set(report.selectedScenarios).size !==
      report.selectedScenarios.length ||
    report.scenarioCount !== report.selectedScenarios.length
  ) {
    throw new Error("Release E2E report has incomplete scenario coverage.");
  }
  if (
    !Array.isArray(report.checks) ||
    report.checks.length === 0 ||
    report.checks.some((check) => check?.passed !== true)
  ) {
    throw new Error("Release E2E report has missing or failed checks.");
  }

  const startedAt = asTimestamp(report.startedAt, "start");
  const finishedAt = asTimestamp(report.finishedAt, "finish");
  if (startedAt > finishedAt || finishedAt > now) {
    throw new Error("Release E2E report has invalid run timestamps.");
  }
  const age = now - finishedAt;
  if (age > maxAgeMs) {
    throw new Error("Release E2E report is expired; run the full suite again.");
  }
  if (age < 0) {
    throw new Error("Release E2E report finish timestamp is in the future.");
  }

  const build = report.e2eBuild;
  if (!build || typeof build !== "object" || Array.isArray(build)) {
    throw new Error("Release E2E report has no matching E2E build proof.");
  }
  const builtAt = asTimestamp(build.builtAt, "build");
  if (build.feature !== "e2e") {
    throw new Error("Release E2E binary was not built with the E2E feature.");
  }
  if (build.commit !== expectedCommit) {
    throw new Error(
      "Release E2E build commit does not match the release commit.",
    );
  }
  if (build.dirtyWorktree !== false) {
    throw new Error("Release E2E binary was built from a dirty worktree.");
  }
  if (builtAt > startedAt || builtAt > now) {
    throw new Error(
      "Release E2E build timestamp does not precede the test run.",
    );
  }
  if (startedAt - builtAt > maxAgeMs) {
    throw new Error(
      "Release E2E build proof is expired; rebuild and rerun the full suite.",
    );
  }
  const buildHash = String(build.sha256 ?? "").toLowerCase();
  const binaryHash = String(report.binary?.sha256 ?? "").toLowerCase();
  if (
    !/^[0-9a-f]{64}$/u.test(buildHash) ||
    !/^[0-9a-f]{64}$/u.test(binaryHash) ||
    buildHash !== binaryHash
  ) {
    throw new Error(
      "Release E2E report binary does not match its build proof.",
    );
  }
  const binaryPath = String(report.binary?.path ?? "").replaceAll("\\", "/");
  if (binaryPath !== EXPECTED_BINARY_PATH) {
    throw new Error(
      "Release E2E report does not identify the native release build.",
    );
  }
  return report;
}

function readReleaseReports(root, expectedCommit) {
  const directory = path.join(root, REPORT_DIRECTORY);
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const reports = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const reportPath = path.join(directory, entry.name, "report.json");
    let report;
    try {
      report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(
        `Release E2E report has invalid JSON or timestamps at ${path.relative(root, reportPath)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (report?.commit !== expectedCommit || report?.fullSuite !== true) {
      continue;
    }
    const startedAt = Date.parse(report.startedAt);
    reports.push({
      report,
      reportPath,
      // An unorderable full-run artifact must fail closed as the newest one.
      order: Number.isFinite(startedAt) ? startedAt : Number.POSITIVE_INFINITY,
    });
  }
  return reports.sort((left, right) => left.order - right.order);
}

function verifyReleaseE2eReport(
  root = defaultRoot,
  {
    commit = currentCommit(root),
    now = Date.now(),
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    requireCleanWorktree = false,
  } = {},
) {
  if (requireCleanWorktree) assertCleanReleaseCheckout(root, commit);
  const reports = readReleaseReports(root, commit);
  const latest = reports.at(-1);
  if (!latest) {
    throw new Error(
      `No full desktop E2E report exists for release commit ${commit}. Run npm run test:e2e:app on a Windows desktop at this clean commit before publishing.`,
    );
  }
  const report = validateReleaseE2eReport(latest.report, commit, {
    now,
    maxAgeMs,
  });
  if (requireCleanWorktree) assertCleanReleaseCheckout(root, commit);
  return {
    report,
    reportPath: path.relative(root, latest.reportPath),
  };
}

function assertCleanReleaseCheckout(root, expectedCommit) {
  try {
    assertReleaseTreeClean(root);
  } catch (error) {
    throw new Error(
      `Release working tree must be clean when verifying E2E proof; commit or discard changes, then rerun the full Windows suite. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const actualCommit = currentCommit(root);
  if (actualCommit !== expectedCommit) {
    throw new Error(
      `Release checkout changed from ${expectedCommit} to ${actualCommit} while verifying E2E proof.`,
    );
  }
}

function currentCommit(root) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    const { report, reportPath } = verifyReleaseE2eReport(defaultRoot, {
      requireCleanWorktree: true,
    });
    console.log(
      `release-e2e-report: ok (${report.commit.slice(0, 12)}, ${reportPath})`,
    );
  } catch (error) {
    console.error(
      `release-e2e-report: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export { DEFAULT_MAX_AGE_MS, validateReleaseE2eReport, verifyReleaseE2eReport };
