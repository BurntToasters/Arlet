import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_MAX_AGE_MS,
  validateReleaseE2eReport,
  verifyReleaseE2eReport,
} from "./release-e2e-report.js";

// Failure modes to cover before implementing the release-report verifier:
// - missing, malformed, focused, failed, or stale reports must not authorize publication;
// - a report from another commit, a dirty worktree, SSH, or a non-Windows host must fail;
// - a missing/failed check, missing scenario coverage, or selection error must fail;
// - E2E binary and build hashes, source commit, build feature, and build cleanliness must agree;
// - timestamps must prove a completed run built before the run and within the proof lifetime;
// - after an SSH-deferred quality proof, only a later complete passing desktop report may pass;
// - when multiple full reports exist for the release commit, the newest one governs.

const now = Date.parse("2026-11-27T12:00:00.000Z");
const commit = "a".repeat(40);
const digest = "b".repeat(64);

function e2eReport(overrides = {}) {
  return {
    passed: true,
    startedAt: new Date(now - 120_000).toISOString(),
    finishedAt: new Date(now - 30_000).toISOString(),
    commit,
    dirtyWorktree: false,
    host: "Windows_NT 10.0.26100 x64",
    platform: "win32",
    sshSession: false,
    binary: {
      path: "src-tauri\\target\\e2e\\release\\arlet.exe",
      sha256: digest,
    },
    e2eBuild: {
      feature: "e2e",
      builtAt: new Date(now - 180_000).toISOString(),
      sha256: digest,
      commit,
      dirtyWorktree: false,
    },
    selectedScenarios: ["discovery", "artwork"],
    scenarioCount: 2,
    fullSuite: true,
    releaseProofEligible: true,
    scenarioSelectionError: null,
    checks: [{ name: "scenario selection is valid", passed: true }],
    ...overrides,
  };
}

function artifactRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arlet-release-e2e-"));
  return root;
}

function writeReport(root, directory, report) {
  const reportDirectory = path.join(root, "e2e-artifacts", directory);
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(reportDirectory, "report.json"),
    `${JSON.stringify(report)}\n`,
  );
}

test("release E2E report accepts a clean full Windows run on its matching build", () => {
  const validated = validateReleaseE2eReport(e2eReport(), commit, { now });
  assert.equal(validated.commit, commit);
  assert.equal(validated.releaseProofEligible, true);
  assert.equal(DEFAULT_MAX_AGE_MS, 24 * 60 * 60 * 1000);
});

test("release E2E report rejects incomplete, failed, focused, dirty, or wrong-host evidence", () => {
  const cases = [
    ["wrong commit", { commit: "c".repeat(40) }, /commit/],
    ["failed run", { passed: false }, /pass/],
    ["focused run", { fullSuite: false }, /full/],
    ["ineligible report", { releaseProofEligible: false }, /eligible/],
    ["dirty worktree", { dirtyWorktree: true }, /clean/],
    ["SSH run", { sshSession: true }, /desktop/],
    ["non-Windows run", { platform: "linux" }, /Windows/],
    ["selection error", { scenarioSelectionError: "unknown" }, /scenario/],
    [
      "missing scenarios",
      { selectedScenarios: [], scenarioCount: 0 },
      /scenario/,
    ],
    ["scenario count mismatch", { scenarioCount: 3 }, /scenario/],
    ["missing checks", { checks: [] }, /check/],
    [
      "failed check",
      { checks: [{ name: "one check", passed: false }] },
      /check/,
    ],
  ];
  for (const [label, overrides, pattern] of cases) {
    assert.throws(
      () => validateReleaseE2eReport(e2eReport(overrides), commit, { now }),
      pattern,
      label,
    );
  }
});

test("release E2E report rejects a stale, dirty, mismatched, or non-E2E build", () => {
  const cases = [
    ["binary hash", { binary: { path: "arlet.exe", sha256: "c".repeat(64) } }],
    [
      "build hash",
      { e2eBuild: { ...e2eReport().e2eBuild, sha256: "c".repeat(64) } },
    ],
    [
      "build commit",
      { e2eBuild: { ...e2eReport().e2eBuild, commit: "c".repeat(40) } },
    ],
    [
      "dirty build",
      { e2eBuild: { ...e2eReport().e2eBuild, dirtyWorktree: true } },
    ],
    [
      "wrong feature",
      { e2eBuild: { ...e2eReport().e2eBuild, feature: "release" } },
    ],
    [
      "build after run",
      {
        e2eBuild: {
          ...e2eReport().e2eBuild,
          builtAt: new Date(now).toISOString(),
        },
      },
    ],
    [
      "stale report",
      { finishedAt: new Date(now - DEFAULT_MAX_AGE_MS - 1).toISOString() },
    ],
  ];
  for (const [label, overrides] of cases) {
    assert.throws(
      () => validateReleaseE2eReport(e2eReport(overrides), commit, { now }),
      /build|stale|expired|timestamp|binary/i,
      label,
    );
  }
});

test("release E2E verifier uses the newest full report for the release commit", () => {
  const root = artifactRoot();
  try {
    writeReport(
      root,
      "2026-11-27T11-00-00-000Z",
      e2eReport({ finishedAt: new Date(now - 60_000).toISOString() }),
    );
    writeReport(
      root,
      "2026-11-27T11-30-00-000Z",
      e2eReport({
        passed: false,
        releaseProofEligible: false,
        startedAt: new Date(now - 45_000).toISOString(),
        finishedAt: new Date(now - 10_000).toISOString(),
      }),
    );
    writeReport(
      root,
      "2026-11-27T11-45-00-000Z",
      e2eReport({
        fullSuite: false,
        selectedScenarios: ["discovery"],
        scenarioCount: 1,
      }),
    );
    assert.throws(() => verifyReleaseE2eReport(root, { commit, now }), /pass/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("release E2E verifier rejects missing or malformed report artifacts", () => {
  const root = artifactRoot();
  try {
    assert.throws(
      () => verifyReleaseE2eReport(root, { commit, now }),
      /report|E2E/i,
    );
    writeReport(root, "broken", { commit, fullSuite: true });
    assert.throws(
      () => verifyReleaseE2eReport(root, { commit, now }),
      /pass|timestamp|Windows|eligible/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
