#!/usr/bin/env node
// Arlet release signer and updater-feed publisher. The release shape follows
// Zinnia's Windows channel workflow, with Arlet's NSIS-only artifact set.
//
// Normal mode stages/signs the two Windows installers, their Tauri updater
// sidecars, the stable+beta manifests, and checksums, then uploads them to
// the exact-version draft. Beta mode also synchronizes only beta manifests to
// GitHub's latest stable release. `--sync-beta-manifests` is the recovery
// path for a beta that was published after its upload VM lost connectivity.

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
  hasMinisignEnvelope,
  validateUpdaterManifest,
} from "./validate-updater-manifest.js";

const require = createRequire(import.meta.url);
const {
  assertGitHubCliAuthenticated,
  githubApi,
  githubApiBuffer,
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
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
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

function validateBetaManifestFiles(filePaths, { signatureDir = null } = {}) {
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
    if (manifest.version !== VERSION) {
      throw new Error(
        `${name} reports version ${manifest.version}, expected ${VERSION}.`,
      );
    }
    for (const [target, entry] of Object.entries(manifest.platforms || {})) {
      const parsedUrl = new URL(entry.url);
      const expectedPrefix = `/${REPO_OWNER}/${REPO_NAME}/releases/download/${TAG_NAME}/`;
      if (
        parsedUrl.protocol !== "https:" ||
        parsedUrl.hostname.toLowerCase() !== "github.com" ||
        !parsedUrl.pathname
          .toLowerCase()
          .startsWith(expectedPrefix.toLowerCase())
      ) {
        throw new Error(`${name} points outside release ${TAG_NAME}.`);
      }
      const artifactName = decodeURIComponent(
        parsedUrl.pathname.split("/").at(-1) || "",
      );
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
  { assertStillHeld } = {},
) {
  if (files.length === 0) return;
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arlet-release-replace-"),
  );
  const token = crypto.randomBytes(8).toString("hex");
  const staged = [];
  const swapped = [];
  try {
    const assets = listReleaseAssets(release.id);
    for (const filePath of files) {
      const name = path.basename(filePath);
      const existing = assets.find((asset) => asset?.name === name);
      const stagedName = `arlet-pending-${token}-${name}`;
      const stagedPath = path.join(temporaryDirectory, stagedName);
      fs.copyFileSync(filePath, stagedPath);
      const uploaded = await uploadAsset(release, stagedPath);
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
    if (typeof assertStillHeld === "function") await assertStillHeld();

    for (const item of staged) {
      if (item.existing) {
        await renameReleaseAsset(item.existing.id, item.backupName);
        item.previousRenamed = true;
      }
      try {
        await renameReleaseAsset(item.uploaded.id, item.name);
      } catch (error) {
        if (item.existing) {
          await renameReleaseAsset(item.existing.id, item.name);
          item.previousRenamed = false;
        }
        throw error;
      }
      swapped.push(item);
    }

    for (const item of staged) {
      if (!item.existing) continue;
      try {
        await deleteReleaseAsset(item.existing.id);
      } catch (error) {
        console.warn(
          `Could not remove previous feed asset ${item.backupName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...swapped].reverse()) {
      try {
        if (item.existing) {
          await renameReleaseAsset(
            item.uploaded.id,
            `arlet-rollback-${token}-${item.name}`,
          );
          await renameReleaseAsset(item.existing.id, item.name);
          item.previousRenamed = false;
        }
        await deleteReleaseAsset(item.uploaded.id);
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
          await renameReleaseAsset(item.existing.id, item.name);
          item.previousRenamed = false;
        }
        await deleteReleaseAsset(item.uploaded.id);
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

async function removeAssetBestEffort(asset, label) {
  if (!asset || typeof asset.id !== "number") return;
  try {
    await deleteReleaseAsset(asset.id);
  } catch (error) {
    console.warn(
      `Could not remove ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function findSyncLock(release) {
  return listReleaseAssets(release.id).find(
    (asset) => asset?.name === BETA_SYNC_LOCK_NAME,
  );
}

async function assertOwnsSyncLock(release, acquired) {
  if (!acquired || typeof acquired.id !== "number") {
    throw new Error("Beta-manifest synchronization lock was not acquired.");
  }
  const current = await findSyncLock(release);
  if (!current || current.id !== acquired.id) {
    throw new Error(
      "Lost the beta-manifest synchronization lock before mutating live feeds.",
    );
  }
}

async function withBetaManifestSyncLock(release, operation) {
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
    for (let attempt = 1; attempt <= BETA_SYNC_LOCK_RETRIES; attempt += 1) {
      try {
        acquired = await uploadAsset(release, lockPath);
        break;
      } catch (error) {
        if (!isGitHubConflict(error)) throw error;
        if (attempt === BETA_SYNC_LOCK_RETRIES) {
          const lock = await findSyncLock(release);
          throw new Error(
            `Timed out waiting for another beta-manifest synchronization (existing lock created ${lock?.created_at || "at an unknown time"}). Delete ${BETA_SYNC_LOCK_NAME} only after confirming no release VM is active.`,
          );
        }
        await new Promise((resolve) =>
          setTimeout(resolve, BETA_SYNC_LOCK_DELAY_MS),
        );
      }
    }
    await assertOwnsSyncLock(release, acquired);
    return await operation({
      assertStillHeld: () => assertOwnsSyncLock(release, acquired),
    });
  } finally {
    if (acquired && typeof acquired.id === "number") {
      const current = await findSyncLock(release);
      if (current?.id === acquired.id) {
        await removeAssetBestEffort(
          acquired,
          "beta-manifest synchronization lock",
        );
      }
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function cleanupTransactionalStagingAssets(release) {
  for (const asset of listReleaseAssets(release.id).filter((item) =>
    isTransactionalStagingAssetName(item?.name),
  )) {
    await removeAssetBestEffort(asset, `orphan feed asset ${asset.name}`);
  }
}

export async function syncBetaManifestsToLatestStable(
  uploadedFiles,
  currentReleaseId,
  { signatureDir = releaseDir } = {},
) {
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
  const bytes = githubApiBuffer(
    "GET",
    releaseApiPath(`/releases/assets/${asset.id}`),
  );
  fs.writeFileSync(destination, bytes);
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
      for (const entry of Object.values(manifest.platforms || {})) {
        const artifactName = decodeURIComponent(
          new URL(entry.url).pathname.split("/").at(-1) || "",
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
        const sidecarPath = path.join(
          temporaryDirectory,
          `${artifactName}.sig`,
        );
        if (!sidecar.localPath) {
          await downloadAssetToFile(sidecar, sidecarPath);
          sidecar.localPath = sidecarPath;
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
      files.push(manifestPath);
    }
    return { files, temporaryDirectory };
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function syncBetaManifestsAfterPublish() {
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
  const checksumPath = makeChecksums(staged);
  staged.push(checksumPath);
  for (const filePath of [...staged]) {
    gpgSign(filePath);
    staged.push(`${filePath}.asc`);
  }
  await uploadAll(release, staged);
  if (IS_PRERELEASE) {
    await syncBetaManifestsToLatestStable(
      staged.filter((filePath) =>
        REQUIRED_BETA_MANIFEST_NAMES.includes(path.basename(filePath)),
      ),
      release.id,
    );
  }
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
};
