/**
 * Keep the root crate's version in Cargo.lock aligned with Cargo.toml.
 */
export function updateCargoLockPackageVersion(lockfile, packageName, version) {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(\\[\\[package\\]\\]\\r?\\nname = "${escapedName}"\\r?\\nversion = )"[^"]*"`,
    "g",
  );
  const matches = lockfile.match(pattern);
  if (matches?.length !== 1) {
    throw new Error(
      `Cargo.lock package ${packageName} must appear exactly once; found ${matches?.length ?? 0}`,
    );
  }
  return lockfile.replace(pattern, `$1"${version}"`);
}

/**
 * Read and replace the root package version in a Cargo manifest.
 *
 * Cargo permits dependency versions elsewhere in the file, so this is scoped
 * to the [package] section instead of replacing the first version assignment.
 */
export function syncCargoManifestVersion(manifest, packageName, version) {
  const packageSection = manifest.match(/\[package\][\s\S]*?(?=\n\[|$)/)?.[0];
  if (!packageSection) {
    throw new Error("Cargo.toml is missing [package] section");
  }
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const namePattern = new RegExp(
    `(^|\\r?\\n)name\\s*=\\s*"${escapedName}"(?:\\r?\\n|$)`,
  );
  if (!namePattern.test(packageSection)) {
    throw new Error(
      `Cargo.toml [package] name does not match "${packageName}"`,
    );
  }
  const versionPattern = /(^|\r?\n)(version\s*=\s*)"[^"]*"(?=\r?\n|$)/g;
  const matches = packageSection.match(versionPattern);
  if (matches?.length !== 1) {
    throw new Error(
      `Cargo.toml [package] version must appear exactly once; found ${matches?.length ?? 0}`,
    );
  }
  const updatedSection = packageSection.replace(
    versionPattern,
    `$1$2"${version}"`,
  );
  return manifest.replace(packageSection, updatedSection);
}

/** Return the root package version from a Cargo manifest. */
export function readCargoManifestVersion(manifest, packageName) {
  const packageSection = manifest.match(/\[package\][\s\S]*?(?=\n\[|$)/)?.[0];
  if (!packageSection) return null;
  const name = packageSection.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (name !== packageName) return null;
  return packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? null;
}

/** Return one Cargo.lock package version, or null when the entry is absent. */
export function readCargoLockPackageVersion(lockfile, packageName) {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\[\\[package\\]\\]\\r?\\nname = "${escapedName}"\\r?\\nversion = "([^"]*)"`,
    "g",
  );
  const matches = [...lockfile.matchAll(pattern)];
  if (matches.length !== 1) return null;
  return matches[0][1];
}

export function syncNpmLockfileVersion(lockText, version) {
  let parsed;
  try {
    parsed = JSON.parse(lockText);
  } catch (error) {
    throw new Error(
      `package-lock.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("package-lock.json root must be an object");
  }
  if (!parsed.packages || typeof parsed.packages !== "object") {
    throw new Error("package-lock.json is missing packages");
  }
  if (!parsed.packages[""] || typeof parsed.packages[""] !== "object") {
    throw new Error('package-lock.json is missing packages[""]');
  }
  if (parsed.version === version && parsed.packages[""].version === version) {
    return lockText;
  }
  parsed.version = version;
  parsed.packages[""].version = version;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
