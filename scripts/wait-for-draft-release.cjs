// Arlet draft waiter (poll-only, never creates). Arlet-native implementation;
// workflow inspired by Zinnia. Used by jobs that must reuse the single draft
// created by `npm run release:draft`.
//
// Usage: node scripts/wait-for-draft-release.cjs
// Env: RELEASE_DRAFT_WAIT_TIMEOUT_MS (default 30 min), RELEASE_DRAFT_WAIT_POLL_MS (default 15 s)

const { execFileSync } = require("child_process");
const path = require("path");

try {
  require("dotenv").config();
} catch {
  // dotenv-cli usually loads .env already.
}

const REPO_ROOT = path.resolve(__dirname, "..");
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "Arlet";
const packageJson = require("../package.json");
const TAG_NAME = `v${packageJson.version}`;

const TIMEOUT_MS = Number.parseInt(
  process.env.RELEASE_DRAFT_WAIT_TIMEOUT_MS || "1800000",
  10,
);
const POLL_MS = Number.parseInt(
  process.env.RELEASE_DRAFT_WAIT_POLL_MS || "15000",
  10,
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findDraft() {
  const json = execFileSync(
    "gh",
    [
      "release",
      "list",
      "--repo",
      `${REPO_OWNER}/${REPO_NAME}`,
      "--limit",
      "50",
      "--json",
      "tagName,isDraft,url",
    ],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  const releases = JSON.parse(json);
  return releases.find((r) => r.tagName === TAG_NAME && r.isDraft) || null;
}

async function main() {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    let draft = null;
    try {
      draft = findDraft();
    } catch (error) {
      console.warn(
        `[release:wait-draft] lookup failed, retrying: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (draft) {
      console.log(`[release:wait-draft] Draft ready: ${draft.url}`);
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for draft ${TAG_NAME} after ${TIMEOUT_MS} ms.`,
      );
    }
    console.log(`[release:wait-draft] Waiting for draft ${TAG_NAME}...`);
    await sleep(POLL_MS);
  }
}

main().catch((error) => {
  console.error(
    `[release:wait-draft] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
