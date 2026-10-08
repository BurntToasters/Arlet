"use strict";

const fs = require("node:fs");

const MAX_CHANGELOG_BODY_BYTES = 64 * 1024;
// GitHub rejects release bodies longer than 125,000 characters.
const MAX_RELEASE_BODY_CHARS = 125_000;
const NUMERIC = "(?:0|[1-9]\\d*)";
const RELEASE_VERSION = new RegExp(
  `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-beta\\.${NUMERIC})?$`,
);

function normalizeReleaseVersion(version) {
  const raw = String(version ?? "").trim();
  const normalized = raw.startsWith("v") ? raw.slice(1) : raw;
  if (!RELEASE_VERSION.test(normalized)) {
    throw new Error(
      `Unsupported release version '${version}'; Arlet releases use beta or stable only.`,
    );
  }
  return normalized;
}

function isLevelTwoHeading(line) {
  return /^##(?:[ \t]+|$)/.test(line);
}

function extractChangelogSection(contents, version) {
  const normalized = String(contents ?? "").replace(/\r\n?/g, "\n");
  const normalizedVersion = normalizeReleaseVersion(version);
  // BCLS heading: `v` prefix and trailing colon both inside the backticks.
  const heading = `## Changes in \`v${normalizedVersion}:\``;
  const lines = normalized.split("\n");
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === heading) matches.push(index);
  }

  if (matches.length === 0) {
    throw new Error(`CHANGELOG.md is missing the exact heading '${heading}'.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `CHANGELOG.md contains duplicate exact headings for v${normalizedVersion}.`,
    );
  }

  const start = matches[0] + 1;
  const boundaryOffset = lines.slice(start).findIndex(isLevelTwoHeading);
  const end = boundaryOffset === -1 ? lines.length : start + boundaryOffset;
  const body = lines.slice(start, end).join("\n").trim();
  if (!body) {
    throw new Error(`CHANGELOG.md section '${heading}' has an empty body.`);
  }

  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > MAX_CHANGELOG_BODY_BYTES) {
    throw new Error(
      `CHANGELOG.md section '${heading}' exceeds the ${MAX_CHANGELOG_BODY_BYTES}-byte UTF-8 limit (got ${bodyBytes}).`,
    );
  }
  return body;
}

function readChangelogSection(changelogPath, version) {
  return extractChangelogSection(
    fs.readFileSync(changelogPath, "utf8"),
    version,
  );
}

function normalizeChangelog(contents) {
  return `${String(contents ?? "")
    .replace(/\r\n?/g, "\n")
    .trim()}\n`;
}

/** Zinnia/BCLS release-body checks; the section checks run first. */
function validateChangelogForVersion(contents, version) {
  const normalizedVersion = normalizeReleaseVersion(version);
  const tag = `v${normalizedVersion}`;
  const body = normalizeChangelog(contents);
  const errors = [];
  try {
    extractChangelogSection(body, normalizedVersion);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (!body.includes(`/download/${tag}/`)) {
    errors.push(`CHANGELOG.md download links must include /download/${tag}/.`);
  }
  if (/\(add release notes\)/.test(body)) {
    errors.push("CHANGELOG.md still has placeholder notes.");
  }
  if (!normalizedVersion.includes("-beta.")) {
    if (/This is a Beta build/.test(body)) {
      errors.push("Stable CHANGELOG.md must not include the Beta callout.");
    }
    if (/\/download\/v\d+\.\d+\.\d+-beta\./.test(body)) {
      errors.push("Stable CHANGELOG.md still has prerelease download URLs.");
    }
  }
  if (body.length > MAX_RELEASE_BODY_CHARS) {
    errors.push(
      `CHANGELOG.md exceeds GitHub's ${MAX_RELEASE_BODY_CHARS}-character release body limit (got ${body.length}).`,
    );
  }
  return errors;
}

/** GitHub release body: the whole BCLS CHANGELOG.md, validated for `version`. */
function changelogReleaseBody(contents, version) {
  const errors = validateChangelogForVersion(contents, version);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return normalizeChangelog(contents);
}

function readChangelogReleaseBody(changelogPath, version) {
  return changelogReleaseBody(fs.readFileSync(changelogPath, "utf8"), version);
}

module.exports = {
  MAX_CHANGELOG_BODY_BYTES,
  MAX_RELEASE_BODY_CHARS,
  changelogReleaseBody,
  readChangelogReleaseBody,
  validateChangelogForVersion,
  RELEASE_VERSION,
  extractChangelogSection,
  normalizeReleaseVersion,
  readChangelogSection,
};
