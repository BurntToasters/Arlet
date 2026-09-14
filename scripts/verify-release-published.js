#!/usr/bin/env node
// Read-only live updater-feed gate. Stable releases require stable and beta
// manifests at GitHub's /releases/latest alias. Beta releases require the
// beta family only because stable manifests intentionally remain on the last
// stable release. Every live manifest must reference a downloadable artifact
// and a matching Tauri updater signature sidecar.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
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

export function collectManifestArtifactRefs(manifestBodies) {
  const artifacts = new Map();
  for (const body of manifestBodies) {
    const manifest = typeof body === "string" ? JSON.parse(body) : body;
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
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        !parsed.pathname.includes("/releases/download/")
      ) {
        throw new Error(
          `Updater artifact URL for ${target} is outside GitHub releases.`,
        );
      }
      const name = decodeURIComponent(parsed.pathname.split("/").at(-1) || "");
      if (
        !name ||
        name !== path.posix.basename(name) ||
        name !== path.win32.basename(name) ||
        name.includes("/") ||
        name.includes("\\") ||
        name.includes(":")
      ) {
        throw new Error(`Unsafe updater artifact filename for ${target}.`);
      }
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
  const artifacts = collectManifestArtifactRefs(manifestBodies);
  if (artifacts.size === 0)
    throw new Error("No updater artifacts referenced by manifests.");
  for (const [name, record] of artifacts) {
    const artifactResponse = await fetch(record.url, {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "Arlet-release-verifier",
      },
      redirect: "follow",
    });
    if (!artifactResponse.ok)
      throw new Error(`${record.url}: HTTP ${artifactResponse.status}`);
    const artifact = Buffer.from(await artifactResponse.arrayBuffer());
    if (artifact.length === 0)
      throw new Error(`Downloaded updater artifact ${name} is empty.`);
    const signatureUrl = `${record.url}.sig`;
    const signature = await getText(signatureUrl, "text/plain");
    if (normalizeUpdaterSignature(signature) !== record.signature) {
      throw new Error(`Live manifest signature does not match ${name}.sig.`);
    }
    console.log(`[verify-release-published] artifact OK: ${name}`);
  }
}

async function main() {
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
  if (!process.argv.includes("--shape-only")) await verifyLiveArtifacts(bodies);
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
