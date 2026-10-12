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

// Up to three spaces of indent, as in CommonMark and the in-app renderer.
function isLevelTwoHeading(line) {
  return /^ {0,3}##(?:[ \t]+|$)/.test(line);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Marks each line that sits inside a fenced code block (fences included).
 * A `## ` line inside a code sample is content, not a section boundary.
 */
function fencedLines(lines) {
  const fenced = new Array(lines.length).fill(false);
  let marker;
  for (let index = 0; index < lines.length; index += 1) {
    const match = FENCE.exec(lines[index]);
    if (marker) {
      fenced[index] = true;
      const closing = match?.[1];
      if (
        closing &&
        closing[0] === marker[0] &&
        closing.length >= marker.length &&
        lines[index].trim() === closing
      ) {
        marker = undefined;
      }
    } else if (match) {
      marker = match[1];
      fenced[index] = true;
    }
  }
  return fenced;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * BCLS heading: `v` prefix and trailing colon both inside the backticks.
 * A beta may carry an RC marker before the colon: `vX.Y.Z-beta.N (RC2):`.
 * Trailing whitespace is ignored so an invisible space cannot hide it.
 */
function sectionHeadingPattern(normalizedVersion) {
  const rc = normalizedVersion.includes("-beta.") ? "(?: \\(RC\\d*\\))?" : "";
  return new RegExp(
    `^ {0,3}## Changes in \`v${escapeRegExp(normalizedVersion)}${rc}:\`[ \\t]*$`,
  );
}

function extractChangelogSection(contents, version) {
  const normalized = String(contents ?? "").replace(/\r\n?/g, "\n");
  const normalizedVersion = normalizeReleaseVersion(version);
  const heading = `## Changes in \`v${normalizedVersion}:\``;
  const pattern = sectionHeadingPattern(normalizedVersion);
  const lines = normalized.split("\n");
  const fenced = fencedLines(lines);
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!fenced[index] && pattern.test(lines[index])) matches.push(index);
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
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (!fenced[index] && isLevelTwoHeading(lines[index])) {
      end = index;
      break;
    }
  }
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
  // Every download link must point at this release; one stale row in the
  // downloads table would otherwise pass next to a correct one.
  const downloadLinks = body.match(/\/releases\/download\/[^\s)"'<>]+/g) ?? [];
  if (downloadLinks.length === 0) {
    errors.push(`CHANGELOG.md download links must include /download/${tag}/.`);
  }
  for (const link of new Set(downloadLinks)) {
    if (!link.startsWith(`/releases/download/${tag}/`)) {
      errors.push(
        `CHANGELOG.md download link ${link} must include /download/${tag}/.`,
      );
    }
  }
  if (/\(add release notes\)/.test(body)) {
    errors.push("CHANGELOG.md still has placeholder notes.");
  }
  if (!normalizedVersion.includes("-beta.")) {
    if (/this is a beta build/i.test(body)) {
      errors.push("Stable CHANGELOG.md must not include the Beta callout.");
    }
    if (/\/v\d+\.\d+\.\d+-beta\.\d+/i.test(body)) {
      errors.push("Stable CHANGELOG.md still has prerelease links.");
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
