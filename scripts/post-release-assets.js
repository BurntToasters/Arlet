#!/usr/bin/env node
// Arlet post-release asset library. Workflow modeled on Zinnia's
// post-release tooling; implementation is original.
//
// After a release is verified, the cleaned `release/` entries are mirrored to
// the AFTER_PACK_LOC archive dir (outside the repo) with per-file hash
// verification, because `release:finalize` then resets the checkout.
// Stable releases require the mirror; beta releases skip it by default
// (OVERRIDE_BETA_MIRROR_SKIP=1 forces it, SKIP_RELEASE_MIRROR=1 skips all).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertStableReleaseOverridesAllowed } from "./release-policy.cjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(scriptDir, "..");
export const RELEASE_DIR = path.join(REPOSITORY_ROOT, "release");

// Machine-local markers; never mirrored, never shipped.
export const BUILD_ONLY_FILES = [".build-session.json"];

const HASH_BUFFER_BYTES = 1024 * 1024;

export function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  const fd = fs.openSync(filePath, "r");
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export function removePath(targetPath) {
  fs.rmSync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
}

export function cleanReleaseArtifacts(releaseDir = RELEASE_DIR) {
  for (const file of BUILD_ONLY_FILES) {
    removePath(path.join(releaseDir, file));
  }
}

export function getAfterPackLocation(env = process.env) {
  const value = env.AFTER_PACK_LOC;
  return typeof value === "string" ? value.trim() : "";
}

export function isBetaReleaseVersion(version) {
  const numeric = "(?:0|[1-9]\\d*)";
  return new RegExp(
    `^${numeric}\\.${numeric}\\.${numeric}-beta\\.${numeric}$`,
  ).test(String(version ?? ""));
}

export function readPackageVersion(repositoryRoot = REPOSITORY_ROOT) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  return typeof packageJson.version === "string" ? packageJson.version : "";
}

export function shouldSkipBetaMirror(env = process.env, version) {
  if (!isBetaReleaseVersion(version)) return false;
  return String(env.OVERRIDE_BETA_MIRROR_SKIP ?? "").trim() !== "1";
}

export function allowSkipMirror(env = process.env) {
  return /^(1|true|yes|on)$/i.test(
    String(env.SKIP_RELEASE_MIRROR ?? "").trim(),
  );
}

export function pathsEqual(left, right, platform = process.platform) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (platform === "win32") {
    return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  }
  return resolvedLeft === resolvedRight;
}

export function pathIsSameOrInside(
  candidate,
  parent,
  platform = process.platform,
) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedParent = path.resolve(parent);
  const normalize = (value) =>
    platform === "win32" ? value.toLowerCase() : value;
  const candidateForComparison = normalize(resolvedCandidate);
  const parentForComparison = normalize(resolvedParent);
  return (
    candidateForComparison === parentForComparison ||
    candidateForComparison.startsWith(`${parentForComparison}${path.sep}`)
  );
}

export function isMirrorableReleaseEntry(name) {
  // Dotfiles are build/session markers, never ship artifacts.
  return Boolean(name) && !name.startsWith(".");
}

export function getReleaseEntries(releaseDir) {
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`release directory does not exist: ${releaseDir}`);
  }
  const entries = fs.readdirSync(releaseDir).filter(isMirrorableReleaseEntry);
  if (!entries.length) {
    throw new Error(`release directory is empty: ${releaseDir}`);
  }
  return entries;
}

export function verifyCopiedPath(sourcePath, destinationPath) {
  const source = fs.statSync(sourcePath);
  let destination;
  try {
    destination = fs.statSync(destinationPath);
  } catch {
    throw new Error(`mirrored path is missing: ${destinationPath}`);
  }
  if (source.isDirectory() !== destination.isDirectory()) {
    throw new Error(`mirrored path type differs: ${destinationPath}`);
  }
  if (source.isFile()) {
    if (source.size !== destination.size) {
      throw new Error(
        `mirrored file size differs: ${destinationPath} (${destination.size} bytes; expected ${source.size})`,
      );
    }
    if (sha256File(sourcePath) !== sha256File(destinationPath)) {
      throw new Error(`mirrored file hash differs: ${destinationPath}`);
    }
  }
  if (source.isDirectory()) {
    for (const entry of fs.readdirSync(sourcePath)) {
      verifyCopiedPath(
        path.join(sourcePath, entry),
        path.join(destinationPath, entry),
      );
    }
  }
}

// Copy without fs.cpSync's native recursive fast-path: on Windows mapped
// drives it can abort the whole Node process instead of throwing, which
// produced a "banners print, then silent exit, nothing mirrored" failure.
export function copyFileForMirror(sourcePath, destinationPath) {
  try {
    fs.copyFileSync(sourcePath, destinationPath);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code !== "EPERM" && code !== "EACCES") throw error;
    // SMB/CIFS often rejects permission-bit preservation; bytes still work.
    fs.writeFileSync(destinationPath, fs.readFileSync(sourcePath));
  }
}

export function copyPathRecursive(sourcePath, destinationPath) {
  const source = fs.statSync(sourcePath);
  if (source.isDirectory()) {
    fs.mkdirSync(destinationPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath)) {
      copyPathRecursive(
        path.join(sourcePath, entry),
        path.join(destinationPath, entry),
      );
    }
    return;
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  copyFileForMirror(sourcePath, destinationPath);
}

export function uniqueMirrorSibling(destinationPath, label) {
  const dir = path.dirname(destinationPath);
  const base = path.basename(destinationPath);
  return path.join(
    dir,
    `.arlet-mirror-${label}-${process.pid}-${crypto.randomBytes(6).toString("hex")}-${base}`,
  );
}

export function copyReleaseEntryToMirror(sourcePath, destinationPath) {
  const stagingPath = uniqueMirrorSibling(destinationPath, "new");
  const rollbackPath = uniqueMirrorSibling(destinationPath, "old");
  removePath(stagingPath);
  copyPathRecursive(sourcePath, stagingPath);
  try {
    verifyCopiedPath(sourcePath, stagingPath);
  } catch (error) {
    removePath(stagingPath);
    throw error;
  }
  const hadPrevious = fs.existsSync(destinationPath);
  if (hadPrevious) {
    removePath(rollbackPath);
    fs.renameSync(destinationPath, rollbackPath);
  }
  try {
    fs.renameSync(stagingPath, destinationPath);
  } catch (error) {
    if (hadPrevious && fs.existsSync(rollbackPath)) {
      try {
        fs.renameSync(rollbackPath, destinationPath);
      } catch {
        // Leave rollback beside dest for manual recovery.
      }
    }
    removePath(stagingPath);
    throw error;
  }
  verifyCopiedPath(sourcePath, destinationPath);
  if (hadPrevious) removePath(rollbackPath);
}

export function resolveMirrorPaths(
  releaseDir = RELEASE_DIR,
  destination,
  repositoryRoot = REPOSITORY_ROOT,
) {
  if (!destination) throw new Error("AFTER_PACK_LOC is empty");
  if (!path.isAbsolute(destination)) {
    throw new Error(
      `AFTER_PACK_LOC must be an absolute path on this platform: ${destination}`,
    );
  }
  const requestedReleaseDir = path.resolve(releaseDir);
  if (
    !fs.existsSync(requestedReleaseDir) ||
    !fs.statSync(requestedReleaseDir).isDirectory()
  ) {
    throw new Error(`release directory does not exist: ${requestedReleaseDir}`);
  }
  const resolvedReleaseDir = fs.realpathSync.native(requestedReleaseDir);
  const requestedDestination = path.resolve(destination);
  if (
    fs.existsSync(requestedDestination) &&
    fs.lstatSync(requestedDestination).isSymbolicLink()
  ) {
    throw new Error(
      `AFTER_PACK_LOC must not be a symbolic link: ${requestedDestination}`,
    );
  }
  // Resolve through the nearest existing ancestor so not-yet-created archive
  // dirs still get symlink/parent validation.
  const missingSegments = [];
  let existingAncestor = requestedDestination;
  while (!fs.existsSync(existingAncestor)) {
    missingSegments.unshift(path.basename(existingAncestor));
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const resolvedDestination = path.join(
    fs.realpathSync.native(existingAncestor),
    ...missingSegments,
  );
  if (pathsEqual(resolvedDestination, resolvedReleaseDir)) {
    throw new Error("AFTER_PACK_LOC cannot be the release directory");
  }
  const resolvedRepositoryRoot = fs.realpathSync.native(repositoryRoot);
  if (pathIsSameOrInside(resolvedDestination, resolvedRepositoryRoot)) {
    throw new Error(
      `AFTER_PACK_LOC must be outside the repository: ${resolvedRepositoryRoot}`,
    );
  }
  const releasePrefix = `${resolvedReleaseDir}${path.sep}`;
  const destinationForComparison =
    process.platform === "win32"
      ? resolvedDestination.toLowerCase()
      : resolvedDestination;
  const releasePrefixForComparison =
    process.platform === "win32" ? releasePrefix.toLowerCase() : releasePrefix;
  if (destinationForComparison.startsWith(releasePrefixForComparison)) {
    throw new Error("AFTER_PACK_LOC cannot be inside the release directory");
  }
  return { resolvedReleaseDir, resolvedDestination };
}

export function copyReleaseAssets(
  releaseDir = RELEASE_DIR,
  destination,
  { logger = console } = {},
) {
  const { resolvedReleaseDir, resolvedDestination } = resolveMirrorPaths(
    releaseDir,
    destination,
  );
  const entries = getReleaseEntries(resolvedReleaseDir);
  logger.error(
    `[release:mirror] copying ${entries.length} entries to shared mirror (overwrite same names only)`,
  );
  fs.mkdirSync(resolvedDestination, { recursive: true });
  for (const entry of entries) {
    copyReleaseEntryToMirror(
      path.join(resolvedReleaseDir, entry),
      path.join(resolvedDestination, entry),
    );
    logger.error(`[release:mirror] verified ${entry}`);
  }
  return entries.length;
}

export function finalizeReleaseAssets({
  releaseDir = RELEASE_DIR,
  env = process.env,
  logger = console,
  version = readPackageVersion(),
} = {}) {
  assertStableReleaseOverridesAllowed(env, version);
  let destination = getAfterPackLocation(env);
  let skippedBetaMirror = false;
  if (destination && shouldSkipBetaMirror(env, version)) {
    skippedBetaMirror = true;
    destination = "";
  } else if (!destination) {
    logger.error(
      "AFTER_PACK_LOC is not set; skipping the verified mirror (clean only).",
    );
  } else {
    // Resolve every boundary before removing build-only files. A malformed,
    // repository-local, or symlinked destination must leave `release/` intact.
    resolveMirrorPaths(releaseDir, destination);
  }
  cleanReleaseArtifacts(releaseDir);
  if (!destination) {
    logger.log(
      skippedBetaMirror
        ? `Cleaned release assets without mirroring (beta version ${version}; set OVERRIDE_BETA_MIRROR_SKIP=1 to force).`
        : "Cleaned release assets without mirroring (AFTER_PACK_LOC unset).",
    );
    return {
      mirrored: false,
      destination: "",
      copiedEntries: 0,
      skippedBetaMirror,
    };
  }
  const copiedEntries = copyReleaseAssets(releaseDir, destination, { logger });
  logger.log(
    `Mirrored and verified ${copiedEntries} cleaned release entries to: ${path.resolve(destination)}`,
  );
  return {
    mirrored: true,
    destination: path.resolve(destination),
    copiedEntries,
    skippedBetaMirror: false,
  };
}
