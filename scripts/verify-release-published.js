#!/usr/bin/env node
// Read-only live updater-feed gate. Stable releases require stable and beta
// manifests at GitHub's /releases/latest alias. Beta releases require the
// beta family only because stable manifests intentionally remain on the last
// stable release. Every live manifest must reference a downloadable artifact
// and matching Tauri updater signature sidecars. Full mode also downloads the
// release checksums, requires complete coverage, verifies SHA256SUMS.asc, and
// cryptographically checks every referenced updater artifact.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REQUIRED_MANIFEST_NAMES } from "./generate-updater-manifests.js";
import {
  isSafeArtifactName,
  verifyChecksums,
  verifyDetachedGpgSignature,
} from "./verify-release-draft.js";
import { resolveUpdaterTargets } from "./gpg-sign.js";
import { verifyUpdaterSignatures } from "./updater-signature-verifier.js";
import { assertStableReleaseOverridesAllowed } from "./release-policy.cjs";
import {
  assertUpdaterTargetArtifact,
  hasMinisignEnvelope,
  validateUpdaterManifest,
} from "./validate-updater-manifest.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const CURRENT_VERSION = String(packageJson.version || "").trim();
const REQUESTED_EXPECTED_VERSION = String(
  process.env.EXPECTED_UPDATER_VERSION || CURRENT_VERSION,
).trim();
const EXPECTED_VERSION =
  REQUESTED_EXPECTED_VERSION === "current"
    ? CURRENT_VERSION
    : REQUESTED_EXPECTED_VERSION;
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "Arlet";
const BASE = (
  process.env.UPDATER_LIVE_BASE_URL ||
  `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download`
).replace(/\/+$/, "");
const IS_BETA = /-beta\.\d+$/.test(EXPECTED_VERSION);
const STABLE_TARGETS = ["windows-x86_64", "windows-aarch64"];
const BETA_TARGETS = [
  "windows-beta-x86_64",
  "windows-beta-x86_64-nsis",
  "windows-beta-aarch64",
  "windows-beta-aarch64-nsis",
];

export function expandEndpoint(
  template,
  version = CURRENT_VERSION,
  target = "windows",
  arch = "x86_64",
) {
  return String(template)
    .replaceAll("{{target}}", target)
    .replaceAll("{{arch}}", arch)
    .replaceAll("{{current_version}}", version);
}

export function requiredLiveTargets(version = EXPECTED_VERSION) {
  return /-beta\.\d+$/.test(String(version))
    ? [...BETA_TARGETS]
    : [...STABLE_TARGETS, ...BETA_TARGETS];
}

function normalizeUpdaterSignature(value) {
  const text = String(value || "").trim();
  return text.includes("untrusted comment:")
    ? Buffer.from(text, "utf8").toString("base64")
    : text;
}

async function getText(url, accept = "application/json") {
  const response = await fetch(url, {
    headers: { Accept: accept, "User-Agent": "Arlet-release-verifier" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.text();
}

async function downloadToFile(
  url,
  destination,
  accept = "application/octet-stream",
) {
  const response = await fetch(url, {
    headers: { Accept: accept, "User-Agent": "Arlet-release-verifier" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  let descriptor;
  let created = false;
  try {
    if (!response.body) throw new Error(`${url}: response has no body`);
    descriptor = fs.openSync(destination, "wx");
    created = true;
    await pipeline(
      Readable.fromWeb(response.body),
      fs.createWriteStream(null, { fd: descriptor, autoClose: true }),
    );
    descriptor = undefined;
    if (fs.statSync(destination).size === 0) {
      throw new Error(`${url}: downloaded file is empty`);
    }
    return destination;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original download error.
      }
    }
    if (created) fs.rmSync(destination, { force: true });
    throw error;
  }
}

export function collectManifestArtifactRefs(manifestBodies) {
  const artifacts = new Map();
  for (const body of manifestBodies) {
    const manifest = typeof body === "string" ? JSON.parse(body) : body;
    const expectedPrefix = `/${REPO_OWNER}/${REPO_NAME}/releases/download/v${manifest?.version}/`;
    const releaseKeys = new Set();
    for (const [target, entry] of Object.entries(manifest.platforms || {})) {
      if (
        !entry ||
        typeof entry.url !== "string" ||
        typeof entry.signature !== "string"
      ) {
        throw new Error(`Invalid updater platform entry for ${target}.`);
      }
      const parsed = new URL(entry.url);
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname.toLowerCase() !== "github.com" ||
        parsed.port !== "" ||
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        !parsed.pathname.toLowerCase().startsWith(expectedPrefix.toLowerCase())
      ) {
        throw new Error(
          `Updater artifact URL for ${target} is outside GitHub releases.`,
        );
      }
      releaseKeys.add(releaseDownloadPrefix(parsed));
      const name = decodeURIComponent(parsed.pathname.split("/").at(-1) || "");
      if (!isSafeArtifactName(name)) {
        throw new Error(`Unsafe updater artifact filename for ${target}.`);
      }
      assertUpdaterTargetArtifact(
        target,
        manifest.version,
        name,
        "live manifest",
      );
      if (!hasMinisignEnvelope(entry.signature.trim())) {
        throw new Error(`Invalid updater signature for ${target}.`);
      }
      const previous = artifacts.get(name);
      if (previous && previous.signature !== entry.signature.trim()) {
        throw new Error(`Conflicting updater signatures for ${name}.`);
      }
      artifacts.set(name, {
        url: entry.url,
        signature: entry.signature.trim(),
      });
    }
    if (releaseKeys.size > 1) {
      throw new Error(
        "A live updater manifest references artifacts from multiple releases.",
      );
    }
  }
  return artifacts;
}

export function assertManifestReleaseUrls(
  manifest,
  manifestName,
  version = manifest?.version,
) {
  const expectedPrefix = `/${REPO_OWNER}/${REPO_NAME}/releases/download/v${version}/`;
  for (const [target, entry] of Object.entries(manifest?.platforms || {})) {
    let parsed;
    try {
      parsed = new URL(entry?.url);
    } catch {
      throw new Error(`${manifestName} has an invalid URL for ${target}.`);
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "github.com" ||
      parsed.port !== "" ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      !parsed.pathname.toLowerCase().startsWith(expectedPrefix.toLowerCase())
    ) {
      throw new Error(
        `${manifestName} URL for ${target} must reference release v${version}.`,
      );
    }
  }
}

function assertLiveManifestVersion(target, manifest) {
  const targetIsBeta = target.includes("-beta-");
  if (!targetIsBeta || IS_BETA) {
    if (manifest.version !== EXPECTED_VERSION) {
      throw new Error(
        `latest-${target}.json reports ${manifest.version}, expected ${EXPECTED_VERSION}.`,
      );
    }
    return;
  }
  // A stable release's beta feed may still point at the stable release or at
  // the newest published beta copied onto /latest. In either case the
  // manifest's own version and release URL are checked below; only the
  // stable-channel feeds must equal this checkout's package version.
  if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(String(manifest.version))) {
    throw new Error(
      `latest-${target}.json has an invalid live release version ${manifest.version}.`,
    );
  }
}

async function verifyLiveArtifacts(manifestBodies) {
  assertStableReleaseOverridesAllowed(process.env, EXPECTED_VERSION);
  const artifacts = collectManifestArtifactRefs(manifestBodies);
  if (artifacts.size === 0)
    throw new Error("No updater artifacts referenced by manifests.");
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arlet-live-verify-"),
  );
  try {
    const byName = new Map();
    const signatureByBaseName = new Map();
    for (const [name, record] of artifacts) {
      const artifactPath = path.join(temporaryDirectory, name);
      await downloadToFile(record.url, artifactPath);
      const signaturePath = `${artifactPath}.sig`;
      const signature = await getText(
        releaseAssetUrlFromRecord(record, `${name}.sig`),
        "text/plain",
      );
      fs.writeFileSync(signaturePath, signature, { flag: "wx" });
      if (normalizeUpdaterSignature(signature) !== record.signature) {
        throw new Error(`Live manifest signature does not match ${name}.sig.`);
      }
      byName.set(name, artifactPath);
      signatureByBaseName.set(name, signaturePath);
      console.log(`[verify-release-published] artifact downloaded: ${name}`);
    }
    verifyUpdaterSignatures({
      root,
      releaseDir: temporaryDirectory,
      byName,
      signatureByBaseName,
      resolveUpdaterTargets,
    });
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function releaseAssetUrlFromRecord(record, name) {
  const url = new URL(record.url);
  const segments = url.pathname.split("/");
  segments[segments.length - 1] = encodeURIComponent(name);
  url.pathname = segments.join("/");
  return url.toString();
}

function releaseDownloadPrefix(url) {
  const parsed = url instanceof URL ? url : new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  return `${parsed.origin}/${segments.slice(0, 5).join("/")}`;
}

export async function verifyPublishedChecksums(manifestBodies) {
  assertStableReleaseOverridesAllowed(process.env, EXPECTED_VERSION);
  const groups = new Map();
  for (const body of manifestBodies) {
    const artifacts = collectManifestArtifactRefs([body]);
    if (artifacts.size === 0) {
      throw new Error("No updater artifacts referenced by a live manifest.");
    }
    const releaseKeys = new Set(
      [...artifacts.values()].map((record) =>
        releaseDownloadPrefix(record.url),
      ),
    );
    if (releaseKeys.size !== 1) {
      throw new Error(
        "A live updater manifest references artifacts from multiple releases.",
      );
    }
    const [releaseKey] = releaseKeys;
    let group = groups.get(releaseKey);
    if (!group) {
      group = {
        representative: artifacts.values().next().value,
        artifacts: new Map(),
      };
      groups.set(releaseKey, group);
    }
    for (const [name, record] of artifacts) {
      const previous = group.artifacts.get(name);
      if (previous && previous.signature !== record.signature) {
        throw new Error(`Conflicting updater signatures for ${name}.`);
      }
      group.artifacts.set(name, record);
    }
  }
  if (groups.size === 0) {
    throw new Error("No updater artifacts referenced by manifests.");
  }

  for (const [releaseKey, group] of groups) {
    const expectedNames = [
      ...group.artifacts.keys(),
      ...[...group.artifacts.keys()].map((name) => `${name}.sig`),
      ...REQUIRED_MANIFEST_NAMES,
    ];
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "arlet-checksum-verify-"),
    );
    try {
      const downloaded = new Map();
      for (const [name, record] of group.artifacts) {
        const artifactPath = path.join(temporaryDirectory, name);
        await downloadToFile(record.url, artifactPath);
        downloaded.set(name, artifactPath);
        const sidecarName = `${name}.sig`;
        const sidecarPath = path.join(temporaryDirectory, sidecarName);
        await downloadToFile(
          releaseAssetUrlFromRecord(record, sidecarName),
          sidecarPath,
          "text/plain",
        );
        downloaded.set(sidecarName, sidecarPath);
      }
      for (const name of REQUIRED_MANIFEST_NAMES) {
        const manifestPath = path.join(temporaryDirectory, name);
        await downloadToFile(
          releaseAssetUrlFromRecord(group.representative, name),
          manifestPath,
          "application/json",
        );
        downloaded.set(name, manifestPath);
      }
      const sumsPath = path.join(temporaryDirectory, "SHA256SUMS");
      const sumsSignaturePath = path.join(temporaryDirectory, "SHA256SUMS.asc");
      await downloadToFile(
        releaseAssetUrlFromRecord(group.representative, "SHA256SUMS"),
        sumsPath,
        "text/plain",
      );
      await downloadToFile(
        releaseAssetUrlFromRecord(group.representative, "SHA256SUMS.asc"),
        sumsSignaturePath,
        "text/plain",
      );
      verifyChecksums(
        fs.readFileSync(sumsPath, "utf8"),
        downloaded,
        expectedNames,
      );
      verifyDetachedGpgSignature(sumsSignaturePath, sumsPath, {
        rootDir: root,
        runner: spawnSync,
      });
      console.log(
        `[verify-release-published] ${releaseKey}: SHA256SUMS and SHA256SUMS.asc verified (${expectedNames.length} entries).`,
      );
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
  return true;
}

async function main() {
  assertStableReleaseOverridesAllowed(process.env, EXPECTED_VERSION);
  const targets = requiredLiveTargets(EXPECTED_VERSION);
  const bodies = [];
  for (const target of targets) {
    const url = `${BASE}/latest-${target}.json`;
    console.log(`[verify-release-published] GET ${url}`);
    const body = await getText(url);
    const manifest = JSON.parse(body);
    const errors = validateUpdaterManifest(manifest, `latest-${target}.json`);
    if (errors.length > 0)
      throw new Error(`Live updater manifest invalid:\n${errors.join("\n")}`);
    assertLiveManifestVersion(target, manifest);
    assertManifestReleaseUrls(
      manifest,
      `latest-${target}.json`,
      manifest.version,
    );
    bodies.push(body);
  }
  if (!process.argv.includes("--shape-only")) {
    await verifyLiveArtifacts(bodies);
    await verifyPublishedChecksums(bodies);
  }
  console.log(
    `[verify-release-published] ${IS_BETA ? "beta" : "stable"} live feed verified (${targets.length} manifests).`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(
      `[verify-release-published] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

export { verifyLiveArtifacts };
