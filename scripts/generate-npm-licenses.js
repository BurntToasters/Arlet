#!/usr/bin/env node
// Arlet npm license inventory. Architecture inspired by Zinnia; implementation is original.
// Collects production npm license metadata into public/licenses.json.

import { init } from "license-checker-rseidelsohn";
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

const modules = await new Promise((resolve, reject) => {
  init(
    {
      start: repoRoot,
      production: true,
      customFormat: {
        licenses: true,
        repository: true,
        publisher: true,
        path: true,
      },
    },
    (error, result) => (error ? reject(error) : resolve(result)),
  );
});

// Arlet itself is GPL-3.0-only; license-checker reports private packages as
// UNLICENSED, and this file lists third-party notices only.
const ownName = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
).name;

const licenses = {};
for (const key of Object.keys(modules).sort()) {
  if (key.startsWith(`${ownName}@`)) continue;
  const entry = modules[key];
  const expression = Array.isArray(entry.licenses)
    ? entry.licenses.join(" OR ")
    : entry.licenses || "UNKNOWN";
  // license-checker falls back to a README when a package has no LICENSE
  // file; read real license files only, then canonical templates.
  const bundled = entry.path ? readLicenseTextsFromDir(entry.path) : null;
  const holder =
    entry.publisher || `the ${key.replace(/@[^@]*$/u, "")} authors`;
  const licenseText =
    bundled ?? licenseTextFromTemplates(expression, holder) ?? null;
  licenses[key] = {
    licenses: expression,
    repository: entry.repository || null,
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
