// Shared license-text helpers for the npm and cargo license inventories.
// Canonical texts in scripts/license-texts/ back packages that ship no
// license file of their own.

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const templateDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "license-texts",
);

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

/** LICENSE/COPYING/NOTICE files in a package directory; never READMEs. */
export function readLicenseTextsFromDir(packageDir, licenseFile = null) {
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
      isRealPathWithin(realDir, filePath) &&
      !/^readme/i.test(relative(packageDir, filePath))
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

function template(id) {
  if (!/^[A-Za-z0-9.-]+$/u.test(id)) return null;
  const file = join(templateDir, `${id}.txt`);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

/**
 * Canonical text for an SPDX expression, headed by the holder's copyright
 * line. OR picks the first template available; AND needs every one.
 * Returns null when no complete text can be built.
 */
export function licenseTextFromTemplates(expression, holder) {
  const normalized = String(expression ?? "")
    .replace(/\s*\/\s*/gu, " OR ")
    .replace(/[()]/gu, " ")
    .trim();
  if (!normalized) return null;
  const header = `Copyright (c) ${holder}`;
  const conjuncts = normalized.split(/\s+AND\s+/u);
  const chosen = [];
  for (const conjunct of conjuncts) {
    const ids = conjunct.split(/\s+OR\s+/u).map((id) => id.trim());
    const id = ids.find((candidate) => template(candidate));
    if (!id) return null;
    chosen.push(id);
  }
  if (chosen.length === 1) return `${header}\n\n${template(chosen[0])}`;
  return [header, ...chosen.map((id) => `--- ${id} ---\n${template(id)}`)].join(
    "\n\n",
  );
}
