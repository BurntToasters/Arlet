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
  return (
    lines.length === 4 &&
    lines[0].startsWith("untrusted comment:") &&
    lines[2].startsWith("trusted comment:")
  );
}

export function validateUpdaterManifest(manifest, label = "manifest") {
  const errors = [];
  if (!manifest || typeof manifest !== "object") {
    return [`${label}: root must be an object`];
  }
  if (!/^\d+\.\d+\.\d+(-beta\.\d+)?$/.test(String(manifest.version || ""))) {
    errors.push(`${label}: version must be semver (got ${manifest.version})`);
  }
  if (!isNonEmptyString(manifest.notes)) {
    errors.push(`${label}: notes must be a non-empty string`);
  }
  if (!isNonEmptyString(manifest.pubdate)) {
    errors.push(`${label}: pubdate must be a non-empty date string`);
  } else if (Number.isNaN(Date.parse(manifest.pubdate))) {
    errors.push(`${label}: pubdate is not a valid date`);
  }
  const platforms = manifest.platforms;
  if (!platforms || typeof platforms !== "object") {
    errors.push(`${label}: platforms must be an object`);
    return errors;
  }
  const expected = ["windows-x86_64", "windows-aarch64"];
  for (const key of expected) {
    const entry = platforms[key];
    if (!entry) {
      errors.push(`${label}: platforms is missing ${key}`);
      continue;
    }
    if (!isNonEmptyString(entry.url) || !entry.url.startsWith("https://")) {
      errors.push(`${label}: ${key}.url must be an https URL`);
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
