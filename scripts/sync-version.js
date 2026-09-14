#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readCargoLockPackageVersion,
  readCargoManifestVersion,
  syncCargoManifestVersion,
  syncNpmLockfileVersion,
  updateCargoLockPackageVersion,
} from "./sync-version-helpers.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const checkOnly = process.argv.slice(2).includes("--check");
const unexpectedArgs = process.argv.slice(2).filter((arg) => arg !== "--check");
if (unexpectedArgs.length) {
  throw new Error(
    `Unknown argument(s): ${unexpectedArgs.join(", ")}. Usage: node scripts/sync-version.js [--check]`,
  );
}

function readRequired(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Required version file is missing: ${path.relative(root, filePath)}`,
    );
  }
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  try {
    return JSON.parse(readRequired(filePath));
  } catch (error) {
    throw new Error(
      `${path.relative(root, filePath)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const packagePath = path.join(root, "package.json");
const packageJson = readJson(packagePath);
const version = packageJson.version;
if (typeof version !== "string" || !version.trim()) {
  throw new Error("package.json must contain a non-empty string version");
}

const changes = [];

function planText(filePath, nextText, verify) {
  const currentText = readRequired(filePath);
  if (currentText === nextText) return;
  changes.push({ filePath, currentText, nextText, verify });
}

function planJson(filePath, update, verify) {
  const current = readJson(filePath);
  const next = update(current);
  const currentText = readRequired(filePath);
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  if (currentText !== nextText) {
    changes.push({ filePath, currentText, nextText, verify });
  }
}

const tauriPath = path.join(root, "src-tauri", "tauri.conf.json");
const tauriConf = readJson(tauriPath);
if (tauriConf.version !== version) {
  planJson(
    tauriPath,
    (conf) => ({ ...conf, version }),
    () => readJson(tauriPath).version === version,
  );
}

const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
const cargoText = readRequired(cargoPath);
const nextCargo = syncCargoManifestVersion(cargoText, "arlet", version);
planText(
  cargoPath,
  nextCargo,
  () =>
    readCargoManifestVersion(fs.readFileSync(cargoPath, "utf8"), "arlet") ===
    version,
);

const cargoLockPath = path.join(root, "src-tauri", "Cargo.lock");
const cargoLockText = readRequired(cargoLockPath);
const nextCargoLock = updateCargoLockPackageVersion(
  cargoLockText,
  "arlet",
  version,
);
planText(
  cargoLockPath,
  nextCargoLock,
  () =>
    readCargoLockPackageVersion(
      fs.readFileSync(cargoLockPath, "utf8"),
      "arlet",
    ) === version,
);

const npmLockPath = path.join(root, "package-lock.json");
const npmLockText = readRequired(npmLockPath);
const nextNpmLock = syncNpmLockfileVersion(npmLockText, version);
planText(npmLockPath, nextNpmLock, () => {
  const lock = readJson(npmLockPath);
  return lock.version === version && lock.packages?.[""]?.version === version;
});

if (checkOnly) {
  if (changes.length) {
    console.error(
      `sync-version --check: version drift detected for ${version}:`,
    );
    for (const change of changes) {
      console.error(`- ${path.relative(root, change.filePath)}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`sync-version --check: ok (${version})`);
  }
} else {
  for (const change of changes) {
    fs.writeFileSync(change.filePath, change.nextText);
    if (!change.verify()) {
      throw new Error(
        `Version write verification failed: ${path.relative(root, change.filePath)}`,
      );
    }
    console.log(`${path.relative(root, change.filePath)} → ${version}`);
  }
  if (!changes.length) {
    console.log(`sync-version: all version files already match ${version}`);
  }
}
