import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  licenseTextFromTemplates,
  readLicenseTextsFromDir,
} from "./license-texts.js";

// Failure modes: a crate that ships no LICENSE file leaves the app without
// the notice its license requires; legacy "MIT/Apache-2.0" syntax is not
// understood; an AND expression ships only one of the required texts; an
// unknown license silently passes; a README is shipped as the license text.
test("templates cover OR, legacy slash, and AND expressions", () => {
  const mit = licenseTextFromTemplates("MIT/Apache-2.0", "Jane Doe");
  assert.match(mit, /^Copyright \(c\) Jane Doe/u);
  assert.match(mit, /Permission is hereby granted/u);
  assert.doesNotMatch(mit, /Apache License/u);

  const zlib = licenseTextFromTemplates("Zlib OR Apache-2.0 OR MIT", "X");
  assert.match(zlib, /provided 'as-is'/u);

  const both = licenseTextFromTemplates("MIT AND BSD-3-Clause", "Y");
  assert.match(both, /--- MIT ---/u);
  assert.match(both, /--- BSD-3-Clause ---/u);

  assert.equal(licenseTextFromTemplates("Foo-1.0", "Z"), null);
  assert.equal(
    licenseTextFromTemplates("(MIT OR Apache-2.0) AND Unicode-3.0", "Z"),
    null,
  );
  assert.match(licenseTextFromTemplates("MPL-2.0", "M"), /Mozilla Public/u);
  assert.match(licenseTextFromTemplates("BSL-1.0", "B"), /Boost Software/u);
});

test("license files are read, READMEs are not", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "arlet-license-"));
  try {
    writeFileSync(path.join(dir, "README.md"), "# Project\nnot a license");
    assert.equal(readLicenseTextsFromDir(dir), null);
    writeFileSync(
      path.join(dir, "LICENSE_MIT"),
      "Permission is hereby granted",
    );
    writeFileSync(path.join(dir, "LICENSE_APACHE-2.0"), "Apache License");
    const text = readLicenseTextsFromDir(dir);
    assert.match(text, /--- LICENSE_APACHE-2.0 ---/u);
    assert.match(text, /--- LICENSE_MIT ---/u);
    assert.doesNotMatch(text, /not a license/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Failure mode: releases ship with unresolved notices because the
// fail-closed flag exists but the release flow never passes it.
test("release license step is fail-closed", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const pkg = JSON.parse(
    readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "package.json",
      ),
      "utf8",
    ),
  );
  assert.match(
    pkg.scripts["release:licenses"],
    /generate-cargo-licenses\.js --require-complete/u,
  );
});
