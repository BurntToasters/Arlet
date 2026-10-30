import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  REQUIRED_QUALITY_GATE_STAGES,
  createReleaseSession,
  currentReleaseIdentity,
  validateQualityGate,
} from "./release-session.js";

// Failure modes covered before production edits:
// - identity and timestamp alone must not validate an old/incomplete proof;
// - all mandatory stages must be explicitly represented in a valid proof;
// - release-session creation must validate coverage before accepting a proof.

const now = 1_800_000_000_000;
const expectedIdentity = {
  version: "0.4.0-beta.2",
  commit: "abc123",
  platform: "win32",
  arch: "x64",
  node: "v24.0.0",
  rustc: "rustc test",
  tauriCli: "unknown",
  packageLockSha256: "package-lock-hash",
  cargoLockSha256: "cargo-lock-hash",
};

function proof(overrides = {}) {
  return {
    ...expectedIdentity,
    completedAt: now - 1,
    verifiedStages: [...REQUIRED_QUALITY_GATE_STAGES],
    ...overrides,
  };
}

function scratchReleaseRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arlet-quality-proof-"));
  fs.mkdirSync(path.join(root, "src-tauri"), { recursive: true });
  fs.mkdirSync(path.join(root, "coverage"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ version: "0.4.0-beta.2" }),
  );
  fs.writeFileSync(path.join(root, "package-lock.json"), "fixture lock\n");
  fs.writeFileSync(
    path.join(root, "src-tauri", "Cargo.lock"),
    "fixture cargo lock\n",
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Release Proof Test"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.email", "proof-test@example.invalid"], {
    cwd: root,
  });
  execFileSync(
    "git",
    ["add", "package.json", "package-lock.json", "src-tauri/Cargo.lock"],
    { cwd: root },
  );
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root });
  return root;
}

test("quality proof rejects missing or incomplete verified stage coverage", () => {
  assert.throws(
    () =>
      validateQualityGate(
        proof({ verifiedStages: undefined }),
        expectedIdentity,
        { now },
      ),
    /required verified stage coverage/,
  );
  assert.throws(
    () =>
      validateQualityGate(
        proof({ verifiedStages: REQUIRED_QUALITY_GATE_STAGES.slice(1) }),
        expectedIdentity,
        { now },
      ),
    /version/,
  );
});

test("quality proof accepts explicit complete verified stage coverage", () => {
  const validated = validateQualityGate(proof(), expectedIdentity, { now });
  assert.deepEqual(validated.verifiedStages, [...REQUIRED_QUALITY_GATE_STAGES]);
});

test("release session cannot be created from an identity-only proof", () => {
  const root = scratchReleaseRoot();
  try {
    const identity = currentReleaseIdentity(root);
    fs.writeFileSync(
      path.join(root, "coverage", ".release-quality.json"),
      `${JSON.stringify({ ...identity, completedAt: Date.now() })}\n`,
    );
    assert.throws(
      () => createReleaseSession(root),
      /required verified stage coverage/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
