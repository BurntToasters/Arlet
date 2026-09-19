"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { releaseNotes } = require("./ensure-draft-release.cjs");

function temporaryChangelog(contents) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arlet-release-notes-"),
  );
  const file = path.join(directory, "CHANGELOG.md");
  fs.writeFileSync(file, contents, "utf8");
  return { directory, file };
}

test("draft release notes use only the selected stable section", () => {
  const fixture = temporaryChangelog(
    [
      "## Changes in `v1.2.3`",
      "",
      "- Stable release notes.",
      "## Changes in `v1.2.4`",
      "",
      "- Excluded later notes.",
    ].join("\n"),
  );
  try {
    assert.equal(
      releaseNotes({ changelogPath: fixture.file, version: "1.2.3" }),
      "- Stable release notes.",
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("draft release notes use only the selected beta section", () => {
  const fixture = temporaryChangelog(
    [
      "## Changes in `v1.2.3`",
      "",
      "- Stable notes.",
      "## Changes in `v1.2.3-beta.1`",
      "",
      "- Beta release notes.",
      "## Changes in `v1.2.4`",
      "",
      "- Excluded later notes.",
    ].join("\n"),
  );
  try {
    assert.equal(
      releaseNotes({ changelogPath: fixture.file, version: "1.2.3-beta.1" }),
      "- Beta release notes.",
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
