// Publish the fully verified exact-version draft. The draft verifier runs
// before the final API patch so a partial/mis-tagged release cannot become a
// channel feed. Stable releases remain the GitHub /releases/latest target;
// beta releases keep prerelease=true and sync their beta manifests only after
// GitHub returns the published prerelease. If that final sync fails, the
// release:sync-beta-manifests command is the documented recovery path.

const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { assertGitHubCliAuthenticated, githubApi } = require("./github-cli.cjs");
const { assertStableReleaseOverridesAllowed } = require("./release-policy.cjs");

try {
  require("dotenv").config();
} catch {
  // dotenv-cli normally loads .env before this script runs.
}

const REPO_ROOT = path.resolve(__dirname, "..");
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "Arlet";
const REPO = `${REPO_OWNER}/${REPO_NAME}`;
const packageJson = require("../package.json");
const VERSION = String(packageJson.version || "").trim();
const TAG_NAME = `v${VERSION}`;
const EXPECTED_PRERELEASE = /-beta\.\d+$/.test(VERSION);
const FORCE_UPLOAD = /^(1|true|yes|on)$/i.test(
  String(process.env.FORCE_UPLOAD || "").trim(),
);

function currentReleaseCommit() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("Could not resolve an exact release commit from git HEAD.");
  }
  return commit;
}

function assertReleaseTargetsCommit(release, commit) {
  if (release?.target_commitish === commit) return;
  if (FORCE_UPLOAD) {
    console.warn(
      `[release:publish] WARNING: ${TAG_NAME} targets ${release?.target_commitish || "an unknown commit"}, not HEAD ${commit}; FORCE_UPLOAD=1 bypassing commit fence.`,
    );
    return;
  }
  throw new Error(
    `Release ${TAG_NAME} targets ${release?.target_commitish || "an unknown commit"}, not HEAD ${commit}. Refusing to publish stale artifacts.`,
  );
}

function getDraftRelease() {
  try {
    return githubApi(
      "GET",
      `/repos/${REPO}/releases/tags/${encodeURIComponent(TAG_NAME)}`,
    );
  } catch (error) {
    if (error?.statusCode !== 404) throw error;
    for (let page = 1; page <= 20; page += 1) {
      const releases = githubApi(
        "GET",
        `/repos/${REPO}/releases?per_page=100&page=${page}`,
      );
      if (!Array.isArray(releases)) break;
      const placeholder = releases.find(
        (release) =>
          release?.draft &&
          release.name === VERSION &&
          /^untagged-[0-9a-f]{20}$/i.test(String(release.tag_name || "")),
      );
      if (placeholder) return placeholder;
      if (releases.length < 100) break;
    }
    throw error;
  }
}

function runVerifyDraft() {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "verify-release-draft.js"), "--verify-artifacts"],
    { stdio: "inherit", cwd: REPO_ROOT },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "release:verify:draft failed; fix the draft instead of publishing it.",
    );
  }
}

async function main() {
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  assertGitHubCliAuthenticated();
  const commit = currentReleaseCommit();
  runVerifyDraft();
  const draft = getDraftRelease();
  if (!draft?.draft) throw new Error(`No draft exists for ${TAG_NAME}.`);
  if (Boolean(draft.prerelease) !== EXPECTED_PRERELEASE) {
    throw new Error(
      `Draft ${TAG_NAME} prerelease=${draft.prerelease}, expected ${EXPECTED_PRERELEASE}; re-run npm run release:draft.`,
    );
  }
  assertReleaseTargetsCommit(draft, commit);
  const published = githubApi("PATCH", `/repos/${REPO}/releases/${draft.id}`, {
    tag_name: TAG_NAME,
    target_commitish: commit,
    draft: false,
    prerelease: EXPECTED_PRERELEASE,
  });
  if (
    published?.tag_name !== TAG_NAME ||
    published.draft ||
    Boolean(published.prerelease) !== EXPECTED_PRERELEASE
  ) {
    throw new Error(
      `GitHub returned an invalid published release for ${TAG_NAME}.`,
    );
  }
  console.log(
    `[release:publish] Published ${TAG_NAME}: ${published.html_url || "ok"}`,
  );
  if (published.prerelease) {
    try {
      const { syncBetaManifestsAfterPublish } = await import("./gpg-sign.js");
      await syncBetaManifestsAfterPublish();
    } catch (error) {
      throw new Error(
        `Published ${TAG_NAME}, but beta manifest synchronization failed. Retry with npm run release:sync-beta-manifests. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    console.log(
      "[release:publish] Beta manifests synchronized after the published prerelease was confirmed.",
    );
  }
  console.log("[release:publish] Run npm run release:verify:published next.");
}

if (require.main === module) {
  Promise.resolve(main()).catch((error) => {
    console.error(
      `[release:publish] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

module.exports = { assertReleaseTargetsCommit, currentReleaseCommit, main };
