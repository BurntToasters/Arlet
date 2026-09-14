#!/usr/bin/env node
// Arlet updater manifest validator. Arlet-native implementation; workflow
// inspired by Zinnia. Validates Tauri updater JSON shape without trusting
// "upload succeeded" as proof.
//
// Usage:
//   node scripts/validate-updater-manifest.js [path...]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(scriptDir, "..");

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function decodeStrictBase64(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

function hasMinisignEnvelope(value) {
  const outer = decodeStrictBase64(value);
  if (!outer) return false;
  const lines = outer.toString("utf8").trim().split(/\r?\n/);
  if (
    lines.length === 4 &&
    lines[0].startsWith("untrusted comment:") &&
    lines[2].startsWith("trusted comment:")
  ) {
    const signaturePacket = decodeStrictBase64(lines[1]);
    const globalSignature = decodeStrictBase64(lines[3]);
    // Minisign's Ed25519 packet is 74 bytes and its global signature is 64
    // bytes. This catches truncated/accidentally UTF-8 encoded sidecars while
    // leaving cryptographic verification to Tauri's pinned updater key.
    return (
      signaturePacket?.length === 74 &&
      signaturePacket[0] === 0x45 &&
      (signaturePacket[1] === 0x64 || signaturePacket[1] === 0x44) &&
      globalSignature?.length === 64
    );
  }
  return false;
}

function expectedTargetFromLabel(label) {
  const name = path.basename(String(label), ".json");
  const match = name.match(
    /^latest-(windows(?:-beta)?-(?:x86_64|aarch64))(?:-nsis)?$/i,
  );
  return match ? match[1].toLowerCase() : null;
}

function isSafeReleaseUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      url.pathname.includes("/releases/download/")
    );
  } catch {
    return false;
  }
}

export function validateUpdaterManifest(manifest, label = "manifest") {
  const errors = [];
  if (!manifest || typeof manifest !== "object") {
    return [`${label}: root must be an object`];
  }
  if (Object.hasOwn(manifest, "pubdate")) {
    errors.push(`${label}: use "pub_date" (not obsolete "pubdate")`);
  }
  if (!/^\d+\.\d+\.\d+(-beta\.\d+)?$/.test(String(manifest.version || ""))) {
    errors.push(`${label}: version must be semver (got ${manifest.version})`);
  }
  if (!isNonEmptyString(manifest.notes)) {
    errors.push(`${label}: notes must be a non-empty string`);
  }
  if (!isNonEmptyString(manifest.pub_date)) {
    errors.push(`${label}: pub_date must be a non-empty date string`);
  } else if (
    Number.isNaN(Date.parse(manifest.pub_date)) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
      manifest.pub_date,
    )
  ) {
    errors.push(
      `${label}: pub_date must be a normalized ISO-8601 UTC timestamp`,
    );
  }
  const platforms = manifest.platforms;
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
    errors.push(`${label}: platforms must be an object`);
    return errors;
  }
  if (Object.keys(platforms).length === 0) {
    errors.push(`${label}: platforms must not be empty`);
  }
  const expectedTarget = expectedTargetFromLabel(label);
  const isNsisManifest = String(label).toLowerCase().endsWith("-nsis.json");
  const expectedPlatformKeys = expectedTarget
    ? new Set([
        isNsisManifest ? `${expectedTarget}-nsis` : expectedTarget,
        ...(isNsisManifest ? [] : [`${expectedTarget}-nsis`]),
      ])
    : null;
  if (
    expectedPlatformKeys &&
    Object.keys(platforms).length !== expectedPlatformKeys.size
  ) {
    errors.push(
      `${label}: expected exactly ${[...expectedPlatformKeys].join(", ")} platform target(s)`,
    );
  }
  for (const [key, entry] of Object.entries(platforms)) {
    if (expectedPlatformKeys && !expectedPlatformKeys.has(key.toLowerCase())) {
      errors.push(`${label}: unexpected platform target ${key}`);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label}: platforms.${key} must be an object`);
      continue;
    }
    if (!isNonEmptyString(entry.url) || !entry.url.startsWith("https://")) {
      errors.push(`${label}: ${key}.url must be an https URL`);
    }
    if (!isSafeReleaseUrl(entry.url)) {
      errors.push(`${label}: ${key}.url must point to a GitHub release asset`);
    }
    if (
      !isNonEmptyString(entry.signature) ||
      !hasMinisignEnvelope(entry.signature)
    ) {
      errors.push(`${label}: ${key}.signature must be a minisign envelope`);
    }
  }
  return errors;
}

function main(paths) {
  if (paths.length === 0) {
    console.log(
      "[validate-updater-manifest] No paths given; nothing to validate.",
    );
    return;
  }
  let failed = false;
  for (const p of paths) {
    const full = path.resolve(root, p);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (error) {
      console.error(
        `[validate-updater-manifest] ${p}: unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
      failed = true;
      continue;
    }
    const errors = validateUpdaterManifest(manifest, p);
    if (errors.length > 0) {
      for (const e of errors) console.error(`[validate-updater-manifest] ${e}`);
      failed = true;
    } else {
      console.log(`[validate-updater-manifest] OK: ${p}`);
    }
  }
  if (failed) process.exit(1);
}

const isDirect =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirect) {
  main(process.argv.slice(2));
}

export { hasMinisignEnvelope, isSafeReleaseUrl, expectedTargetFromLabel };
