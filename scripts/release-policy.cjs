"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Release-only recovery switches. They are useful while repairing a beta
// release, but they must never silently weaken a stable release. Keep this
// list centralized so every release boundary applies the same policy.
const STABLE_FORBIDDEN_ENV = [
  "SKIP_WIN_CODESIGN",
  "FORCE_UPLOAD",
  "SKIP_RELEASE_MIRROR",
  "ALLOW_ASSET_REPLACE",
  "SKIP_E2E",
  "SKIP_WIN_CONTEXT_MENU",
  "SKIP_CARGO_INTEGRATION",
];

// These variables are safety enables: stable runs may leave them unset or
// explicitly enabled, but must not turn them off.
const STABLE_FORBIDDEN_FALSY_ENV = ["ENFORCE_LINUX_X64_PACKAGE_SET"];

const STABLE_CANONICAL_ENV = {
  GH_REPO_OWNER: "BurntToasters",
  GH_REPO_NAME: "Arlet",
};

function isExplicitTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function isExplicitFalsy(value) {
  return /^(0|false|no|off)$/i.test(String(value || "").trim());
}

function isStableReleaseVersion(version) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(
    String(version || ""),
  );
}

function readPackageVersion(root = path.join(__dirname, "..")) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  return String(packageJson.version || "").trim();
}

function assertStableReleaseOverridesAllowed(
  env = process.env,
  version = readPackageVersion(),
) {
  if (!isStableReleaseVersion(version)) return;

  const blocked = STABLE_FORBIDDEN_ENV.filter((name) =>
    isExplicitTruthy(env[name]),
  );
  for (const name of STABLE_FORBIDDEN_FALSY_ENV) {
    if (env[name] !== undefined && isExplicitFalsy(env[name])) {
      blocked.push(name);
    }
  }
  if (blocked.length > 0) {
    throw new Error(
      `Stable release ${version} refuses ${blocked.join(", ")}. Those overrides are beta recovery paths only.`,
    );
  }

  const mismatches = [];
  for (const [name, canonical] of Object.entries(STABLE_CANONICAL_ENV)) {
    const value = String(env[name] || "").trim();
    if (value && value !== canonical) mismatches.push(`${name}="${value}"`);
  }
  const downloadBaseUrl = String(env.RELEASE_DOWNLOAD_BASE_URL || "").trim();
  if (downloadBaseUrl) {
    const canonical = `https://github.com/${STABLE_CANONICAL_ENV.GH_REPO_OWNER}/${STABLE_CANONICAL_ENV.GH_REPO_NAME}/releases/download/v${version}`;
    if (downloadBaseUrl.replace(/\/+$/, "") !== canonical) {
      mismatches.push(`RELEASE_DOWNLOAD_BASE_URL="${downloadBaseUrl}"`);
    }
  }
  const liveBaseUrl = String(env.UPDATER_LIVE_BASE_URL || "").trim();
  if (liveBaseUrl) {
    const canonical = `https://github.com/${STABLE_CANONICAL_ENV.GH_REPO_OWNER}/${STABLE_CANONICAL_ENV.GH_REPO_NAME}/releases/latest/download`;
    if (liveBaseUrl.replace(/\/+$/, "") !== canonical) {
      mismatches.push(`UPDATER_LIVE_BASE_URL="${liveBaseUrl}"`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Stable release ${version} refuses non-canonical GitHub targets: ${mismatches.join(", ")}.`,
    );
  }
}

if (require.main === module) {
  try {
    assertStableReleaseOverridesAllowed();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  STABLE_CANONICAL_ENV,
  STABLE_FORBIDDEN_ENV,
  STABLE_FORBIDDEN_FALSY_ENV,
  assertStableReleaseOverridesAllowed,
  isExplicitFalsy,
  isExplicitTruthy,
  isStableReleaseVersion,
  readPackageVersion,
};
