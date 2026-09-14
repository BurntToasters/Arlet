import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  copyReleaseEntryToMirror,
  finalizeReleaseAssets,
  getAfterPackLocation,
  getReleaseEntries,
  isBetaReleaseVersion,
  resolveMirrorPaths,
  shouldSkipBetaMirror,
} from "./post-release-assets.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function scratch() {
  // Fake repo root in temp so the outside-the-repository guard is testable.
  const repo = mkdtempSync(path.join(tmpdir(), "arlet-repo-"));
  const releaseDir = path.join(repo, "release");
  mkdirSync(releaseDir, { recursive: true });
  const archive = mkdtempSync(path.join(tmpdir(), "arlet-archive-"));
  return { repo, releaseDir, archive };
}

test("beta detection and mirror skip policy", () => {
  assert.equal(isBetaReleaseVersion("0.1.0-beta.1"), true);
  assert.equal(isBetaReleaseVersion("0.1.0"), false);
  assert.equal(shouldSkipBetaMirror({}, "0.1.0-beta.1"), true);
  assert.equal(
    shouldSkipBetaMirror({ OVERRIDE_BETA_MIRROR_SKIP: "1" }, "0.1.0-beta.1"),
    false,
  );
  assert.equal(shouldSkipBetaMirror({}, "0.1.0"), false);
  assert.equal(getAfterPackLocation({ AFTER_PACK_LOC: "  x " }), "x");
  assert.equal(getAfterPackLocation({}), "");
});

test("mirror destination guards", () => {
  const { repo, releaseDir, archive } = scratch();
  try {
    writeFileSync(path.join(releaseDir, "a.txt"), "a");
    assert.throws(
      () => resolveMirrorPaths(releaseDir, "", repo),
      /AFTER_PACK_LOC is empty/,
    );
    assert.throws(
      () => resolveMirrorPaths(releaseDir, "relative/path", repo),
      /absolute path/,
    );
    assert.throws(
      () => resolveMirrorPaths(releaseDir, releaseDir, repo),
      /cannot be the release directory/,
    );
    assert.throws(
      () => resolveMirrorPaths(releaseDir, path.join(repo, "inside"), repo),
      /outside the repository/,
    );
    // A release dir outside the repo reaches the inside-release guard.
    const outer = mkdtempSync(path.join(tmpdir(), "arlet-release-"));
    try {
      assert.throws(
        () => resolveMirrorPaths(outer, path.join(outer, "nested"), repo),
        /inside the release directory/,
      );
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
    const ok = resolveMirrorPaths(releaseDir, archive, repo);
    assert.equal(ok.resolvedReleaseDir, path.resolve(releaseDir));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(archive, { recursive: true, force: true });
  }
});

test("dotfiles are never mirrored; build markers are cleaned", () => {
  const { repo, releaseDir, archive } = scratch();
  try {
    writeFileSync(path.join(releaseDir, ".build-session.json"), "{}");
    writeFileSync(path.join(releaseDir, "app.exe"), "exe-bytes");
    assert.deepEqual(getReleaseEntries(releaseDir), ["app.exe"]);
    const result = finalizeReleaseAssets({
      releaseDir,
      env: { AFTER_PACK_LOC: archive },
      logger: { log() {}, error() {} },
      version: "0.1.0",
    });
    assert.equal(result.mirrored, true);
    assert.equal(result.copiedEntries, 1);
    assert.equal(
      readFileSync(path.join(archive, "app.exe"), "utf8"),
      "exe-bytes",
    );
    assert.ok(!existsSync(path.join(archive, ".build-session.json")));
    assert.ok(!existsSync(path.join(releaseDir, ".build-session.json")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(archive, { recursive: true, force: true });
  }
});

test("existing archive entries are replaced atomically", () => {
  const { repo, releaseDir, archive } = scratch();
  try {
    writeFileSync(path.join(releaseDir, "a.txt"), "new");
    writeFileSync(path.join(archive, "a.txt"), "old");
    copyReleaseEntryToMirror(
      path.join(releaseDir, "a.txt"),
      path.join(archive, "a.txt"),
    );
    assert.equal(readFileSync(path.join(archive, "a.txt"), "utf8"), "new");
    assert.deepEqual(
      readdirSync(archive).filter((n) => n.includes("arlet-mirror")),
      [],
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(archive, { recursive: true, force: true });
  }
});

test("no stray staging files remain beside the destination", () => {
  const { repo, releaseDir, archive } = scratch();
  try {
    writeFileSync(path.join(releaseDir, "b.bin"), "bytes");
    copyReleaseEntryToMirror(
      path.join(releaseDir, "b.bin"),
      path.join(archive, "b.bin"),
    );
    assert.deepEqual(readdirSync(archive), ["b.bin"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(archive, { recursive: true, force: true });
  }
});

test("package wiring keeps mirror before reset", () => {
  const scripts = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).scripts;
  assert.equal(
    scripts["release:mirror"],
    "dotenv -e .env -- node scripts/finalize-release-assets.js",
  );
  assert.match(
    String(scripts["release:finalize"]),
    /release:mirror.*git fetch.*git reset --hard.*git clean -fd/,
  );
  assert.match(
    String(scripts["release:win:continue"]),
    /release:sign:gpg.*release:finalize/,
  );
  for (const file of [
    "scripts/post-release-assets.js",
    "scripts/finalize-release-assets.js",
  ]) {
    assert.ok(existsSync(path.join(repoRoot, file)));
  }
});

test("release preparation requires the built frontend smoke gate", () => {
  const scripts = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).scripts;
  assert.match(
    String(scripts["release:prepare"]),
    /test:all -- --require-clean-proof/,
  );
  assert.doesNotMatch(String(scripts["release:prepare"]), /skip-e2e/);
});
