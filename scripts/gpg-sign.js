#!/usr/bin/env node
// Arlet GPG release signer. Arlet-native implementation; workflow inspired by
// Zinnia. Signs built Windows artifacts with detached ASCII-armor signatures
// and uploads everything to the version draft release.
//
// Usage: npm run release:sign:gpg
// Env: GPG_KEY_ID (required), GPG_PASSPHRASE (optional, for loopback)

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const TAG_NAME = `v${packageJson.version}`;
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "Arlet";
const REPO = `${REPO_OWNER}/${REPO_NAME}`;

function findArtifacts() {
  const results = [];
  const bundleRoots = ["src-tauri/target"];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(exe|msi|json|sig|zip|nsis\.zip)$/i.test(entry.name)) {
        results.push(full);
      }
    }
  };
  for (const rel of bundleRoots) walk(path.join(root, rel));
  return [...new Set(results)];
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function gpgSign(filePath) {
  const keyId = process.env.GPG_KEY_ID?.trim();
  if (!keyId) {
    throw new Error("GPG_KEY_ID is required to sign release artifacts.");
  }
  const args = [
    "--batch",
    "--yes",
    "--armor",
    "--detach-sign",
    "--local-user",
    keyId,
    "--output",
    `${filePath}.asc`,
    filePath,
  ];
  const env = { ...process.env };
  const options = { cwd: root, stdio: "inherit" };
  if (process.env.GPG_PASSPHRASE) {
    args.splice(
      0,
      0,
      "--pinentry-mode",
      "loopback",
      "--passphrase",
      process.env.GPG_PASSPHRASE,
    );
    options.env = env;
  }
  console.log(`[gpg-sign] Signing ${path.relative(root, filePath)}`);
  const result = spawnSync("gpg", args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gpg exited with ${result.status} for ${filePath}`);
  }
}

function main() {
  const artifacts = findArtifacts();
  if (artifacts.length === 0) {
    throw new Error(
      "No Windows artifacts found under src-tauri/target to sign.",
    );
  }
  const releaseDir = path.join(root, "release");
  fs.mkdirSync(releaseDir, { recursive: true });

  // Stage copies plus a checksum manifest for the draft. Updater manifests
  // (latest-*.json) are generated into release/ by release:updater-manifests
  // beforehand, so they are picked up here for checksums, signatures, upload.
  const staged = [];
  for (const artifact of artifacts) {
    const dest = path.join(releaseDir, path.basename(artifact));
    fs.copyFileSync(artifact, dest);
    staged.push(dest);
  }
  for (const entry of fs.readdirSync(releaseDir)) {
    if (/^latest-.*\.json$/i.test(entry)) {
      staged.push(path.join(releaseDir, entry));
    }
  }
  const sums = staged
    .map((f) => `${sha256File(f)}  ${path.basename(f)}`)
    .join("\n");
  const sumsPath = path.join(releaseDir, "SHA256SUMS");
  fs.writeFileSync(sumsPath, `${sums}\n`, "utf8");
  staged.push(sumsPath);

  const toSign = [...staged];
  for (const file of toSign) {
    gpgSign(file);
    staged.push(`${file}.asc`);
  }

  console.log(
    `[gpg-sign] Uploading ${staged.length} file(s) to draft ${TAG_NAME}...`,
  );
  execFileSync(
    "gh",
    ["release", "upload", TAG_NAME, "--repo", REPO, "--clobber", ...staged],
    { cwd: root, stdio: "inherit" },
  );
  console.log("[gpg-sign] Done.");
}

try {
  main();
} catch (error) {
  console.error(
    `[gpg-sign] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
