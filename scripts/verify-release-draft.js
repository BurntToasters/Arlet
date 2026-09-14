#!/usr/bin/env node
// Read-only whole-draft release gate. It verifies the exact release identity,
// the stable+beta Windows manifest matrix, every referenced installer and
// Tauri updater sidecar, and the checksum/signature sidecars before publish.
//
// Usage: npm run release:verify:draft
// `--verify-artifacts` additionally downloads referenced installers, checks
// SHA256SUMS + SHA256SUMS.asc, and verifies Tauri signatures cryptographically.
// No GitHub state is mutated.

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
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
  assertUpdaterTargetArtifact,
  hasMinisignEnvelope,
  validateUpdaterManifest,
} from "./validate-updater-manifest.js";
import { resolveUpdaterTargets } from "./gpg-sign.js";
import { verifyUpdaterSignatures } from "./updater-signature-verifier.js";
import { assertStableReleaseOverridesAllowed } from "./release-policy.cjs";

const require = createRequire(import.meta.url);
const {
  assertGitHubCliAuthenticated,
  githubApi,
  githubApiToFile,
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
const HASH_BUFFER_BYTES = 1024 * 1024;

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

export function requiredDraftChecksumNames(installers, manifests) {
  return [...installers.flatMap((name) => [name, `${name}.sig`]), ...manifests];
}

export function draftVerificationDownloadNames(shape) {
  return [
    ...new Set([
      ...shape.installers,
      ...shape.installers.map((name) => `${name}.sig`),
      ...shape.manifests,
      "SHA256SUMS",
      "SHA256SUMS.asc",
    ]),
  ];
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
      url.port !== "" ||
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
    assertUpdaterTargetArtifact(
      target,
      manifest.version,
      artifactName,
      manifestName,
    );
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
  if (!Array.isArray(assetNames)) {
    throw new Error(`Release ${tag} asset names must be an array.`);
  }
  if (new Set(assetNames).size !== assetNames.length) {
    throw new Error(`Release ${tag} contains duplicate asset names.`);
  }
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
  const missingUpdaterSidecarSignatures = installers
    .map((name) => `${name}.sig.asc`)
    .filter((name) => !present.has(name));
  if (missingUpdaterSidecarSignatures.length > 0) {
    throw new Error(
      `Draft ${tag} is missing GPG signatures for updater sidecars: ${missingUpdaterSidecarSignatures.join(", ")}.`,
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
  const expectedAssetNames = new Set([
    ...installers,
    ...requiredDraftSidecarNames(installers),
    ...installers.map((name) => `${name}.sig.asc`),
    ...requiredDraftManifestNames(),
    ...requiredDraftManifestNames().map((name) => `${name}.asc`),
    "SHA256SUMS",
    "SHA256SUMS.asc",
  ]);
  const unknownAssets = assetNames.filter(
    (name) => !expectedAssetNames.has(name),
  );
  if (unknownAssets.length > 0) {
    throw new Error(
      `Draft ${tag} contains unknown release asset(s): ${unknownAssets.join(", ")}.`,
    );
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
  githubApiToFile(
    "GET",
    `/repos/${REPO}/releases/assets/${asset.id}`,
    destination,
  );
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

export function verifyChecksums(sumText, downloaded, expectedNames = []) {
  if (!(downloaded instanceof Map)) {
    throw new Error("Checksum verification requires a downloaded-file map.");
  }
  const expected = expectedNames.length
    ? [...expectedNames]
    : [...downloaded.keys()];
  if (new Set(expected).size !== expected.length) {
    throw new Error(
      "Checksum verification received duplicate intended artifacts.",
    );
  }
  if (expected.length === 0) {
    throw new Error(
      "SHA256SUMS is empty; no intended artifacts were provided.",
    );
  }
  const lines = String(sumText).split(/\r?\n/);
  // A single final newline is the conventional checksum-file terminator;
  // additional blank records are malformed and must not be discarded.
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) {
    throw new Error("SHA256SUMS is empty.");
  }
  const expectedSet = new Set(expected);
  const seen = new Set();
  for (const line of lines) {
    if (!line.trim()) {
      throw new Error("SHA256SUMS contains an empty entry.");
    }
    const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/i);
    if (!match || !isSafeArtifactName(match[2])) {
      throw new Error(`Invalid SHA256SUMS line: ${line}`);
    }
    const name = match[2];
    if (seen.has(name)) {
      throw new Error(`SHA256SUMS contains duplicate entry for ${name}.`);
    }
    seen.add(name);
    if (!expectedSet.has(name)) {
      throw new Error(`SHA256SUMS contains unknown artifact ${name}.`);
    }
    const file = downloaded.get(name);
    if (!file) {
      throw new Error(`SHA256SUMS entry ${name} was not downloaded.`);
    }
    if (sha256File(file).toLowerCase() !== match[1].toLowerCase()) {
      throw new Error(`SHA256SUMS mismatch for ${name}.`);
    }
  }
  const missing = expected.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new Error(
      `SHA256SUMS is missing artifact entr${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}.`,
    );
  }
  return true;
}

export function verifyDetachedGpgSignature(
  signaturePath,
  dataPath,
  { rootDir = root, runner = spawnSync } = {},
) {
  const result = runner(
    "gpg",
    ["--batch", "--no-auto-key-retrieve", "--verify", signaturePath, dataPath],
    {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    const detail = [result?.stderr, result?.stdout]
      .filter(Boolean)
      .map(String)
      .join("\n")
      .trim();
    throw new Error(
      `SHA256SUMS.asc GPG signature verification failed${detail ? `: ${detail}` : "."}`,
    );
  }
  return true;
}

async function verifyDraft({ verifyArtifacts = false } = {}) {
  assertStableReleaseOverridesAllowed(process.env, VERSION);
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
    const downloaded = new Map();
    for (const installer of shape.installers) {
      const sidecarPath = path.join(temporaryDirectory, `${installer}.sig`);
      downloadAsset(byName.get(`${installer}.sig`), sidecarPath);
      const signature = fs.readFileSync(sidecarPath, "utf8").trim();
      if (!hasMinisignEnvelope(normalizeUpdaterSignature(signature))) {
        throw new Error(`Invalid updater signature sidecar ${installer}.sig.`);
      }
      signatures.set(installer, signature);
      downloaded.set(`${installer}.sig`, sidecarPath);
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
    if (verifyArtifacts) {
      const files = draftVerificationDownloadNames(shape);
      for (const name of files) {
        const destination = path.join(temporaryDirectory, name);
        if (name === "SHA256SUMS") {
          downloadAsset(byName.get(name), destination);
        } else if (name.endsWith(".json")) {
          // Already downloaded manifest path; reuse it.
          downloaded.set(name, path.join(temporaryDirectory, name));
          continue;
        } else if (downloaded.has(name)) {
          // Installer updater sidecars were downloaded during the shape pass;
          // githubApiToFile intentionally refuses to overwrite them.
          continue;
        } else {
          downloadAsset(byName.get(name), destination);
        }
        downloaded.set(name, destination);
      }
      verifyChecksums(
        fs.readFileSync(path.join(temporaryDirectory, "SHA256SUMS"), "utf8"),
        downloaded,
        requiredDraftChecksumNames(shape.installers, shape.manifests),
      );
      verifyDetachedGpgSignature(
        path.join(temporaryDirectory, "SHA256SUMS.asc"),
        path.join(temporaryDirectory, "SHA256SUMS"),
      );
      const byName = new Map(
        shape.installers.map((name) => [
          name,
          path.join(temporaryDirectory, name),
        ]),
      );
      const signatureByBaseName = new Map(
        shape.installers.map((name) => [
          name,
          path.join(temporaryDirectory, `${name}.sig`),
        ]),
      );
      verifyUpdaterSignatures({
        root,
        releaseDir: temporaryDirectory,
        byName,
        signatureByBaseName,
        resolveUpdaterTargets,
      });
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
