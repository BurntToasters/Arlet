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

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateUpdaterManifest } from "./validate-updater-manifest.js";
import { assertStableReleaseOverridesAllowed } from "./release-policy.cjs";
import { readChangelogSection } from "./changelog.cjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const changelogPath = path.join(repoRoot, "CHANGELOG.md");
const { version: VERSION } = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const TAG_NAME = `v${VERSION}`;
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "Arlet";

const ARCH_FROM_INSTALLER = [
  { pattern: /_x64-/i, arch: "x86_64" },
  { pattern: /_arm64-/i, arch: "aarch64" },
];

export const REQUIRED_STABLE_MANIFEST_NAMES = [
  "latest-windows-x86_64.json",
  "latest-windows-aarch64.json",
];

export const REQUIRED_BETA_MANIFEST_NAMES = [
  "latest-windows-beta-x86_64.json",
  "latest-windows-beta-x86_64-nsis.json",
  "latest-windows-beta-aarch64.json",
  "latest-windows-beta-aarch64-nsis.json",
];

export const REQUIRED_MANIFEST_NAMES = [
  ...REQUIRED_STABLE_MANIFEST_NAMES,
  ...REQUIRED_BETA_MANIFEST_NAMES,
];

export function platformForInstaller(fileName) {
  for (const { pattern, arch } of ARCH_FROM_INSTALLER) {
    if (pattern.test(fileName)) return `windows-${arch}`;
  }
  return null;
}

export function archForInstaller(fileName) {
  for (const { pattern, arch } of ARCH_FROM_INSTALLER) {
    if (pattern.test(fileName)) return arch;
  }
  return null;
}

// `tauri signer sign` normally writes the minisign envelope as a base64
// string, but older release VMs can leave the four-line envelope unencoded.
// Tauri's updater JSON always carries the outer base64 form; normalize at the
// generator boundary so either sidecar representation produces the same feed.
export function normalizeUpdaterSignature(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.includes("untrusted comment:")
    ? Buffer.from(trimmed, "utf8").toString("base64")
    : trimmed;
}

export function findSignedInstallers(
  rootDir = repoRoot,
  readDir = fs.readdirSync,
  isFile = (p) => fs.statSync(p).isFile(),
) {
  const results = [];
  const targetRoot = path.join(rootDir, "src-tauri", "target");
  const bundleRoots = [path.join(targetRoot, "release", "bundle")];
  try {
    for (const entry of readDir(targetRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        bundleRoots.push(
          path.join(targetRoot, entry.name, "release", "bundle"),
        );
      }
    }
  } catch {
    // The walkers below turn an absent target/build into an empty result.
  }
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
  for (const bundleRoot of bundleRoots) walk(bundleRoot);
  return results;
}

export function buildManifests(
  installers,
  {
    version = VERSION,
    tag = TAG_NAME,
    owner = REPO_OWNER,
    repo = REPO_NAME,
    notes,
    pubDate,
    // Keep accepting the old option for callers outside the repository while
    // never emitting the obsolete `pubdate` key.
    pubdate,
    readSig = (p) => fs.readFileSync(p, "utf8").trim(),
  } = {},
) {
  const installersByArch = new Map();
  for (const { exe, sig } of installers) {
    const arch = archForInstaller(path.basename(exe));
    if (!arch) {
      throw new Error(`Cannot map installer to a platform: ${exe}`);
    }
    if (installersByArch.has(arch)) {
      throw new Error(`Duplicate installer for architecture ${arch}: ${exe}`);
    }
    installersByArch.set(arch, {
      url: `https://github.com/${owner}/${repo}/releases/download/${tag}/${path.basename(exe)}`,
      signature: normalizeUpdaterSignature(readSig(sig)),
    });
  }
  if (installersByArch.size === 0) {
    throw new Error("No signed installers found; build both arches first.");
  }

  const missingArchitectures = ["x86_64", "aarch64"].filter(
    (arch) => !installersByArch.has(arch),
  );
  if (missingArchitectures.length > 0) {
    throw new Error(
      `Missing signed installer architecture(s): ${missingArchitectures.join(", ")}. Build both arches first.`,
    );
  }

  const selectedNotes = notes ?? readChangelogSection(changelogPath, version);

  const publicationDate =
    pubDate ??
    pubdate ??
    process.env.RELEASE_PUB_DATE ??
    new Date().toISOString();
  const manifests = {};
  for (const arch of ["x86_64", "aarch64"]) {
    const artifact = installersByArch.get(arch);
    const stableTarget = `windows-${arch}`;
    const betaTarget = `windows-beta-${arch}`;
    const stablePlatforms = {
      [`${stableTarget}-nsis`]: artifact,
      [stableTarget]: artifact,
    };
    const betaPlatforms = {
      [`${betaTarget}-nsis`]: artifact,
      [betaTarget]: artifact,
    };
    const createManifest = (platforms) => ({
      version,
      pub_date: publicationDate,
      notes: selectedNotes,
      platforms,
    });
    manifests[`latest-${stableTarget}.json`] = createManifest(stablePlatforms);
    manifests[`latest-${betaTarget}.json`] = createManifest(betaPlatforms);
    manifests[`latest-${betaTarget}-nsis.json`] = createManifest({
      [`${betaTarget}-nsis`]: artifact,
    });
  }
  return manifests;
}

function main() {
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  const installers = findSignedInstallers();
  const notes = readChangelogSection(changelogPath, VERSION);
  const manifests = buildManifests(installers, { notes });
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
