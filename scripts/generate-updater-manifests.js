#!/usr/bin/env node
// Arlet updater manifest generator. Workflow modeled on Zinnia's release
// tooling; implementation is original and scoped to Windows NSIS.
//
// Tauri does not emit `latest-*.json` itself: this step builds them from the
// signed `-setup.exe` + `-setup.exe.sig` pairs so the updater has versioned
// metadata to poll. Asset URLs are deterministic
// (`.../releases/download/<tag>/<name>`), so manifests are generated BEFORE
// signing/upload and get checksummed + GPG-signed like any other artifact.
//
// Usage: npm run release:updater-manifests (after both arch builds)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateUpdaterManifest } from "./validate-updater-manifest.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const { version: VERSION } = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const TAG_NAME = `v${VERSION}`;
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "Arlet";

const ARCH_FROM_INSTALLER = [
  { pattern: /_x64-/i, platform: "windows-x86_64" },
  { pattern: /_arm64-/i, platform: "windows-aarch64" },
];

export function platformForInstaller(fileName) {
  for (const { pattern, platform } of ARCH_FROM_INSTALLER) {
    if (pattern.test(fileName)) return platform;
  }
  return null;
}

export function findSignedInstallers(
  rootDir = repoRoot,
  readDir = fs.readdirSync,
  isFile = (p) => fs.statSync(p).isFile(),
) {
  const results = [];
  const bundleRoots = [path.join(rootDir, "src-tauri", "target")];
  const walk = (dir) => {
    let entries;
    try {
      entries = readDir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/-setup\.exe$/i.test(entry.name) && isFile(full)) {
        const sig = `${full}.sig`;
        let hasSig = false;
        try {
          hasSig = isFile(sig);
        } catch {
          hasSig = false;
        }
        if (hasSig) results.push({ exe: full, sig });
      }
    }
  };
  for (const rel of bundleRoots) walk(rel);
  return results;
}

export function buildManifests(
  installers,
  {
    version = VERSION,
    tag = TAG_NAME,
    owner = REPO_OWNER,
    repo = REPO_NAME,
    notes = `Arlet ${TAG_NAME}`,
    pubdate = new Date().toISOString(),
    readSig = (p) => fs.readFileSync(p, "utf8").trim(),
  } = {},
) {
  const platforms = {};
  for (const { exe, sig } of installers) {
    const platform = platformForInstaller(path.basename(exe));
    if (!platform) {
      throw new Error(`Cannot map installer to a platform: ${exe}`);
    }
    if (platforms[platform]) {
      throw new Error(`Duplicate installer for platform ${platform}: ${exe}`);
    }
    platforms[platform] = {
      url: `https://github.com/${owner}/${repo}/releases/download/${tag}/${path.basename(exe)}`,
      signature: readSig(sig),
    };
  }
  if (Object.keys(platforms).length === 0) {
    throw new Error("No signed installers found; build both arches first.");
  }
  const manifests = {};
  for (const platform of Object.keys(platforms)) {
    const name = `latest-${platform}.json`;
    manifests[name] = { version, notes, pubdate, platforms };
  }
  return manifests;
}

export function draftNotes(
  runGh = (args) =>
    execFileSync("gh", args, { cwd: repoRoot, encoding: "utf8" }).trim(),
) {
  try {
    const out = runGh([
      "release",
      "view",
      TAG_NAME,
      "--repo",
      `${REPO_OWNER}/${REPO_NAME}`,
      "--json",
      "body",
    ]);
    const body = JSON.parse(out).body;
    if (typeof body === "string" && body.trim()) return body.trim();
  } catch {
    // Draft may not exist yet in dry runs; fall back below.
  }
  return `Arlet ${TAG_NAME}`;
}

function main() {
  const installers = findSignedInstallers();
  const manifests = buildManifests(installers, { notes: draftNotes() });
  const releaseDir = path.join(repoRoot, "release");
  fs.mkdirSync(releaseDir, { recursive: true });
  for (const [name, manifest] of Object.entries(manifests)) {
    const errors = validateUpdaterManifest(manifest, name);
    if (errors.length > 0) {
      throw new Error(`Generated ${name} is invalid:\n${errors.join("\n")}`);
    }
    if (manifest.version !== VERSION) {
      throw new Error(`Generated ${name} version drifted from ${VERSION}.`);
    }
    fs.writeFileSync(
      path.join(releaseDir, name),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `[updater-manifests] Wrote ${name} (${Object.keys(manifest.platforms).length} platform(s)).`,
    );
  }
  if (Object.keys(manifests).length < 2) {
    console.warn(
      "[updater-manifests] WARNING: fewer than 2 arch manifests; releases must ship x64 + ARM64.",
    );
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    main();
  } catch (error) {
    console.error(
      `[updater-manifests] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
