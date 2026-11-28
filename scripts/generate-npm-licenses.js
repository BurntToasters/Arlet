#!/usr/bin/env node
// Arlet npm license inventory. Architecture inspired by Zinnia; implementation is original.
// Collects production npm license metadata into public/licenses.json.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  licenseTextFromTemplates,
  readLicenseTextsFromDir,
} from "./license-texts.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const outputPath = join(repoRoot, "public", "licenses.json");
const packageLock = JSON.parse(
  readFileSync(join(repoRoot, "package-lock.json"), "utf8"),
);
const rootPackage = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
);

function packageNameFromPath(lockPath, packagePath) {
  const relativePath = lockPath.slice("node_modules/".length);
  const segments = relativePath.split("/node_modules/").at(-1).split("/");
  const name = segments[0].startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
  if (name !== packagePath.name) {
    throw new Error(`Package name mismatch at ${lockPath}: expected ${name}`);
  }
  return name;
}

function repositoryUrl(value) {
  const raw = typeof value === "string" ? value : value?.url;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw
    .trim()
    .replace(/^git\+/u, "")
    .replace(/\.git$/u, "");
}

function packageLicense(lockEntry, packagePath) {
  const value =
    lockEntry.license ?? packagePath.license ?? packagePath.licenses;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const expressions = value
      .map((license) => (typeof license === "string" ? license : license?.type))
      .filter((license) => typeof license === "string" && license.trim());
    if (expressions.length > 0) return expressions.join(" OR ");
  }
  if (value && typeof value.type === "string" && value.type.trim()) {
    return value.type.trim();
  }
  return "UNKNOWN";
}

function packagePublisher(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value.name === "string" && value.name.trim()) {
    return value.name.trim();
  }
  return null;
}

// package-lock v3 marks packages reachable only from devDependencies with
// `dev: true`; retain every production dependency, including optional ones.
const modules = Object.entries(packageLock.packages)
  .filter(
    ([lockPath, entry]) =>
      lockPath.startsWith("node_modules/") && entry.dev !== true,
  )
  .map(([lockPath, entry]) => {
    const packageDir = join(repoRoot, lockPath);
    const packagePath = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    );
    const name = packageNameFromPath(lockPath, packagePath);
    return {
      key: `${name}@${entry.version}`,
      license: packageLicense(entry, packagePath),
      repository: repositoryUrl(packagePath.repository),
      publisher: packagePublisher(packagePath.author),
      path: packageDir,
      licenseFile: packagePath.licenseFile,
    };
  })
  .sort((left, right) => left.key.localeCompare(right.key));

// Arlet itself is GPL-3.0-only; this file lists third-party notices only.
const ownName = rootPackage.name;
const licenses = {};
for (const module of modules) {
  const { key } = module;
  if (key.startsWith(`${ownName}@`)) continue;
  const expression = module.license;
  // Read real license files only, then canonical templates; never use README.
  const bundled = readLicenseTextsFromDir(module.path, module.licenseFile);
  const holder =
    module.publisher || `the ${key.replace(/@[^@]*$/u, "")} authors`;
  const licenseText =
    bundled ?? licenseTextFromTemplates(expression, holder) ?? null;
  licenses[key] = {
    licenses: expression,
    repository: module.repository,
    licenseText,
    licenseTextStatus: bundled ? "bundled" : "spdx-template",
    packageManager: "npm",
  };
}

const incomplete = Object.entries(licenses).filter(
  ([, entry]) => entry.licenses === "UNKNOWN" || !entry.licenseText,
);
if (incomplete.length > 0) {
  throw new Error(
    `Missing license metadata for: ${incomplete
      .slice(0, 10)
      .map(([name]) => name)
      .join(", ")}${incomplete.length > 10 ? "…" : ""}`,
  );
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(licenses, null, 2)}\n`, "utf8");
console.log(
  `[licenses:npm] Wrote ${Object.keys(licenses).length} entries to ${outputPath}`,
);
