import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  MAX_CHANGELOG_BODY_BYTES,
  extractChangelogSection,
} = require("./changelog.cjs");

test("extracts a stable section, normalizes CRLF, and stops at the next H2", () => {
  const changelog = [
    "# Changelog",
    "",
    "## Changes in `v1.2.3:`",
    "",
    "  - Fixed playback.",
    "",
    "### Details",
    "",
    "- Kept this level-three detail.",
    "",
    "## Changes in `v1.2.4:`",
    "",
    "- A later release.",
  ].join("\r\n");

  assert.equal(
    extractChangelogSection(changelog, "1.2.3"),
    "- Fixed playback.\n\n### Details\n\n- Kept this level-three detail.",
  );
});

test("extracts stable and beta headings by exact version", () => {
  const changelog = [
    "## Changes in `v1.2.3:`",
    "",
    "- Stable notes.",
    "## Changes in `v1.2.3-beta.4:`",
    "",
    "- Beta notes.",
  ].join("\n");

  assert.equal(extractChangelogSection(changelog, "v1.2.3"), "- Stable notes.");
  assert.equal(
    extractChangelogSection(changelog, "1.2.3-beta.4"),
    "- Beta notes.",
  );
});

test("rejects duplicate, missing, and empty exact sections", () => {
  assert.throws(
    () =>
      extractChangelogSection(
        "## Changes in `v1.2.3:`\n- One\n## Changes in `v1.2.3:`\n- Two",
        "1.2.3",
      ),
    /duplicate exact headings/,
  );
  assert.throws(
    () => extractChangelogSection("## Changes in `v1.2.4:`\n- Other", "1.2.3"),
    /missing the exact heading/,
  );
  assert.throws(
    () =>
      extractChangelogSection("## Changes in `v1.2.3:`\n \t\n## Next", "1.2.3"),
    /empty body/,
  );
});

test("rejects a body over the UTF-8 byte limit", () => {
  const body = "😀".repeat(Math.ceil((MAX_CHANGELOG_BODY_BYTES + 1) / 4));
  assert.ok(Buffer.byteLength(body, "utf8") > MAX_CHANGELOG_BODY_BYTES);
  assert.throws(
    () =>
      extractChangelogSection(`## Changes in \`v1.2.3:\`\n${body}`, "1.2.3"),
    /exceeds the 65536-byte UTF-8 limit/,
  );
});

// Beta-callout failure modes: stable rejects the callout while it is commented
// out; stable accepts a live callout; an unterminated <!-- hides a live
// callout from the check; sync leaves the callout live on stable or commented
// on beta; repeated syncs nest or duplicate comment markers (breaking
// sync-version --check); CRLF changelogs are not toggled; sync touches text
// outside the callout.
const { validateChangelogForVersion } = require("./changelog.cjs");
const { syncChangelogForVersion } = await import("./sync-version-helpers.js");

const LIVE_CALLOUT = "> [!NOTE]\n> 🅱️ This is a Beta build.";
const COMMENTED_CALLOUT = `<!-- ${LIVE_CALLOUT} -->`;

function calloutChangelog(callout, version, eol = "\n") {
  return [
    callout,
    "",
    "# ⬇️ Downloads",
    "",
    `**EXE:** [x64](https://github.com/BurntToasters/Arlet/releases/download/v${version}/Arlet-Windows-x64.exe)`,
    "",
    "> Arlet requires Windows 10 or later.",
    "",
    "Arlet! An Apple Music client for Windows built on Tauri V2!",
    "",
    `## Changes in \`v${version}:\``,
    "",
    "- **Fix:** Notes.",
    "",
    "## ℹ️ Release Info",
    "",
    "- **GPG Signed:** Signed.",
    "",
  ]
    .join("\n")
    .replace(/\n/g, eol);
}

test("stable validation ignores a commented-out beta callout only", () => {
  assert.deepEqual(
    validateChangelogForVersion(
      calloutChangelog(COMMENTED_CALLOUT, "1.2.3"),
      "1.2.3",
    ),
    [],
  );
  for (const callout of [LIVE_CALLOUT, `<!-- unterminated\n${LIVE_CALLOUT}`]) {
    assert.match(
      validateChangelogForVersion(
        calloutChangelog(callout, "1.2.3"),
        "1.2.3",
      ).join("\n"),
      /must not include the Beta callout/,
    );
  }
});

test("sync comments the beta callout on stable and restores it on beta", () => {
  for (const eol of ["\n", "\r\n"]) {
    const live = calloutChangelog(LIVE_CALLOUT, "1.2.3", eol);
    const commented = calloutChangelog(COMMENTED_CALLOUT, "1.2.3", eol);

    const stable = syncChangelogForVersion(live, "1.2.3");
    assert.equal(stable, commented);
    assert.equal(syncChangelogForVersion(stable, "1.2.3"), commented);
    assert.deepEqual(validateChangelogForVersion(stable, "1.2.3"), []);

    const beta = syncChangelogForVersion(
      calloutChangelog(COMMENTED_CALLOUT, "1.2.3-beta.1", eol),
      "1.2.3-beta.1",
    );
    assert.equal(beta, calloutChangelog(LIVE_CALLOUT, "1.2.3-beta.1", eol));
    assert.equal(syncChangelogForVersion(beta, "1.2.3-beta.1"), beta);
    assert.deepEqual(validateChangelogForVersion(beta, "1.2.3-beta.1"), []);
  }
});
