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

function bclsChangelog(tag, sections) {
  return [
    "# ⬇️ Downloads",
    "",
    `**EXE:** [x64](https://github.com/BurntToasters/Arlet/releases/download/${tag}/Arlet_x64-setup.exe)`,
    "",
    ...sections,
    "## ℹ️ Release Info",
    "",
    "- **GPG Signed:** Signed.",
  ].join("\r\n");
}

test("draft release notes are the full BCLS changelog for a stable version", () => {
  const contents = bclsChangelog("v1.2.3", [
    "## Changes in `v1.2.3:`",
    "",
    "- **UI:** Stable release notes.",
    "",
    "## Changes in `v1.2.2:`",
    "",
    "- **UI:** Carried-forward notes.",
    "",
  ]);
  const fixture = temporaryChangelog(contents);
  try {
    assert.equal(
      releaseNotes({ changelogPath: fixture.file, version: "1.2.3" }),
      `${contents.replace(/\r\n/g, "\n").trim()}\n`,
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("draft release notes accept a beta version with its own section and links", () => {
  const fixture = temporaryChangelog(
    bclsChangelog("v1.2.3-beta.1", [
      "> [!NOTE]",
      "> 🅱️ This is a Beta build.",
      "",
      "## Changes in `v1.2.3-beta.1:`",
      "",
      "- **Ver:** Bumped version to `v1.2.3`.",
      "",
    ]),
  );
  try {
    assert.match(
      releaseNotes({ changelogPath: fixture.file, version: "1.2.3-beta.1" }),
      /## ℹ️ Release Info/,
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("draft release notes reject a changelog without the version heading or links", () => {
  const fixture = temporaryChangelog(
    bclsChangelog("v1.2.2", [
      "## Changes in `v1.2.2:`",
      "",
      "- **UI:** Older notes.",
      "",
    ]),
  );
  try {
    assert.throws(
      () => releaseNotes({ changelogPath: fixture.file, version: "1.2.3" }),
      /missing the exact heading '## Changes in `v1\.2\.3:`'[\s\S]*\/download\/v1\.2\.3\//,
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
