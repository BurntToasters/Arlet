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
    "## Changes in `v1.2.3`",
    "",
    "  - Fixed playback.",
    "",
    "### Details",
    "",
    "- Kept this level-three detail.",
    "",
    "## Changes in `v1.2.4`",
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
    "## Changes in `v1.2.3`",
    "",
    "- Stable notes.",
    "## Changes in `v1.2.3-beta.4`",
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
        "## Changes in `v1.2.3`\n- One\n## Changes in `v1.2.3`\n- Two",
        "1.2.3",
      ),
    /duplicate exact headings/,
  );
  assert.throws(
    () => extractChangelogSection("## Changes in `v1.2.4`\n- Other", "1.2.3"),
    /missing the exact heading/,
  );
  assert.throws(
    () =>
      extractChangelogSection("## Changes in `v1.2.3`\n \t\n## Next", "1.2.3"),
    /empty body/,
  );
});

test("rejects a body over the UTF-8 byte limit", () => {
  const body = "😀".repeat(Math.ceil((MAX_CHANGELOG_BODY_BYTES + 1) / 4));
  assert.ok(Buffer.byteLength(body, "utf8") > MAX_CHANGELOG_BODY_BYTES);
  assert.throws(
    () => extractChangelogSection(`## Changes in \`v1.2.3\`\n${body}`, "1.2.3"),
    /exceeds the 65536-byte UTF-8 limit/,
  );
});
