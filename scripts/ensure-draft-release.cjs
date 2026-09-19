// Create or refresh the one exact-version GitHub draft used by Arlet's
// platform jobs. The prerelease flag is derived from package.json and is
// reasserted whenever an existing draft is reused, because a wrong flag makes
// GitHub's /releases/latest point at the wrong channel.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { assertGitHubCliAuthenticated, githubApi } = require("./github-cli.cjs");
const { readChangelogSection } = require("./changelog.cjs");
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
const CHANGELOG_PATH = path.join(REPO_ROOT, "CHANGELOG.md");
const packageJson = require("../package.json");
const VERSION = String(packageJson.version || "").trim();
const TAG_NAME = `v${VERSION}`;
const NUMERIC = "(?:0|[1-9]\\d*)";
const BETA_VERSION = new RegExp(
  `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}-beta\\.${NUMERIC}$`,
);
const STABLE_VERSION = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}$`);
const IS_PRERELEASE = BETA_VERSION.test(VERSION);
if (!IS_PRERELEASE && !STABLE_VERSION.test(VERSION)) {
  throw new Error(
    `Unsupported release version '${VERSION}'; Arlet releases use beta or stable only.`,
  );
}
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

function isExpectedRelease(release) {
  return Boolean(
    release?.tag_name === TAG_NAME ||
    (release?.draft &&
      release.name === VERSION &&
      /^untagged-[0-9a-f]{20}$/i.test(String(release.tag_name || ""))),
  );
}

function assertReleaseTargetsCommit(release, commit) {
  if (release?.target_commitish === commit) return release;
  if (FORCE_UPLOAD) {
    console.warn(
      `[release:draft] WARNING: ${TAG_NAME} targets ${release?.target_commitish || "an unknown commit"}, not HEAD ${commit}; FORCE_UPLOAD=1 bypassing commit fence.`,
    );
    return release;
  }
  throw new Error(
    `Draft ${TAG_NAME} targets ${release?.target_commitish || "an unknown commit"}, not HEAD ${commit}. Delete or retarget the stale draft, or set FORCE_UPLOAD=1 only after inspection.`,
  );
}

function listReleases() {
  const releases = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = githubApi(
      "GET",
      `/repos/${REPO}/releases?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

function findMatchingReleases(releases = listReleases()) {
  return releases.filter(isExpectedRelease);
}

function assertNoMisnamedVersionDrafts(releases) {
  const misnamed = releases.filter(
    (release) =>
      release?.draft && release.name === VERSION && !isExpectedRelease(release),
  );
  if (misnamed.length > 0) {
    throw new Error(
      `Found a draft named ${VERSION} with the wrong tag (${misnamed
        .map((release) => release.tag_name || "unknown")
        .join(", ")}); retag or remove it before continuing.`,
    );
  }
}

function releaseNotes({
  changelogPath = CHANGELOG_PATH,
  version = VERSION,
} = {}) {
  return readChangelogSection(changelogPath, version);
}

function patchDraft(release, commit, notes = releaseNotes()) {
  // Keep GitHub's untagged draft placeholder intact until publish. The publish
  // operation supplies the final tag atomically with draft=false.
  const updated = githubApi("PATCH", `/repos/${REPO}/releases/${release.id}`, {
    target_commitish: commit,
    name: VERSION,
    body: notes,
    prerelease: IS_PRERELEASE,
    draft: true,
  });
  if (!updated?.draft) {
    throw new Error(
      `GitHub returned a non-draft release while refreshing ${TAG_NAME}.`,
    );
  }
  return updated;
}

function createDraft(commit, notes = releaseNotes()) {
  return githubApi("POST", `/repos/${REPO}/releases`, {
    tag_name: TAG_NAME,
    target_commitish: commit,
    name: VERSION,
    body: notes,
    draft: true,
    prerelease: IS_PRERELEASE,
  });
}

function ensureDraftRelease() {
  const notes = releaseNotes();
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  assertGitHubCliAuthenticated();
  const commit = currentReleaseCommit();
  const releases = listReleases();
  assertNoMisnamedVersionDrafts(releases);
  const matching = findMatchingReleases(releases);
  const drafts = matching.filter((release) => release.draft);
  if (drafts.length > 1) {
    throw new Error(
      `Multiple draft releases exist for ${TAG_NAME}; resolve duplicates first.`,
    );
  }
  const published = matching.find((release) => !release.draft);
  if (published) {
    throw new Error(
      `Release ${TAG_NAME} already exists as published; refusing to create another draft.`,
    );
  }
  if (drafts.length === 1) {
    assertReleaseTargetsCommit(drafts[0], commit);
    const refreshed = patchDraft(drafts[0], commit, notes);
    assertReleaseTargetsCommit(refreshed, commit);
    console.log(
      `[release:draft] Reused draft ${TAG_NAME} (${refreshed.html_url || refreshed.id}).`,
    );
    return refreshed;
  }
  try {
    const created = createDraft(commit, notes);
    assertReleaseTargetsCommit(created, commit);
    if (!created?.draft || Boolean(created.prerelease) !== IS_PRERELEASE) {
      throw new Error(
        `Created draft ${TAG_NAME} has incorrect draft/prerelease flags.`,
      );
    }
    console.log(
      `[release:draft] Created draft ${TAG_NAME} (${created.html_url || created.id}).`,
    );
    return created;
  } catch (error) {
    // A concurrent release VM may win the create race. Re-fetch and apply the
    // same exact-commit checks rather than blindly uploading to the winner.
    if (error?.statusCode !== 409 && error?.statusCode !== 422) throw error;
    const afterRace = findMatchingReleases(listReleases()).filter(
      (release) => release.draft,
    );
    if (afterRace.length !== 1) throw error;
    assertReleaseTargetsCommit(afterRace[0], commit);
    return patchDraft(afterRace[0], commit, notes);
  }
}

if (require.main === module) {
  try {
    ensureDraftRelease();
  } catch (error) {
    console.error(
      `[release:draft] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

module.exports = {
  BETA_VERSION,
  IS_PRERELEASE,
  TAG_NAME,
  assertNoMisnamedVersionDrafts,
  assertReleaseTargetsCommit,
  ensureDraftRelease,
  findMatchingReleases,
  isExpectedRelease,
  releaseNotes,
};
