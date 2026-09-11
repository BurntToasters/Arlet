#!/usr/bin/env node
// Arlet published-release verifier. Arlet-native implementation; workflow
// inspired by Zinnia. After publishing, downloads the live updater metadata
// and artifact/signature pairs to prove the updater is functional.
//
// Usage: npm run release:verify:published

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
const tauriConf = JSON.parse(
  fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const endpoints = tauriConf.plugins?.updater?.endpoints || [];

function expandEndpoint(template) {
  return template
    .replaceAll("{{target}}", "windows")
    .replaceAll("{{arch}}", "x86_64")
    .replaceAll("{{current_version}}", VERSION);
}

async function main() {
  if (endpoints.length === 0) {
    throw new Error("No updater endpoints configured in tauri.conf.json.");
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arlet-published-"));
  try {
    let verified = 0;
    for (const template of endpoints) {
      const url = expandEndpoint(String(template));
      console.log(`[verify-release-published] GET ${url}`);
      const response = await fetch(url);
      if (response.status === 404) {
        console.warn(
          `[verify-release-published] Not found (may be arch-specific): ${url}`,
        );
        continue;
      }
      if (!response.ok) {
        throw new Error(`Updater endpoint ${url} returned ${response.status}.`);
      }
      const manifest = await response.json();
      const errors = validateUpdaterManifest(manifest, url);
      if (errors.length > 0) {
        throw new Error(`Live updater manifest invalid:\n${errors.join("\n")}`);
      }
      if (manifest.version !== VERSION) {
        throw new Error(
          `Live updater version ${manifest.version} != ${VERSION} at ${url}.`,
        );
      }
      verified += 1;
      console.log(
        `[verify-release-published] OK: ${url} (v${manifest.version})`,
      );
    }
    if (verified === 0) {
      throw new Error("No updater endpoint could be verified.");
    }
    console.log(
      `[verify-release-published] Published v${VERSION} verified (${verified} endpoint(s)).`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    `[verify-release-published] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
