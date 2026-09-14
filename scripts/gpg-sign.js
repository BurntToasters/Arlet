#!/usr/bin/env node
// Arlet release signer and updater-feed publisher. The release shape follows
// Zinnia's Windows channel workflow, with Arlet's NSIS-only artifact set.
//
// Normal mode stages/signs the two Windows installers, their Tauri updater
// sidecars, the stable+beta manifests, and checksums, then uploads them to
// the exact-version draft. A beta draft is not copied to the live stable feed:
// release:publish performs that sync only after GitHub confirms the beta is a
// published prerelease. `--sync-beta-manifests` is the recovery path when
// publication succeeds but that post-publish sync loses connectivity.

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REQUIRED_BETA_MANIFEST_NAMES,
  REQUIRED_MANIFEST_NAMES,
} from "./generate-updater-manifests.js";
import {
  assertUpdaterTargetArtifact,
  hasMinisignEnvelope,
  validateUpdaterManifest,
} from "./validate-updater-manifest.js";
import { assertStableReleaseOverridesAllowed } from "./release-policy.cjs";
import { verifyUpdaterSignatures } from "./updater-signature-verifier.js";

const require = createRequire(import.meta.url);
const {
  assertGitHubCliAuthenticated,
  githubApi,
  githubApiToFile,
  uploadReleaseAsset,
} = require("./github-cli.cjs");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const releaseDir = path.join(root, "release");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const VERSION = String(packageJson.version || "").trim();
const TAG_NAME = `v${VERSION}`;
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "Arlet";
const NUMERIC = "(?:0|[1-9]\\d*)";
const BETA_VERSION = new RegExp(
  `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}-beta\\.${NUMERIC}$`,
);
const STABLE_VERSION = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}$`);
const IS_PRERELEASE = BETA_VERSION.test(VERSION);
const HASH_BUFFER_BYTES = 1024 * 1024;
if (!IS_PRERELEASE && !STABLE_VERSION.test(VERSION)) {
  throw new Error(
    `Unsupported release version '${VERSION}'; Arlet releases use beta or stable only.`,
  );
}

const GPG_KEY_ID = process.env.GPG_KEY_ID?.trim();
const GPG_PASSPHRASE = process.env.GPG_PASSPHRASE;
const FORCE_UPLOAD = /^(1|true|yes|on)$/i.test(
  String(process.env.FORCE_UPLOAD || "").trim(),
);
const BETA_SYNC_LOCK_NAME = "arlet-beta-manifest-sync-lock";
const BETA_SYNC_LOCK_RETRIES = Math.max(
  1,
  Number.parseInt(process.env.BETA_SYNC_LOCK_RETRIES || "30", 10) || 30,
);
const BETA_SYNC_LOCK_DELAY_MS = Math.max(
  50,
  Number.parseInt(process.env.BETA_SYNC_LOCK_DELAY_MS || "2000", 10) || 2000,
);

function isExplicitTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function currentReleaseCommit() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("Could not resolve an exact release commit from git HEAD.");
  }
  return commit;
}

export function assertReleaseTargetsCommit(
  release,
  commit,
  { force = FORCE_UPLOAD, log = console } = {},
) {
  if (release?.target_commitish === commit) return release;
  if (force) {
    log.warn(
      `WARNING: release ${TAG_NAME} targets ${release?.target_commitish || "an unknown commit"}, not checked-out commit ${commit}; FORCE_UPLOAD is bypassing the commit fence.`,
    );
    return release;
  }
  throw new Error(
    `Release ${TAG_NAME} targets ${release?.target_commitish || "an unknown commit"}, not checked-out commit ${commit}. Refusing to upload stale artifacts. Set FORCE_UPLOAD=1 only after inspecting the release.`,
  );
}

function releaseApiPath(suffix) {
  return `/repos/${REPO_OWNER}/${REPO_NAME}${suffix}`;
}

function getReleaseByTag(tag = TAG_NAME) {
  try {
    return githubApi(
      "GET",
      releaseApiPath(`/releases/tags/${encodeURIComponent(tag)}`),
    );
  } catch (error) {
    if (error?.statusCode !== 404 || tag !== TAG_NAME) throw error;
    for (let page = 1; page <= 20; page += 1) {
      const releases = githubApi(
        "GET",
        releaseApiPath(`/releases?per_page=100&page=${page}`),
      );
      if (!Array.isArray(releases)) break;
      const placeholder = releases.find(
        (release) =>
          release?.draft &&
          release.name === VERSION &&
          /^untagged-[0-9a-f]{20}$/i.test(String(release.tag_name || "")),
      );
      if (placeholder) return placeholder;
      if (releases.length < 100) break;
    }
    throw error;
  }
}

function listReleaseAssets(releaseId) {
  const results = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = githubApi(
      "GET",
      releaseApiPath(`/releases/${releaseId}/assets?per_page=100&page=${page}`),
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    results.push(...batch);
    if (batch.length < 100) break;
  }
  return results;
}

function deleteReleaseAsset(assetId) {
  return githubApi("DELETE", releaseApiPath(`/releases/assets/${assetId}`));
}

function renameReleaseAsset(assetId, name) {
  return githubApi("PATCH", releaseApiPath(`/releases/assets/${assetId}`), {
    name,
  });
}

export function isGitHubConflict(error) {
  return error?.statusCode === 409 || error?.statusCode === 422;
}

function resolveUpdaterTargets(name) {
  if (!/^Arlet_[^/\\]+_(?:x64|arm64)-setup\.exe$/i.test(String(name))) {
    return [];
  }
  return [{ os: "windows", installer: "nsis" }];
}

function releaseArtifactSearchDirs() {
  const targetRoot = path.join(root, "src-tauri", "target");
  const directories = [path.join(targetRoot, "release", "bundle")];
  try {
    for (const entry of fs.readdirSync(targetRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        directories.push(
          path.join(targetRoot, entry.name, "release", "bundle"),
        );
      }
    }
  } catch {
    // The walker below reports the useful no-artifacts error when target is
    // absent or no release bundle has been built yet.
  }
  return directories;
}

function findArtifacts() {
  const results = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && /\.(exe|msi|sig|nsis\.zip)$/i.test(entry.name)) {
        results.push(full);
      }
    }
  };
  for (const directory of releaseArtifactSearchDirs()) walk(directory);
  return [...new Set(results)].sort();
}

function expectedInstallerName(arch) {
  return `Arlet_${VERSION}_${arch}-setup.exe`;
}

function assertSignedInstallerSet(artifacts) {
  const names = new Set(artifacts.map((filePath) => path.basename(filePath)));
  const escapedVersion = VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const allowed = new RegExp(
    `^Arlet_${escapedVersion}_(?:x64|arm64)-setup\\.exe(?:\\.sig)?$`,
    "i",
  );
  const unexpected = [...names].filter((name) => !allowed.test(name));
  if (unexpected.length > 0) {
    throw new Error(
      `Release artifact set contains unsupported file(s): ${unexpected.sort().join(", ")}. Only the two signed NSIS installers and their .sig sidecars may be uploaded.`,
    );
  }
  const missing = [];
  for (const arch of ["x64", "arm64"]) {
    const installer = expectedInstallerName(arch);
    if (!names.has(installer)) missing.push(installer);
    if (!names.has(`${installer}.sig`)) missing.push(`${installer}.sig`);
  }
  if (missing.length > 0) {
    throw new Error(
      `Release artifact set is incomplete; missing ${missing.join(", ")}. Build and sign both Windows arches first.`,
    );
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  const descriptor = fs.openSync(filePath, "r");
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function gpgSign(filePath) {
  if (!GPG_KEY_ID) {
    throw new Error("GPG_KEY_ID is required to sign release artifacts.");
  }
  const args = [
    "--batch",
    "--yes",
    "--armor",
    "--detach-sign",
    "--local-user",
    GPG_KEY_ID,
    "--output",
    `${filePath}.asc`,
    filePath,
  ];
  const options = { cwd: root, stdio: "inherit" };
  if (GPG_PASSPHRASE) {
    args.unshift("--pinentry-mode", "loopback", "--passphrase", GPG_PASSPHRASE);
  }
  console.log(`[gpg-sign] Signing ${path.relative(root, filePath)}`);
  const result = spawnSync("gpg", args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gpg exited with ${result.status} for ${filePath}`);
  }
}

function stageReleaseFiles(artifacts) {
  fs.mkdirSync(releaseDir, { recursive: true });
  const staged = [];
  for (const artifact of artifacts) {
    const destination = path.join(releaseDir, path.basename(artifact));
    fs.copyFileSync(artifact, destination);
    staged.push(destination);
  }
  for (const name of REQUIRED_MANIFEST_NAMES) {
    const manifest = path.join(releaseDir, name);
    if (!fs.existsSync(manifest)) {
      throw new Error(
        `Missing generated updater manifest ${name}; run npm run release:updater-manifests after both architecture builds.`,
      );
    }
    staged.push(manifest);
  }
  return [...new Set(staged)].sort();
}

function verifyStagedUpdaterSignatures(files) {
  const byName = new Map();
  const signatureByBaseName = new Map();
  for (const filePath of files) {
    const name = path.basename(filePath);
    // The staging directory also contains manifests and checksum files. The
    // cryptographic verifier receives only updater installers; its fail-closed
    // resolver intentionally rejects unrelated files.
    if (resolveUpdaterTargets(name).length > 0) byName.set(name, filePath);
    if (name.endsWith(".sig")) {
      signatureByBaseName.set(name.slice(0, -4), filePath);
    }
  }
  return verifyUpdaterSignatures({
    root,
    releaseDir,
    byName,
    signatureByBaseName,
    resolveUpdaterTargets,
  });
}

function makeChecksums(files) {
  const sumsPath = path.join(releaseDir, "SHA256SUMS");
  const lines = files
    .map((filePath) => `${sha256File(filePath)}  ${path.basename(filePath)}`)
    .sort();
  fs.writeFileSync(sumsPath, `${lines.join("\n")}\n`, "utf8");
  return sumsPath;
}

export function normalizeUpdaterSignature(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (trimmed.includes("untrusted comment:")) {
    return Buffer.from(trimmed, "utf8").toString("base64");
  }
  return trimmed;
}

function validateBetaManifestFiles(
  filePaths,
  { signatureDir = null, version = VERSION } = {},
) {
  const names = filePaths.map((filePath) => path.basename(filePath));
  const expected = [...REQUIRED_BETA_MANIFEST_NAMES].sort();
  const actual = [...new Set(names)].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Beta updater manifest set is incomplete; expected ${expected.join(", ")}, found ${actual.join(", ")}.`,
    );
  }
  for (const filePath of filePaths) {
    const name = path.basename(filePath);
    const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const errors = validateUpdaterManifest(manifest, name);
    if (errors.length > 0) {
      throw new Error(`${name} is invalid:\n${errors.join("\n")}`);
    }
    if (manifest.version !== version) {
      throw new Error(
        `${name} reports version ${manifest.version}, expected ${version}.`,
      );
    }
    for (const [target, entry] of Object.entries(manifest.platforms || {})) {
      const parsedUrl = new URL(entry.url);
      const expectedPrefix = `/${REPO_OWNER}/${REPO_NAME}/releases/download/${TAG_NAME}/`;
      if (
        parsedUrl.protocol !== "https:" ||
        parsedUrl.hostname.toLowerCase() !== "github.com" ||
        parsedUrl.port !== "" ||
        !parsedUrl.pathname
          .toLowerCase()
          .startsWith(expectedPrefix.toLowerCase())
      ) {
        throw new Error(`${name} points outside release ${TAG_NAME}.`);
      }
      const artifactName = decodeURIComponent(
        parsedUrl.pathname.split("/").at(-1) || "",
      );
      assertUpdaterTargetArtifact(target, manifest.version, artifactName, name);
      if (!hasMinisignEnvelope(String(entry.signature || "").trim())) {
        throw new Error(
          `${name} has an invalid updater signature for ${target}.`,
        );
      }
      if (signatureDir) {
        const sidecarPath = path.join(signatureDir, `${artifactName}.sig`);
        if (!fs.existsSync(sidecarPath)) {
          throw new Error(`${name} references missing ${artifactName}.sig.`);
        }
        if (
          normalizeUpdaterSignature(fs.readFileSync(sidecarPath, "utf8")) !==
          String(entry.signature).trim()
        ) {
          throw new Error(
            `${name} signature does not match ${artifactName}.sig.`,
          );
        }
      }
    }
  }
}

const RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;

export function parseReleaseVersion(version) {
  const match = String(version || "").match(RELEASE_VERSION_PATTERN);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    beta: match[4] === undefined ? null : Number(match[4]),
  };
}

export function compareReleaseVersions(left, right) {
  const leftParsed = parseReleaseVersion(left);
  const rightParsed = parseReleaseVersion(right);
  if (!leftParsed || !rightParsed) {
    throw new Error(
      `Cannot compare malformed release versions ${left} and ${right}.`,
    );
  }
  for (const component of ["major", "minor", "patch"]) {
    if (leftParsed[component] !== rightParsed[component]) {
      return leftParsed[component] < rightParsed[component] ? -1 : 1;
    }
  }
  if (leftParsed.beta === null || rightParsed.beta === null) {
    if (leftParsed.beta === rightParsed.beta) return 0;
    return leftParsed.beta === null ? 1 : -1;
  }
  if (leftParsed.beta === rightParsed.beta) return 0;
  return leftParsed.beta < rightParsed.beta ? -1 : 1;
}

export function validateLiveBetaManifestVersions(manifestBodies) {
  const entries =
    manifestBodies instanceof Map
      ? [...manifestBodies.entries()]
      : Object.entries(manifestBodies || {});
  const expected = [...REQUIRED_BETA_MANIFEST_NAMES].sort();
  const names = entries.map(([name]) => String(name));
  const duplicates = names.filter(
    (name, index) => names.indexOf(name) !== index,
  );
  const unknown = names.filter((name) => !expected.includes(name));
  const missing = expected.filter((name) => !names.includes(name));
  if (duplicates.length > 0 || unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `Live beta manifest set is invalid; expected exactly ${expected.join(", ")}, found ${names.sort().join(", ")}.`,
    );
  }

  const versions = [];
  for (const name of expected) {
    const body = entries.find(([entryName]) => entryName === name)?.[1];
    let manifest;
    try {
      manifest = typeof body === "string" ? JSON.parse(body) : body;
    } catch (error) {
      throw new Error(
        `${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const errors = validateUpdaterManifest(manifest, name);
    if (errors.length > 0) {
      throw new Error(`${name} is invalid:\n${errors.join("\n")}`);
    }
    if (!parseReleaseVersion(manifest.version)) {
      throw new Error(
        `${name} has malformed release version ${manifest.version}.`,
      );
    }
    for (const [target, entry] of Object.entries(manifest.platforms || {})) {
      const parsedUrl = new URL(entry.url);
      const expectedPrefix = `/${REPO_OWNER}/${REPO_NAME}/releases/download/v${manifest.version}/`;
      if (
        parsedUrl.protocol !== "https:" ||
        parsedUrl.hostname.toLowerCase() !== "github.com" ||
        parsedUrl.port !== "" ||
        parsedUrl.username ||
        parsedUrl.password ||
        parsedUrl.hash ||
        !parsedUrl.pathname
          .toLowerCase()
          .startsWith(expectedPrefix.toLowerCase())
      ) {
        throw new Error(
          `${name} platform ${target} points outside release v${manifest.version}.`,
        );
      }
    }
    versions.push(manifest.version);
  }
  if (new Set(versions).size !== 1) {
    throw new Error(
      `Live beta manifests disagree on version: ${versions.join(", ")}.`,
    );
  }
  return versions;
}

export function assertBetaManifestVersionsMonotonic(
  candidateVersion,
  currentVersions,
) {
  const candidate = parseReleaseVersion(candidateVersion);
  if (!candidate || candidate.beta === null) {
    throw new Error(
      `Candidate ${candidateVersion} is not a valid beta release version.`,
    );
  }
  if (
    !Array.isArray(currentVersions) ||
    currentVersions.length !== REQUIRED_BETA_MANIFEST_NAMES.length
  ) {
    throw new Error(
      `Live beta manifest version set must contain exactly ${REQUIRED_BETA_MANIFEST_NAMES.length} entries.`,
    );
  }
  const parsedCurrent = currentVersions.map(parseReleaseVersion);
  if (parsedCurrent.some((version) => !version)) {
    throw new Error(
      `Live beta manifests contain malformed release version(s): ${currentVersions.join(", ")}.`,
    );
  }
  if (new Set(currentVersions).size !== 1) {
    throw new Error(
      `Live beta manifests disagree on version: ${currentVersions.join(", ")}.`,
    );
  }
  const currentVersion = currentVersions[0];
  if (compareReleaseVersions(candidateVersion, currentVersion) < 0) {
    throw new Error(
      `Candidate beta ${candidateVersion} is older than the live beta ${currentVersion}; refusing to replace the feed.`,
    );
  }
  return true;
}

function uploadAsset(release, filePath) {
  return uploadReleaseAsset(release.upload_url, filePath);
}

async function uploadAssetWithReplace(release, filePath) {
  try {
    return await uploadAsset(release, filePath);
  } catch (error) {
    if (!isGitHubConflict(error) || !release.draft) throw error;
    const name = path.basename(filePath);
    const existing = listReleaseAssets(release.id).find(
      (asset) => asset?.name === name && typeof asset.id === "number",
    );
    if (!existing) throw error;
    await deleteReleaseAsset(existing.id);
    return uploadAsset(release, filePath);
  }
}

async function uploadAll(release, files) {
  for (const filePath of files) {
    await uploadAssetWithReplace(release, filePath);
    console.log(`[gpg-sign] Uploaded ${path.basename(filePath)}`);
  }
}

export async function replaceReleaseAssetsTransactionally(
  release,
  files,
  {
    assertStillHeld,
    listAssets = listReleaseAssets,
    upload = uploadAsset,
    rename = renameReleaseAsset,
    remove = deleteReleaseAsset,
  } = {},
) {
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  if (files.length === 0) return;
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arlet-release-replace-"),
  );
  const token = crypto.randomBytes(8).toString("hex");
  const staged = [];
  const swapped = [];
  let committed = false;
  try {
    const assets = await listAssets(release.id);
    const assertHeld = async () => {
      if (typeof assertStillHeld === "function") await assertStillHeld();
    };
    for (const filePath of files) {
      const name = path.basename(filePath);
      const existing = assets.find((asset) => asset?.name === name);
      const stagedName = `arlet-pending-${token}-${name}`;
      const stagedPath = path.join(temporaryDirectory, stagedName);
      fs.copyFileSync(filePath, stagedPath);
      const uploaded = await upload(release, stagedPath);
      if (!uploaded || typeof uploaded.id !== "number") {
        throw new Error(`GitHub did not identify staged asset ${stagedName}.`);
      }
      staged.push({
        name,
        existing: existing && typeof existing.id === "number" ? existing : null,
        uploaded,
        backupName: `arlet-previous-${token}-${name}`,
        previousRenamed: false,
      });
    }
    await assertHeld();

    for (const item of staged) {
      await assertHeld();
      if (item.existing) {
        await rename(item.existing.id, item.backupName);
        item.previousRenamed = true;
      }
      try {
        await assertHeld();
        await rename(item.uploaded.id, item.name);
      } catch (error) {
        if (item.existing) {
          await rename(item.existing.id, item.name);
          item.previousRenamed = false;
        }
        throw error;
      }
      swapped.push(item);
    }

    // Every live name now points at the staged replacement. This is the
    // transaction commit point: cleanup failures or a lock loss after here
    // must never roll back an already complete feed swap.
    committed = true;
    for (const item of staged) {
      if (!item.existing) continue;
      try {
        await remove(item.existing.id);
      } catch (error) {
        console.warn(
          `Could not remove previous feed asset ${item.backupName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    if (committed) throw error;
    const rollbackErrors = [];
    for (const item of [...swapped].reverse()) {
      try {
        if (item.existing) {
          await rename(
            item.uploaded.id,
            `arlet-rollback-${token}-${item.name}`,
          );
          await rename(item.existing.id, item.name);
          item.previousRenamed = false;
        }
        await remove(item.uploaded.id);
      } catch (rollbackError) {
        rollbackErrors.push(
          `${item.name}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    const swappedIds = new Set(swapped.map((item) => item.uploaded.id));
    for (const item of staged) {
      if (swappedIds.has(item.uploaded.id)) continue;
      try {
        if (item.existing && item.previousRenamed) {
          await rename(item.existing.id, item.name);
          item.previousRenamed = false;
        }
        await remove(item.uploaded.id);
      } catch (cleanupError) {
        rollbackErrors.push(
          `${item.name} staged cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${
        rollbackErrors.length
          ? `; live-feed rollback failed: ${rollbackErrors.join("; ")}`
          : ""
      }`,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function isTransactionalStagingAssetName(name) {
  return /^(?:default\.)?arlet-(?:pending|previous|rollback)-/i.test(
    String(name || ""),
  );
}

async function removeAssetBestEffort(
  asset,
  label,
  remove = deleteReleaseAsset,
) {
  if (!asset || typeof asset.id !== "number") return;
  try {
    await remove(asset.id);
  } catch (error) {
    console.warn(
      `Could not remove ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function findSyncLock(release, listAssets = listReleaseAssets) {
  return (await listAssets(release.id)).find(
    (asset) => asset?.name === BETA_SYNC_LOCK_NAME,
  );
}

async function assertOwnsSyncLock(
  release,
  acquired,
  listAssets = listReleaseAssets,
) {
  if (!acquired || typeof acquired.id !== "number") {
    throw new Error("Beta-manifest synchronization lock was not acquired.");
  }
  const current = await findSyncLock(release, listAssets);
  if (!current || current.id !== acquired.id) {
    throw new Error(
      "Lost the beta-manifest synchronization lock before mutating live feeds.",
    );
  }
}

export async function withBetaManifestSyncLock(
  release,
  operation,
  {
    listAssets = listReleaseAssets,
    upload = uploadAsset,
    remove = deleteReleaseAsset,
    retries = BETA_SYNC_LOCK_RETRIES,
    delayMs = BETA_SYNC_LOCK_DELAY_MS,
  } = {},
) {
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arlet-beta-sync-lock-"),
  );
  const lockPath = path.join(temporaryDirectory, BETA_SYNC_LOCK_NAME);
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      tag: TAG_NAME,
      pid: process.pid,
      token: crypto.randomBytes(16).toString("hex"),
      createdAt: new Date().toISOString(),
    })}\n`,
  );
  let acquired = null;
  try {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        acquired = await upload(release, lockPath);
        break;
      } catch (error) {
        if (!isGitHubConflict(error)) throw error;
        if (attempt === retries) {
          const lock = await findSyncLock(release, listAssets);
          throw new Error(
            `Timed out waiting for another beta-manifest synchronization (existing lock created ${lock?.created_at || "at an unknown time"}). Delete ${BETA_SYNC_LOCK_NAME} only after confirming no release VM is active.`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    if (!acquired) {
      throw new Error(
        "Could not acquire the beta-manifest synchronization lock.",
      );
    }
    const assertOwns = () => assertOwnsSyncLock(release, acquired, listAssets);
    // Never remove the lock while another signer is active: ownership is
    // checked again immediately before cleanup.
    await assertOwns();
    return await operation({
      assertStillHeld: assertOwns,
    });
  } finally {
    if (acquired && typeof acquired.id === "number") {
      const current = await findSyncLock(release, listAssets);
      if (current?.id === acquired.id) {
        await removeAssetBestEffort(
          acquired,
          "beta-manifest synchronization lock",
          remove,
        );
      }
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function cleanupTransactionalStagingAssets(release) {
  let assets;
  try {
    assets = await listReleaseAssets(release.id);
  } catch (error) {
    console.warn(
      `Could not list orphan feed assets after commit: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  for (const asset of assets.filter((item) =>
    isTransactionalStagingAssetName(item?.name),
  )) {
    await removeAssetBestEffort(asset, `orphan feed asset ${asset.name}`);
  }
}

async function loadLiveBetaManifestVersions(release) {
  const assets = await listReleaseAssets(release.id);
  const liveAssets = assets.filter((asset) =>
    REQUIRED_BETA_MANIFEST_NAMES.includes(asset?.name),
  );
  const names = liveAssets.map((asset) => asset.name);
  if (
    liveAssets.length !== REQUIRED_BETA_MANIFEST_NAMES.length ||
    new Set(names).size !== REQUIRED_BETA_MANIFEST_NAMES.length
  ) {
    throw new Error(
      `Latest stable release has an incomplete beta manifest set; expected ${REQUIRED_BETA_MANIFEST_NAMES.join(", ")}, found ${names.sort().join(", ")}.`,
    );
  }
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arlet-live-beta-manifests-"),
  );
  try {
    const bodies = new Map();
    for (const asset of liveAssets) {
      const manifestPath = path.join(temporaryDirectory, asset.name);
      await downloadAssetToFile(asset, manifestPath);
      bodies.set(asset.name, fs.readFileSync(manifestPath, "utf8"));
    }
    return validateLiveBetaManifestVersions(bodies);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function syncBetaManifestsToLatestStable(
  uploadedFiles,
  currentReleaseId,
  { signatureDir = releaseDir } = {},
) {
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  const betaManifests = uploadedFiles.filter((filePath) =>
    REQUIRED_BETA_MANIFEST_NAMES.includes(path.basename(filePath)),
  );
  validateBetaManifestFiles(betaManifests, { signatureDir });

  let latestStable;
  try {
    latestStable = githubApi("GET", releaseApiPath("/releases/latest"));
  } catch (error) {
    throw new Error(
      `Could not load latest stable release for beta manifest sync. Publish a stable release first: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !latestStable?.id ||
    !latestStable?.upload_url ||
    latestStable.draft ||
    latestStable.prerelease
  ) {
    throw new Error(
      "No published stable release is available at /releases/latest; publish a stable release before creating a beta feed.",
    );
  }
  if (latestStable.id === currentReleaseId) {
    throw new Error(
      "The beta release is also /releases/latest; publish a stable release before syncing beta manifests.",
    );
  }

  await withBetaManifestSyncLock(latestStable, async ({ assertStillHeld }) => {
    await assertStillHeld();
    const liveVersions = await loadLiveBetaManifestVersions(latestStable);
    // Re-assert ownership after the downloads. The comparison must happen
    // while this lock is still ours and before any live name is staged/swapped.
    await assertStillHeld();
    assertBetaManifestVersionsMonotonic(VERSION, liveVersions);
    await replaceReleaseAssetsTransactionally(latestStable, betaManifests, {
      assertStillHeld,
    });
    await assertStillHeld();
    await cleanupTransactionalStagingAssets(latestStable);
  });
  for (const filePath of betaManifests) {
    console.log(`[gpg-sign] Synced ${path.basename(filePath)} to /latest`);
  }
}

async function downloadAssetToFile(asset, destination) {
  githubApiToFile(
    "GET",
    releaseApiPath(`/releases/assets/${asset.id}`),
    destination,
  );
}

async function loadPublishedBetaManifests(release) {
  const assets = listReleaseAssets(release.id);
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  const missing = REQUIRED_BETA_MANIFEST_NAMES.filter(
    (name) => !byName.has(name),
  );
  if (missing.length > 0) {
    throw new Error(
      `Published beta release ${TAG_NAME} is missing updater manifest(s): ${missing.join(", ")}.`,
    );
  }
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arlet-beta-manifests-"),
  );
  const files = [];
  const artifactPaths = new Map();
  const signaturePaths = new Map();
  try {
    for (const name of REQUIRED_BETA_MANIFEST_NAMES) {
      const manifestPath = path.join(temporaryDirectory, name);
      await downloadAssetToFile(byName.get(name), manifestPath);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const errors = validateUpdaterManifest(manifest, name);
      if (errors.length > 0) {
        throw new Error(`${name} is invalid:\n${errors.join("\n")}`);
      }
      if (manifest.version !== VERSION) {
        throw new Error(`${name} does not report ${VERSION}.`);
      }
      for (const [target, entry] of Object.entries(manifest.platforms || {})) {
        const parsedUrl = new URL(entry.url);
        const expectedPrefix = `/${REPO_OWNER}/${REPO_NAME}/releases/download/${TAG_NAME}/`;
        if (
          parsedUrl.protocol !== "https:" ||
          parsedUrl.hostname.toLowerCase() !== "github.com" ||
          parsedUrl.port !== "" ||
          !parsedUrl.pathname
            .toLowerCase()
            .startsWith(expectedPrefix.toLowerCase())
        ) {
          throw new Error(`${name} points outside release ${TAG_NAME}.`);
        }
        const artifactName = decodeURIComponent(
          parsedUrl.pathname.split("/").at(-1) || "",
        );
        assertUpdaterTargetArtifact(
          target,
          manifest.version,
          artifactName,
          name,
        );
        if (!byName.has(artifactName)) {
          throw new Error(
            `${name} references missing published artifact ${artifactName}.`,
          );
        }
        const sidecar = byName.get(`${artifactName}.sig`);
        if (!sidecar) {
          throw new Error(`${name} references missing ${artifactName}.sig.`);
        }
        if (!artifactPaths.has(artifactName)) {
          const artifactPath = path.join(temporaryDirectory, artifactName);
          await downloadAssetToFile(byName.get(artifactName), artifactPath);
          if (fs.statSync(artifactPath).size === 0) {
            throw new Error(`Published artifact ${artifactName} is empty.`);
          }
          artifactPaths.set(artifactName, artifactPath);
        }
        const sidecarPath = path.join(
          temporaryDirectory,
          `${artifactName}.sig`,
        );
        if (!signaturePaths.has(artifactName)) {
          await downloadAssetToFile(sidecar, sidecarPath);
          signaturePaths.set(artifactName, sidecarPath);
        }
        if (
          normalizeUpdaterSignature(
            fs.readFileSync(signaturePaths.get(artifactName), "utf8"),
          ) !== String(entry.signature).trim()
        ) {
          throw new Error(
            `${name} signature does not match ${artifactName}.sig.`,
          );
        }
      }
      files.push(manifestPath);
    }
    verifyUpdaterSignatures({
      root,
      releaseDir: temporaryDirectory,
      byName: artifactPaths,
      signatureByBaseName: signaturePaths,
      resolveUpdaterTargets,
    });
    return { files, temporaryDirectory };
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function syncBetaManifestsAfterPublish() {
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  if (!IS_PRERELEASE) {
    throw new Error(
      "release:sync-beta-manifests is only valid for beta versions; stable releases already publish both feed families.",
    );
  }
  assertGitHubCliAuthenticated();
  const release = getReleaseByTag();
  if (!release?.id || release.draft || !release.published_at) {
    throw new Error(
      `Published release ${TAG_NAME} was not found. Publish the beta draft, then retry release:sync-beta-manifests.`,
    );
  }
  if (!release.prerelease) {
    throw new Error(
      `Release ${TAG_NAME} is published as stable; refusing to sync a beta feed from a non-prerelease release.`,
    );
  }
  const commit = currentReleaseCommit();
  assertReleaseTargetsCommit(release, commit);
  const loaded = await loadPublishedBetaManifests(release);
  try {
    await syncBetaManifestsToLatestStable(loaded.files, release.id, {
      signatureDir: null,
    });
  } finally {
    fs.rmSync(loaded.temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  assertGitHubCliAuthenticated();
  const commit = currentReleaseCommit();
  const release = getReleaseByTag();
  if (!release?.draft) {
    throw new Error(`Release ${TAG_NAME} is not a draft; refusing to upload.`);
  }
  assertReleaseTargetsCommit(release, commit);
  if (Boolean(release.prerelease) !== IS_PRERELEASE) {
    throw new Error(
      `Draft ${TAG_NAME} prerelease=${release.prerelease}, expected ${IS_PRERELEASE}; recreate it with npm run release:draft.`,
    );
  }

  const artifacts = findArtifacts();
  if (artifacts.length === 0) {
    throw new Error(
      "No signed Windows artifacts found under src-tauri/target.",
    );
  }
  assertSignedInstallerSet(artifacts);
  const staged = stageReleaseFiles(artifacts);
  console.log("[gpg-sign] Verifying Tauri updater signatures...");
  verifyStagedUpdaterSignatures(staged);
  const checksumPath = makeChecksums(staged);
  staged.push(checksumPath);
  for (const filePath of [...staged]) {
    gpgSign(filePath);
    staged.push(`${filePath}.asc`);
  }
  await uploadAll(release, staged);
  console.log(`[gpg-sign] Done: ${TAG_NAME} uploaded as draft.`);
}

function isDirectExecution() {
  return Boolean(
    process.argv[1] &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url,
  );
}

if (isDirectExecution()) {
  const run = process.argv.includes("--sync-beta-manifests")
    ? syncBetaManifestsAfterPublish
    : main;
  run().catch((error) => {
    console.error(
      `[gpg-sign] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

export {
  BETA_SYNC_LOCK_NAME,
  IS_PRERELEASE,
  REQUIRED_BETA_MANIFEST_NAMES,
  assertSignedInstallerSet,
  currentReleaseCommit,
  findArtifacts,
  isExplicitTruthy,
  listReleaseAssets,
  resolveUpdaterTargets,
};
