// Arlet draft-release helper (create-or-reuse). Arlet-native implementation;
// workflow inspired by Zinnia. Exactly one draft per version tag; this script
// is the single creator. Other jobs poll via wait-for-draft-release.cjs.
//
// Usage: node scripts/ensure-draft-release.cjs

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

try {
  require("dotenv").config();
} catch {
  // dotenv-cli usually loads .env already; the module itself is optional.
}

const REPO_ROOT = path.resolve(__dirname, "..");
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "Arlet";
const packageJson = require("../package.json");
const VERSION = packageJson.version;
const TAG_NAME = `v${VERSION}`;

function gh(args, options = {}) {
  return execFileSync("gh", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(options.env || {}) },
  }).trim();
}

function assertGhAuth() {
  try {
    gh(["auth", "status"]);
  } catch (error) {
    throw new Error(
      `GitHub CLI is not authenticated. Run \`gh auth login\`: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function findDraft() {
  const json = gh([
    "release",
    "list",
    "--repo",
    `${REPO_OWNER}/${REPO_NAME}`,
    "--limit",
    "50",
    "--json",
    "tagName,isDraft,url",
  ]);
  const releases = JSON.parse(json);
  return releases.find((r) => r.tagName === TAG_NAME && r.isDraft) || null;
}

function main() {
  assertGhAuth();
  const existing = findDraft();
  if (existing) {
    console.log(
      `[release:draft] Reusing existing draft ${TAG_NAME}: ${existing.url}`,
    );
    return;
  }
  console.log(`[release:draft] Creating draft release ${TAG_NAME}...`);
  gh([
    "release",
    "create",
    TAG_NAME,
    "--repo",
    `${REPO_OWNER}/${REPO_NAME}`,
    "--draft",
    "--title",
    `Arlet ${TAG_NAME}`,
    "--notes",
    `Arlet ${TAG_NAME} draft. Assets upload here; publish only via \`npm run release:publish\` after verification.`,
  ]);
  const created = findDraft();
  console.log(
    `[release:draft] Draft ready: ${created ? created.url : TAG_NAME}`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    `[release:draft] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
