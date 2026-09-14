#!/usr/bin/env node
// Read-only whole-draft release gate. It verifies the exact release identity,
// the stable+beta Windows manifest matrix, every referenced installer and
// Tauri updater sidecar, and the checksum/signature sidecars before publish.
//
// Usage: npm run release:verify:draft
// `--verify-artifacts` additionally downloads referenced installers and checks
// the SHA256SUMS entries. No GitHub state is mutated.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REQUIRED_BETA_MANIFEST_NAMES,
  REQUIRED_MANIFEST_NAMES,
  REQUIRED_STABLE_MANIFEST_NAMES,
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
} = require("./github-cli.cjs");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const VERSION = String(packageJson.version || "").trim();
const TAG_NAME = `v${VERSION}`;
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "Arlet";
const REPO = `${REPO_OWNER}/${REPO_NAME}`;

function isPrereleaseVersion(version) {
  return /^\d+\.\d+\.\d+-beta\.\d+$/.test(String(version || ""));
}

function isExplicitTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

export function requiredDraftStableManifestNames() {
  return [...REQUIRED_STABLE_MANIFEST_NAMES];
}

export function requiredDraftBetaManifestNames() {
  return [...REQUIRED_BETA_MANIFEST_NAMES];
}

export function requiredDraftManifestNames() {
  return [...REQUIRED_MANIFEST_NAMES].sort();
}

export function requiredDraftInstallerNames(
  assetNames = [],
  version = VERSION,
) {
  const escapedVersion = String(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...new Set(
      assetNames.filter((name) =>
        new RegExp(
          `^Arlet_${escapedVersion}_(?:x64|arm64)-setup\\.exe$`,
          "i",
        ).test(String(name)),
      ),
    ),
  ].sort();
}

export function requiredDraftSidecarNames(installers) {
  return installers.flatMap((name) => [`${name}.sig`, `${name}.asc`]);
}

export function isSafeArtifactName(name) {
  return Boolean(
    name &&
    name === path.posix.basename(name) &&
    name === path.win32.basename(name) &&
    !path.posix.isAbsolute(name) &&
    !path.win32.isAbsolute(name) &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes(":") &&
    name !== "." &&
    name !== "..",
  );
}

function normalizeUpdaterSignature(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.includes("untrusted comment:")
    ? Buffer.from(trimmed, "utf8").toString("base64")
    : trimmed;
}

export function assertManifestAssetReferences(
  manifest,
  manifestName,
  assetNames,
  {
    repoOwner = REPO_OWNER,
    repoName = REPO_NAME,
    tag = TAG_NAME,
    signatures = new Map(),
  } = {},
) {
  const present = new Set(assetNames);
  const platforms = manifest?.platforms;
  if (
    !platforms ||
    typeof platforms !== "object" ||
    Array.isArray(platforms) ||
    Object.keys(platforms).length === 0
  ) {
    throw new Error(`${manifestName} has no platform entries.`);
  }
  for (const [target, entry] of Object.entries(platforms)) {
    if (!entry || typeof entry.url !== "string") {
      throw new Error(
        `${manifestName} platform ${target} has no download URL.`,
      );
    }
    if (!hasMinisignEnvelope(String(entry.signature || "").trim())) {
      throw new Error(
        `${manifestName} platform ${target} has an invalid updater signature.`,
      );
    }
    let url;
    try {
      url = new URL(entry.url);
    } catch {
      throw new Error(`${manifestName} platform ${target} has an invalid URL.`);
    }
    const expectedPrefix = `/${repoOwner}/${repoName}/releases/download/${tag}/`;
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.toLowerCase().startsWith(expectedPrefix.toLowerCase())
    ) {
      throw new Error(
        `${manifestName} platform ${target} points outside ${tag}.`,
      );
    }
    const artifactName = decodeURIComponent(
      url.pathname.split("/").at(-1) || "",
    );
    if (!isSafeArtifactName(artifactName)) {
      throw new Error(
        `${manifestName} platform ${target} has an unsafe artifact name.`,
      );
    }
    if (!present.has(artifactName)) {
      throw new Error(
        `${manifestName} references missing artifact ${artifactName}.`,
      );
    }
    const sidecarName = `${artifactName}.sig`;
    if (!present.has(sidecarName)) {
      throw new Error(
        `${manifestName} references missing updater sidecar ${sidecarName}.`,
      );
    }
    if (signatures.has(artifactName)) {
      const expected = normalizeUpdaterSignature(signatures.get(artifactName));
      if (expected !== String(entry.signature).trim()) {
        throw new Error(
          `${manifestName} signature does not match ${sidecarName}.`,
        );
      }
    }
  }
  return true;
}

export function assertDraftReleaseShape({
  release,
  assetNames,
  version = VERSION,
  headCommit = null,
}) {
  const tag = `v${version}`;
  if (!release?.draft) {
    throw new Error(`Release ${tag} must still be a draft for verification.`);
  }
  if (
    release.tag_name !== tag &&
    !/^untagged-[0-9a-f]{20}$/i.test(String(release.tag_name || ""))
  ) {
    throw new Error(
      `Release ${tag} has unexpected tag ${release.tag_name || "unknown"}.`,
    );
  }
  if (Boolean(release.prerelease) !== isPrereleaseVersion(version)) {
    throw new Error(
      `Release ${tag} prerelease=${release.prerelease} does not match version ${version}.`,
    );
  }
  if (
    headCommit &&
    release.target_commitish !== headCommit &&
    !isExplicitTruthy(process.env.FORCE_UPLOAD)
  ) {
    throw new Error(
      `Release ${tag} targets ${release.target_commitish || "an unknown commit"}, not HEAD ${headCommit}.`,
    );
  }
  const present = new Set(assetNames);
  const missingManifests = requiredDraftManifestNames().filter(
    (name) => !present.has(name),
  );
  if (missingManifests.length > 0) {
    throw new Error(
      `Draft ${tag} is missing updater manifests: ${missingManifests.join(", ")}.`,
    );
  }
  const installers = requiredDraftInstallerNames(assetNames, version);
  const arches = new Set(
    installers.map((name) => (/_arm64-/i.test(name) ? "arm64" : "x64")),
  );
  if (!arches.has("x64") || !arches.has("arm64")) {
    throw new Error(
      `Draft ${tag} must contain both x64 and arm64 NSIS installers.`,
    );
  }
  const missingSidecars = requiredDraftSidecarNames(installers).filter(
    (name) => !present.has(name),
  );
  if (missingSidecars.length > 0) {
    throw new Error(
      `Draft ${tag} is missing installer sidecars: ${missingSidecars.join(", ")}.`,
    );
  }
  const missingManifestSignatures = requiredDraftManifestNames()
    .map((name) => `${name}.asc`)
    .filter((name) => !present.has(name));
  if (missingManifestSignatures.length > 0) {
    throw new Error(
      `Draft ${tag} is missing manifest signatures: ${missingManifestSignatures.join(", ")}.`,
    );
  }
  for (const name of ["SHA256SUMS", "SHA256SUMS.asc"]) {
    if (!present.has(name)) {
      throw new Error(`Draft ${tag} is missing required asset ${name}.`);
    }
  }
  return { installers, manifests: requiredDraftManifestNames() };
}

function currentReleaseCommit() {
  const { execFileSync } = require("node:child_process");
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function listReleaseAssets(releaseId) {
  const assets = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = githubApi(
      "GET",
      `/repos/${REPO}/releases/${releaseId}/assets?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    assets.push(...batch);
    if (batch.length < 100) break;
  }
  return assets;
}

function getDraftRelease() {
  try {
    return githubApi(
      "GET",
      `/repos/${REPO}/releases/tags/${encodeURIComponent(TAG_NAME)}`,
    );
  } catch (error) {
    if (error?.statusCode !== 404) throw error;
    for (let page = 1; page <= 20; page += 1) {
      const releases = githubApi(
        "GET",
        `/repos/${REPO}/releases?per_page=100&page=${page}`,
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

function downloadAsset(asset, destination) {
  fs.writeFileSync(
    destination,
    githubApiBuffer("GET", `/repos/${REPO}/releases/assets/${asset.id}`),
  );
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function verifyChecksums(sumText, downloaded) {
  for (const line of String(sumText).split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/i);
    if (!match || !isSafeArtifactName(match[2])) {
      throw new Error(`Invalid SHA256SUMS line: ${line}`);
    }
    const file = downloaded.get(match[2]);
    if (!file) continue;
    if (sha256File(file).toLowerCase() !== match[1].toLowerCase()) {
      throw new Error(`SHA256SUMS mismatch for ${match[2]}.`);
    }
  }
}

async function verifyDraft({ verifyArtifacts = false } = {}) {
  assertGitHubCliAuthenticated();
  const release = getDraftRelease();
  const assets = listReleaseAssets(release.id);
  const assetNames = assets.map((asset) => asset.name);
  const headCommit = currentReleaseCommit();
  const shape = assertDraftReleaseShape({
    release,
    assetNames,
    version: VERSION,
    headCommit,
  });
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arlet-draft-"),
  );
  try {
    const signatures = new Map();
    for (const installer of shape.installers) {
      const sidecarPath = path.join(temporaryDirectory, `${installer}.sig`);
      downloadAsset(byName.get(`${installer}.sig`), sidecarPath);
      const signature = fs.readFileSync(sidecarPath, "utf8").trim();
      if (!hasMinisignEnvelope(normalizeUpdaterSignature(signature))) {
        throw new Error(`Invalid updater signature sidecar ${installer}.sig.`);
      }
      signatures.set(installer, signature);
    }
    for (const manifestName of shape.manifests) {
      const manifestPath = path.join(temporaryDirectory, manifestName);
      downloadAsset(byName.get(manifestName), manifestPath);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const errors = validateUpdaterManifest(manifest, manifestName);
      if (errors.length > 0) {
        throw new Error(`${manifestName} is invalid:\n${errors.join("\n")}`);
      }
      if (manifest.version !== VERSION) {
        throw new Error(
          `${manifestName} reports ${manifest.version}, expected ${VERSION}.`,
        );
      }
      assertManifestAssetReferences(manifest, manifestName, assetNames, {
        tag: TAG_NAME,
        signatures,
      });
    }
    const downloaded = new Map();
    if (verifyArtifacts) {
      const files = [
        ...shape.installers,
        ...shape.installers.map((name) => `${name}.sig`),
        ...shape.manifests,
        "SHA256SUMS",
      ];
      for (const name of files) {
        const destination = path.join(temporaryDirectory, name);
        if (name === "SHA256SUMS") {
          downloadAsset(byName.get(name), destination);
        } else if (name.endsWith(".json")) {
          // Already downloaded manifest path; reuse it.
          downloaded.set(name, path.join(temporaryDirectory, name));
          continue;
        } else {
          downloadAsset(byName.get(name), destination);
        }
        downloaded.set(name, destination);
      }
      verifyChecksums(
        fs.readFileSync(path.join(temporaryDirectory, "SHA256SUMS"), "utf8"),
        downloaded,
      );
      for (const installer of shape.installers) {
        if (fs.statSync(path.join(temporaryDirectory, installer)).size === 0) {
          throw new Error(`Downloaded installer ${installer} is empty.`);
        }
      }
    }
    console.log(
      `[verify-release-draft] OK: ${TAG_NAME} (${shape.installers.length} installers, ${shape.manifests.length} updater manifests).`,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function isDirectExecution() {
  return Boolean(
    process.argv[1] &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url,
  );
}

if (isDirectExecution()) {
  verifyDraft({
    verifyArtifacts: process.argv.includes("--verify-artifacts"),
  }).catch((error) => {
    console.error(
      `[verify-release-draft] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
