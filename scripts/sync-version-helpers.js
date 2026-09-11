/**
 * Keep the root crate's version in Cargo.lock aligned with Cargo.toml.
 */
export function updateCargoLockPackageVersion(lockfile, packageName, version) {
  const pattern = new RegExp(
    `(\\[\\[package\\]\\]\\r?\\nname = "${packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\r?\\nversion = )"[^"]*"`,
  );
  if (!pattern.test(lockfile)) {
    throw new Error(
      `Cargo.lock is missing [[package]] name = "${packageName}"`,
    );
  }
  return lockfile.replace(pattern, `$1"${version}"`);
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
