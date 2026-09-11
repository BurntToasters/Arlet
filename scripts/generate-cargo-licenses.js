#!/usr/bin/env node
// Arlet cargo license inventory. Architecture inspired by Zinnia; implementation is original.
// Builds public/licenses-cargo.json from `cargo metadata` plus packaged license files.
// Unresolved entries go to public/licenses-cargo-unresolved.json.
// Pass --require-complete for a fail-closed release compliance gate.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const cargoManifestPath = join(repoRoot, "src-tauri", "Cargo.toml");
const outputPath = join(repoRoot, "public", "licenses-cargo.json");
const unresolvedOutputPath = join(
  repoRoot,
  "public",
  "licenses-cargo-unresolved.json",
);
const requireComplete = process.argv.includes("--require-complete");

function runCargoMetadata() {
  const result = spawnSync(
    "cargo",
    [
      "metadata",
      "--manifest-path",
      cargoManifestPath,
      "--format-version",
      "1",
      "--locked",
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error) {
    throw new Error(`Failed to run cargo metadata: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `cargo metadata failed with exit code ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}

function computeReachableIds(metadata) {
  const members = new Set(
    Array.isArray(metadata.workspace_members) ? metadata.workspace_members : [],
  );
  const nodes = Array.isArray(metadata.resolve?.nodes)
    ? metadata.resolve.nodes
    : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const queue = [...members];
  const reachable = new Set(queue);
  while (queue.length > 0) {
    const id = queue.shift();
    const node = byId.get(id);
    if (!node || !Array.isArray(node.deps)) continue;
    for (const dep of node.deps) {
      const depId = typeof dep?.pkg === "string" ? dep.pkg : null;
      if (!depId || reachable.has(depId)) continue;
      reachable.add(depId);
      queue.push(depId);
    }
  }
  return { reachable, members };
}

function hasLicenseTerms(text) {
  return /permission is hereby granted|licensed under|general public license|mozilla public license|redistribution and use/i.test(
    text,
  );
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function isRealPathWithin(root, candidate) {
  try {
    return isWithin(realpathSync(root), realpathSync(candidate));
  } catch {
    return false;
  }
}

function readLicenseTextsFromDir(packageDir, licenseFile = null) {
  const realDir = realpathSync(packageDir);
  const names = new Set(
    readdirSync(packageDir).filter((name) =>
      /^(licen[cs]e|copying|notice|authors|copyright)(?:[._-].*)?$/i.test(name),
    ),
  );
  if (typeof licenseFile === "string" && licenseFile.trim()) {
    const filePath = resolve(packageDir, licenseFile);
    if (
      isWithin(packageDir, filePath) &&
      existsSync(filePath) &&
      isRealPathWithin(realDir, filePath)
    ) {
      names.add(relative(packageDir, filePath));
    }
  }
  const sections = [];
  for (const name of [...names].sort()) {
    const filePath = resolve(packageDir, name);
    if (
      !isWithin(packageDir, filePath) ||
      !existsSync(filePath) ||
      !isRealPathWithin(realDir, filePath)
    ) {
      continue;
    }
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const text = readFileSync(filePath, "utf8").trim();
    const attributionOnly = /^(authors|copyright)(?:[._-].*)?$/i.test(name);
    if (text && (!attributionOnly || hasLicenseTerms(text))) {
      sections.push(`--- ${name} ---\n${text}`);
    }
  }
  return sections.length > 0 ? sections.join("\n\n") : null;
}

function spdxReferences(licenses) {
  const identifiers = licenses.match(/[A-Za-z0-9.-]+(?:\+)?/g) ?? [];
  return [...new Set(identifiers)]
    .filter(
      (id) =>
        !["AND", "OR", "WITH", "LicenseRef"].includes(id) &&
        !id.startsWith("DocumentRef-"),
    )
    .map((id) => ({
      identifier: id,
      url: `https://spdx.org/licenses/${encodeURIComponent(id)}.html`,
    }));
}

function toEntry(pkg) {
  const licenses =
    typeof pkg.license === "string" && pkg.license.trim()
      ? pkg.license.trim()
      : "UNKNOWN";
  if (licenses === "UNKNOWN") {
    throw new Error(
      `Cargo dependency ${pkg.name}@${pkg.version} does not declare an SPDX license.`,
    );
  }
  let licenseText = null;
  if (typeof pkg.manifest_path === "string") {
    licenseText = readLicenseTextsFromDir(
      dirname(pkg.manifest_path),
      pkg.license_file,
    );
  }
  const entry = {
    licenses,
    repository:
      typeof pkg.repository === "string" && pkg.repository.trim()
        ? pkg.repository.trim()
        : null,
    packageManager: "cargo",
    licenseText,
    licenseTextStatus: licenseText ? "bundled" : "not-packaged",
    licenseReferences: licenseText ? [] : spdxReferences(licenses),
  };
  if (Array.isArray(pkg.authors) && pkg.authors.length > 0) {
    const joined = pkg.authors
      .filter((a) => typeof a === "string" && a.trim())
      .join(", ");
    if (joined) entry.publisher = joined;
  }
  if (typeof pkg.source === "string" && pkg.source.trim()) {
    entry.source = pkg.source.trim();
  }
  return entry;
}

function main() {
  const metadata = runCargoMetadata();
  const { reachable, members } = computeReachableIds(metadata);
  const packages = Array.isArray(metadata.packages) ? metadata.packages : [];
  const entries = {};
  for (const pkg of packages) {
    if (
      !pkg ||
      typeof pkg.id !== "string" ||
      !reachable.has(pkg.id) ||
      members.has(pkg.id) ||
      typeof pkg.name !== "string" ||
      typeof pkg.version !== "string"
    ) {
      continue;
    }
    entries[`cargo:${pkg.name}@${pkg.version}`] = toEntry(pkg);
  }
  const sorted = Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)),
  );
  const unresolved = Object.fromEntries(
    Object.entries(sorted).filter(
      ([, entry]) => entry.licenseTextStatus === "not-packaged",
    ),
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
  writeFileSync(
    unresolvedOutputPath,
    `${JSON.stringify(unresolved, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `[licenses:cargo] Wrote ${Object.keys(sorted).length} entries to ${outputPath}`,
  );
  const missing = Object.keys(unresolved).length;
  if (missing > 0) {
    const message =
      `${missing} package license text(s) not found in crates.io packages. ` +
      `Report: ${unresolvedOutputPath}. SPDX links are informational only.`;
    if (requireComplete) {
      console.error(`[licenses:cargo] FAILED: ${message}`);
      process.exitCode = 1;
      return;
    }
    console.warn(`[licenses:cargo] WARNING: ${message}`);
    console.warn(
      "[licenses:cargo] Re-run with --require-complete for a fail-closed gate.",
    );
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  main();
}
