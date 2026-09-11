#!/usr/bin/env node
// Arlet dist/release directory tools. Architecture inspired by Zinnia;
// implementation is original and scoped to Arlet (Windows-only, no flatpak).
//
// Usage:
//   node scripts/dist-tools.js <clean|clean-release|clean-release-artifacts|clean-all|list>

import fs from "node:fs";
import path from "node:path";
import { createReleaseSession, verifyQualityGate } from "./release-session.js";

const TAURI_TARGET_DIR = path.join("src-tauri", "target");
const RELEASE_BUILD_SESSION = ".build-session.json";

const CLEAN_TARGETS = {
  clean: ["dist"],
  "clean-release": ["release"],
  "clean-release-artifacts": ["release", "dist"],
  "clean-all": ["dist", "release"],
};

function listTauriBundleDirs(cwd) {
  const targetRoot = path.join(cwd, TAURI_TARGET_DIR);
  if (!fs.existsSync(targetRoot)) return [];
  const results = [];
  const addIfDir = (fullPath) => {
    try {
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        results.push(path.relative(cwd, fullPath));
      }
    } catch {
      // Ignore unreadable entries; cleaning must stay best-effort per dir.
    }
  };
  addIfDir(path.join(targetRoot, "release", "bundle"));
  addIfDir(path.join(targetRoot, "debug", "bundle"));
  try {
    for (const entry of fs.readdirSync(targetRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const base = path.join(targetRoot, entry.name);
      addIfDir(path.join(base, "release", "bundle"));
      addIfDir(path.join(base, "debug", "bundle"));
      addIfDir(path.join(base, "bundle"));
    }
  } catch {
    // Ignore; base bundle dirs above are the common case.
  }
  return [...new Set(results)];
}

function getCleanTargets(mode, cwd) {
  const baseTargets = CLEAN_TARGETS[mode];
  if (!baseTargets) {
    throw new Error(`Unknown clean mode "${mode}"`);
  }
  if (mode === "clean-release-artifacts" || mode === "clean-all") {
    return [...new Set([...baseTargets, ...listTauriBundleDirs(cwd)])];
  }
  return baseTargets;
}

function cleanDirs(mode) {
  const cwd = process.cwd();
  const dirs = getCleanTargets(mode, cwd);

  // Refuse before deleting prior artifacts if the full quality gate was not
  // completed for this exact clean checkout and environment.
  if (mode === "clean-release-artifacts") {
    verifyQualityGate(cwd);
  }

  for (const relativeDir of dirs) {
    const dir = path.resolve(cwd, relativeDir);
    try {
      fs.rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      const message =
        error && typeof error === "object" && "message" in error
          ? String(error.message)
          : String(error);
      throw new Error(`Failed to clean "${relativeDir}": ${message}`);
    }
  }

  if (mode === "clean-release-artifacts") {
    const releaseDir = path.join(cwd, "release");
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(releaseDir, RELEASE_BUILD_SESSION),
      `${JSON.stringify(createReleaseSession(cwd))}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
}

function listArtifacts() {
  const cwd = process.cwd();
  for (const dir of ["dist", "release"]) {
    const full = path.join(cwd, dir);
    console.log(`${dir}/`);
    if (!fs.existsSync(full)) {
      console.log("  (missing)");
      continue;
    }
    for (const entry of fs.readdirSync(full)) {
      console.log(`  ${entry}`);
    }
  }
  for (const bundleDir of listTauriBundleDirs(cwd)) {
    console.log(`${bundleDir}/ (tauri bundle output)`);
  }
}

const mode = process.argv[2];

if (mode === "list") {
  listArtifacts();
  process.exit(0);
}

if (
  mode === "clean" ||
  mode === "clean-release" ||
  mode === "clean-release-artifacts" ||
  mode === "clean-all"
) {
  cleanDirs(mode);
  process.exit(0);
}

console.error(
  "Usage: node scripts/dist-tools.js <clean|clean-release|clean-release-artifacts|clean-all|list>",
);
process.exit(1);
