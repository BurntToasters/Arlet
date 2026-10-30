#!/usr/bin/env node
// Arlet release session + quality-gate proofs. Architecture inspired by Zinnia;
// implementation is original and scoped to Arlet (Windows-only distribution).
//
// Quality gate: coverage/.release-quality.json proves `test:all` passed for the
// exact commit/toolchain/lockfiles. Build session: release/.build-session.json
// proves `dist:clean-release-artifacts` ran after that gate without changes.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, "..");
const RELEASE_SESSION_RELATIVE_PATH = path.join(
  "release",
  ".build-session.json",
);
const QUALITY_GATE_RELATIVE_PATH = path.join(
  "coverage",
  ".release-quality.json",
);
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REQUIRED_QUALITY_GATE_STAGES = Object.freeze([
  "version",
  "deps",
  "typecheck",
  "lint",
  "format",
  "scripts",
  "rustfmt",
  "clippy",
  "rust",
  "e2e",
  "e2eApp",
]);
// The release VM runs over SSH, where WebView2 has no desktop; only the native
// app E2E may be recorded as deferred (run it at a desktop before publishing).
const DEFERRABLE_QUALITY_GATE_STAGES = Object.freeze(["e2eApp"]);

function command(commandName, args, root) {
  // trimEnd only: git porcelain lines start with two status columns and may
  // carry a meaningful leading space (" M path"). trim() would corrupt them.
  return execFileSync(commandName, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

/** Paths from `git status --porcelain=v1` (preserves leading XY columns). */
function porcelainPaths(statusText) {
  return statusText
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean)
    .map((line) => {
      const pathPart = line.length >= 3 ? line.slice(3) : line;
      return pathPart.includes(" -> ")
        ? pathPart.split(" -> ").at(-1)
        : pathPart;
    });
}

function isIgnorableReleaseDirtyPath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  const sessionPath = RELEASE_SESSION_RELATIVE_PATH.replaceAll("\\", "/");
  const qualityPath = QUALITY_GATE_RELATIVE_PATH.replaceAll("\\", "/");
  return (
    normalized.startsWith("src-tauri/gen/schemas/") ||
    normalized === "src-tauri/gen/" ||
    normalized === "src-tauri/gen/schemas/" ||
    normalized === sessionPath ||
    normalized === qualityPath
  );
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function currentReleaseIdentity(root = defaultRoot) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  let tauriCli = "unknown";
  try {
    // `npx` is a .cmd shim on Windows, which execFile cannot start without
    // a shell; run the CLI's own entry point with this Node instead.
    tauriCli = command(
      process.execPath,
      [
        path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"),
        "--version",
      ],
      root,
    );
  } catch {
    tauriCli = "unknown";
  }
  return {
    version: String(packageJson.version ?? ""),
    commit: command("git", ["rev-parse", "HEAD"], root),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    rustc: command("rustc", ["--version"], root),
    tauriCli,
    packageLockSha256: sha256File(path.join(root, "package-lock.json")),
    cargoLockSha256: sha256File(path.join(root, "src-tauri", "Cargo.lock")),
  };
}

function validateIdentity(record, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    if (record[key] !== value) {
      throw new Error(
        `${label} ${key} does not match this checkout/environment.`,
      );
    }
  }
}

function missingQualityGateStages(results, deferredStages = []) {
  return REQUIRED_QUALITY_GATE_STAGES.filter(
    (stage) =>
      !deferredStages.includes(stage) && results?.[stage]?.status !== "passed",
  );
}

function validateQualityGateCoverage(qualityGate) {
  const { verifiedStages } = qualityGate;
  if (
    !Array.isArray(verifiedStages) ||
    verifiedStages.some((stage) => typeof stage !== "string")
  ) {
    throw new Error(
      "Release quality-gate proof is missing required verified stage coverage; run test:all again.",
    );
  }
  const verified = new Set(verifiedStages);
  if (verified.size !== verifiedStages.length) {
    throw new Error(
      "Release quality-gate proof has invalid verified stage coverage; run test:all again.",
    );
  }
  const deferredStages = qualityGate.deferredStages ?? [];
  if (
    !Array.isArray(deferredStages) ||
    new Set(deferredStages).size !== deferredStages.length ||
    deferredStages.some(
      (stage) =>
        !DEFERRABLE_QUALITY_GATE_STAGES.includes(stage) || verified.has(stage),
    )
  ) {
    throw new Error(
      "Release quality-gate proof has invalid deferred stage coverage; run test:all again.",
    );
  }
  const missing = REQUIRED_QUALITY_GATE_STAGES.filter(
    (stage) => !verified.has(stage) && !deferredStages.includes(stage),
  );
  if (missing.length > 0) {
    throw new Error(
      `Release quality-gate proof has incomplete verified stage coverage (missing: ${missing.join(", ")}); run test:all again.`,
    );
  }
}

function validateReleaseSession(
  session,
  expected,
  { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {},
) {
  if (!session || typeof session !== "object") {
    throw new Error("Release build session is not an object.");
  }
  if (!Number.isFinite(session.startedAt)) {
    throw new Error("Release build session has no valid start time.");
  }
  const age = now - session.startedAt;
  if (age < 0 || age > maxAgeMs) {
    throw new Error(
      "Release build session is expired; run release:prepare again.",
    );
  }
  validateIdentity(session, expected, "Release build session");
  if (
    !Number.isFinite(session.qualityGateCompletedAt) ||
    session.qualityGateCompletedAt >= session.startedAt
  ) {
    throw new Error("Release build session has no valid quality-gate proof.");
  }
  return session;
}

function validateQualityGate(
  qualityGate,
  expected,
  { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {},
) {
  if (!qualityGate || typeof qualityGate !== "object") {
    throw new Error("Release quality-gate proof is not an object.");
  }
  if (!Number.isFinite(qualityGate.completedAt)) {
    throw new Error("Release quality-gate proof has no valid completion time.");
  }
  const age = now - qualityGate.completedAt;
  if (age < 0 || age > maxAgeMs) {
    throw new Error(
      "Release quality-gate proof is expired; run test:all again.",
    );
  }
  validateIdentity(qualityGate, expected, "Release quality-gate proof");
  validateQualityGateCoverage(qualityGate);
  return qualityGate;
}

function clearQualityGateProof(root = defaultRoot) {
  fs.rmSync(path.join(root, QUALITY_GATE_RELATIVE_PATH), { force: true });
}

function recordSuccessfulQualityGate(
  root = defaultRoot,
  results,
  { deferredStages = [] } = {},
) {
  if (
    deferredStages.some(
      (stage) => !DEFERRABLE_QUALITY_GATE_STAGES.includes(stage),
    )
  ) {
    throw new Error(
      `Quality-gate stages cannot be deferred: ${deferredStages.join(", ")}`,
    );
  }
  const missingStages = missingQualityGateStages(results, deferredStages);
  if (missingStages.length > 0) {
    return { recorded: false, dirtyFiles: null, missingStages };
  }
  let status;
  try {
    status = command(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      root,
    );
  } catch {
    return { recorded: false, dirtyFiles: null };
  }
  if (status) {
    const dirtyPaths = porcelainPaths(status).filter(
      (filePath) => !isIgnorableReleaseDirtyPath(filePath),
    );
    if (dirtyPaths.length > 0) {
      return { recorded: false, dirtyFiles: status };
    }
  }
  const proofPath = path.join(root, QUALITY_GATE_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  fs.writeFileSync(
    proofPath,
    `${JSON.stringify({
      ...currentReleaseIdentity(root),
      completedAt: Date.now(),
      verifiedStages: REQUIRED_QUALITY_GATE_STAGES.filter(
        (stage) => !deferredStages.includes(stage),
      ),
      ...(deferredStages.length > 0 ? { deferredStages } : {}),
    })}\n`,
    { mode: 0o600 },
  );
  return { recorded: true, dirtyFiles: null };
}

function assertReleaseTreeClean(root = defaultRoot) {
  let status;
  try {
    status = command(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      root,
    );
  } catch (error) {
    throw new Error(
      `Could not inspect the release working tree: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!status) return;
  const dirtyPaths = porcelainPaths(status).filter(
    (filePath) => !isIgnorableReleaseDirtyPath(filePath),
  );
  if (dirtyPaths.length > 0) {
    throw new Error(
      `Release working tree changed after the quality gate; run test:all again before continuing:\n${status}`,
    );
  }
}

function verifyQualityGate(root = defaultRoot, options) {
  const proofPath = path.join(root, QUALITY_GATE_RELATIVE_PATH);
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Release quality-gate proof is missing or invalid. Run test:all first: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateQualityGate(proof, currentReleaseIdentity(root), options);
}

function createReleaseSession(root = defaultRoot) {
  const qualityGate = verifyQualityGate(root);
  return {
    ...currentReleaseIdentity(root),
    qualityGateCompletedAt: qualityGate.completedAt,
    startedAt: Date.now(),
  };
}

function verifyReleaseSession(root = defaultRoot, options) {
  const sessionPath = path.join(root, RELEASE_SESSION_RELATIVE_PATH);
  let session;
  try {
    session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Release build session is missing or invalid. Run release:prepare first: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const validated = validateReleaseSession(
    session,
    currentReleaseIdentity(root),
    options,
  );
  const qualityGate = verifyQualityGate(root, options);
  if (qualityGate.completedAt !== validated.qualityGateCompletedAt) {
    throw new Error(
      "Release build session does not reference the current verified quality-gate proof; run release:prepare again.",
    );
  }
  assertReleaseTreeClean(root);
  return validated;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    const session = verifyReleaseSession();
    const { deferredStages = [] } = verifyQualityGate();
    if (deferredStages.length > 0) {
      console.warn(
        `release-session: deferred quality-gate stages (${deferredStages.join(", ")}); run npm run test:e2e:app at a Windows desktop on this commit before publishing.`,
      );
    }
    console.log(
      `release-session: ok (${session.version}, ${session.commit.slice(0, 12)}, ${session.platform}-${session.arch})`,
    );
  } catch (error) {
    console.error(
      `release-session: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export {
  DEFAULT_MAX_AGE_MS,
  DEFERRABLE_QUALITY_GATE_STAGES,
  QUALITY_GATE_RELATIVE_PATH,
  REQUIRED_QUALITY_GATE_STAGES,
  RELEASE_SESSION_RELATIVE_PATH,
  assertReleaseTreeClean,
  clearQualityGateProof,
  createReleaseSession,
  currentReleaseIdentity,
  isIgnorableReleaseDirtyPath,
  missingQualityGateStages,
  porcelainPaths,
  recordSuccessfulQualityGate,
  validateQualityGate,
  validateReleaseSession,
  verifyQualityGate,
  verifyReleaseSession,
};
