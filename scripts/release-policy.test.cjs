"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertStableReleaseOverridesAllowed,
  isStableReleaseVersion,
} = require("./release-policy.cjs");

test("stable release policy rejects signing/upload/mirror overrides", () => {
  assert.equal(isStableReleaseVersion("0.1.0"), true);
  assert.equal(isStableReleaseVersion("0.1.0-beta.1"), false);
  for (const env of [
    { SKIP_WIN_CODESIGN: "1" },
    { FORCE_UPLOAD: "true" },
    { SKIP_RELEASE_MIRROR: "on" },
    { ALLOW_ASSET_REPLACE: "yes" },
    { SKIP_E2E: "1" },
    { ENFORCE_LINUX_X64_PACKAGE_SET: "0" },
  ]) {
    assert.throws(
      () => assertStableReleaseOverridesAllowed(env, "0.1.0"),
      /Stable release 0\.1\.0 refuses/,
    );
  }
});

test("beta releases retain explicitly supported recovery paths", () => {
  assert.doesNotThrow(() =>
    assertStableReleaseOverridesAllowed(
      { FORCE_UPLOAD: "1", SKIP_WIN_CODESIGN: "1" },
      "0.1.0-beta.1",
    ),
  );
});

test("stable release policy rejects non-canonical GitHub destinations", () => {
  assert.throws(
    () =>
      assertStableReleaseOverridesAllowed(
        { GH_REPO_OWNER: "untrusted-owner" },
        "0.1.0",
      ),
    /GH_REPO_OWNER/,
  );
  assert.doesNotThrow(() =>
    assertStableReleaseOverridesAllowed(
      { GH_REPO_OWNER: "BurntToasters", GH_REPO_NAME: "Arlet" },
      "0.1.0",
    ),
  );
  assert.throws(
    () =>
      assertStableReleaseOverridesAllowed(
        {
          RELEASE_DOWNLOAD_BASE_URL:
            "https://github.com/untrusted/Arlet/releases/download/v0.1.0",
        },
        "0.1.0",
      ),
    /RELEASE_DOWNLOAD_BASE_URL/,
  );
  assert.throws(
    () =>
      assertStableReleaseOverridesAllowed(
        { UPDATER_LIVE_BASE_URL: "https://feeds.example.invalid/latest" },
        "0.1.0",
      ),
    /UPDATER_LIVE_BASE_URL/,
  );
});
