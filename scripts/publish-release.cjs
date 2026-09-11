// Arlet release publisher. Arlet-native implementation; workflow inspired by
// Zinnia. Verifies the draft first, then flips it from draft to published.
// Usage: npm run release:publish (after every platform job has signed)

const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

try {
  require("dotenv").config();
} catch {
  // dotenv-cli usually loads .env already.
}

const REPO_ROOT = path.resolve(__dirname, "..");
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "Arlet";
const packageJson = require("../package.json");
const VERSION = packageJson.version;
const TAG_NAME = `v${VERSION}`;

function runVerifyDraft() {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "verify-release-draft.js")],
    { stdio: "inherit", cwd: REPO_ROOT },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "release:verify:draft failed; fix the draft instead of publishing it.",
    );
  }
}

function main() {
  runVerifyDraft();
  console.log(`[release:publish] Publishing ${TAG_NAME}...`);
  execFileSync(
    "gh",
    [
      "release",
      "edit",
      TAG_NAME,
      "--repo",
      `${REPO_OWNER}/${REPO_NAME}`,
      "--draft=false",
    ],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  console.log(
    `[release:publish] Published ${TAG_NAME}. Run release:verify:published next.`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    `[release:publish] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
