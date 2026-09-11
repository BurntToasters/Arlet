#!/usr/bin/env node
// Arlet draft verifier (read-only). Arlet-native implementation; workflow
// inspired by Zinnia. Checks the version draft has the expected Windows
// assets and that updater manifests are well-formed.
//
// Usage: npm run release:verify:draft

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateUpdaterManifest } from "./validate-updater-manifest.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const VERSION = packageJson.version;
const TAG_NAME = `v${VERSION}`;
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "Arlet";
const REPO = `${REPO_OWNER}/${REPO_NAME}`;

function ghJson(args) {
  const out = execFileSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return JSON.parse(out);
}

function main() {
  const release = ghJson([
    "release",
    "view",
    TAG_NAME,
    "--repo",
    REPO,
    "--json",
    "tagName,isDraft,assets",
  ]);
  if (!release.isDraft) {
    throw new Error(`${TAG_NAME} is not a draft; refusing draft verification.`);
  }
  const names = (release.assets || []).map((a) => a.name);
  const required = ["SHA256SUMS", "SHA256SUMS.asc"];
  for (const name of required) {
    if (!names.some((n) => n === name)) {
      throw new Error(`Draft ${TAG_NAME} is missing required asset: ${name}`);
    }
  }
  const exes = names.filter((n) => /\.exe$/i.test(n));
  if (exes.length === 0) {
    throw new Error(
      `Draft ${TAG_NAME} has no Windows installer (.exe) assets.`,
    );
  }
  console.log(`[verify-release-draft] Installers: ${exes.join(", ")}`);

  // Download updater manifests to temp and validate shape. Both arch
  // manifests are required: without them the updater has nothing to poll.
  const manifests = names.filter((n) => /^latest-.*\.json$/i.test(n));
  for (const expected of [
    "latest-windows-x86_64.json",
    "latest-windows-aarch64.json",
  ]) {
    if (!manifests.includes(expected)) {
      throw new Error(
        `Draft ${TAG_NAME} is missing updater manifest: ${expected}. Run release:updater-manifests first.`,
      );
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arlet-draft-"));
  try {
    for (const name of manifests) {
      const dest = path.join(tmp, name);
      execFileSync(
        "gh",
        [
          "release",
          "download",
          TAG_NAME,
          "--repo",
          REPO,
          "--pattern",
          name,
          "--dir",
          tmp,
          "--clobber",
        ],
        { cwd: root, stdio: "pipe" },
      );
      const manifest = JSON.parse(fs.readFileSync(dest, "utf8"));
      const errors = validateUpdaterManifest(manifest, name);
      if (errors.length > 0) {
        throw new Error(
          `Updater manifest ${name} invalid:\n${errors.join("\n")}`,
        );
      }
      if (manifest.version !== VERSION) {
        throw new Error(
          `Updater manifest ${name} version ${manifest.version} != ${VERSION}.`,
        );
      }
      console.log(`[verify-release-draft] Updater OK: ${name}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(
    `[verify-release-draft] Draft ${TAG_NAME} looks good (${names.length} assets).`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    `[verify-release-draft] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
