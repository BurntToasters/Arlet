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

// Any installer link form Arlet has used: versioned build names
// (Arlet_<v>_<arch>-setup.exe) or fixed names (Arlet-Windows-<arch>.exe),
// under a tag or under /latest/. See release-assets.cjs.
const INSTALLER_URL =
  /\/releases\/(?:download\/v[^/\s)"]+|latest\/download)\/Arlet(?:_[^_\s)"]+_(x64|arm64)-setup|-Windows-(x64|arm64))\.exe/g;

/** Installer links pinned to the release tag (CHANGELOG release body). */
function pointAssetsAt(text, version) {
  return text.replace(
    INSTALLER_URL,
    (_match, builtArch, fixedArch) =>
      `/releases/download/v${version}/Arlet-Windows-${builtArch ?? fixedArch}.exe`,
  );
}

/** Installer links that always serve the newest release (README buttons). */
function pointAssetsAtLatest(text) {
  return text.replace(
    INSTALLER_URL,
    (_match, builtArch, fixedArch) =>
      `/releases/latest/download/Arlet-Windows-${builtArch ?? fixedArch}.exe`,
  );
}

const CHANGELOG_TABLE_START = "# ⬇️ Downloads";
const CHANGELOG_TABLE_END = "\n> Arlet requires";
export const CHANGELOG_INTRO_ANCHOR =
  "Arlet! An Apple Music client for Windows built on Tauri V2!\n\n";

/**
 * Like Zinnia: point the CHANGELOG download table at `version` and add a
 * placeholder section when it is missing. The release preflight rejects the
 * placeholder, so notes must be written before a release.
 */
export function syncChangelogForVersion(changelog, version) {
  const start = changelog.indexOf(CHANGELOG_TABLE_START);
  const end = changelog.indexOf(CHANGELOG_TABLE_END, start);
  if (start === -1 || end === -1) {
    throw new Error(
      `CHANGELOG.md download table markers not found ("${CHANGELOG_TABLE_START}" ... "${CHANGELOG_TABLE_END.trim()}").`,
    );
  }
  let updated =
    changelog.slice(0, start) +
    pointAssetsAt(changelog.slice(start, end), version) +
    changelog.slice(end);
  const heading = `## Changes in \`v${version}:\``;
  if (!updated.includes(heading)) {
    if (!updated.includes(CHANGELOG_INTRO_ANCHOR)) {
      throw new Error("CHANGELOG.md intro anchor not found.");
    }
    updated = updated.replace(
      CHANGELOG_INTRO_ANCHOR,
      `${CHANGELOG_INTRO_ANCHOR}${heading}\n\n- **Fix:** (add release notes)\n\n`,
    );
  }
  return updated;
}

export const README_DOWNLOADS_START = "<!-- arlet-downloads:start -->";
export const README_DOWNLOADS_END = "<!-- arlet-downloads:end -->";

/**
 * Keeps the README download buttons (between the markers) on the fixed
 * /releases/latest/download/ names, so they never point at an unpublished
 * version. The version argument is unused; it mirrors the CHANGELOG sync.
 */
export function syncReadmeDownloads(readme, _version) {
  const start = readme.indexOf(README_DOWNLOADS_START);
  const end = readme.indexOf(README_DOWNLOADS_END, start);
  if (start === -1 || end === -1) {
    throw new Error(
      `README.md download markers not found (${README_DOWNLOADS_START} ... ${README_DOWNLOADS_END}).`,
    );
  }
  return (
    readme.slice(0, start) +
    pointAssetsAtLatest(readme.slice(start, end)) +
    readme.slice(end)
  );
}
