import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { iconPaths, normalizeIcons } from "./normalize-icons.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function fixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "arlet-icons-"));
  mkdirSync(iconPaths(root).iconsDir, { recursive: true });
  return root;
}

function seedDesktop(root) {
  const paths = iconPaths(root);
  cpSync(iconPaths(repoRoot).desktopSource, paths.desktopSource);
  return paths;
}

test("icons:normalize is wired as an explicit-only script", () => {
  const script = readFileSync(
    path.join(repoRoot, "scripts/normalize-icons.js"),
    "utf8",
  );
  const scripts = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).scripts;
  assert.equal(scripts["icons:normalize"], "node scripts/normalize-icons.js");
  assert.match(script, /app-icon\.png/);
  assert.match(script, /app-icon-macos\.png/);
  assert.match(script, /icon\.icns/);
  assert.doesNotMatch(script, /icon\.svg/);
  for (const [name, command] of Object.entries(scripts)) {
    if (name === "icons:normalize") continue;
    assert.doesNotMatch(
      String(command),
      /icons:normalize/,
      `${name} must not regenerate committed icons`,
    );
  }
});

test("desktop source exists; macOS source stays optional pre-macOS", () => {
  const { desktopSource } = iconPaths(repoRoot);
  assert.ok(existsSync(desktopSource), "app-icon.png must be committed");
});

test("missing desktop source fails fast", () => {
  const root = fixtureRoot();
  try {
    assert.throws(() => normalizeIcons({ rootDir: root }), /missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS step warns and skips when the padded source is absent", () => {
  const root = fixtureRoot();
  try {
    seedDesktop(root);
    const calls = [];
    const result = normalizeIcons({
      rootDir: root,
      runTauriIcon: (args) => {
        calls.push(args);
      },
    });
    assert.equal(calls.length, 1);
    assert.ok(String(calls[0][0]).endsWith("app-icon.png"));
    assert.deepEqual(result, { macosIcns: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS step copies only icon.icns from staging", () => {
  const root = fixtureRoot();
  try {
    const paths = seedDesktop(root);
    cpSync(paths.desktopSource, paths.macosSource);
    let stagingDir = "";
    let iconCalls = 0;
    const result = normalizeIcons({
      rootDir: root,
      runTauriIcon: (args) => {
        if (!String(args[0]).endsWith("app-icon-macos.png")) return;
        iconCalls += 1;
        const flag = args.indexOf("--output");
        assert.ok(flag >= 0, "macOS run must use a staging output dir");
        stagingDir = args[flag + 1];
        mkdirSync(stagingDir, { recursive: true });
        writeFileSync(path.join(stagingDir, "icon.icns"), "fake-icns");
        writeFileSync(path.join(stagingDir, "icon.ico"), "must-not-copy");
      },
    });
    assert.equal(iconCalls, 1);
    assert.deepEqual(result, { macosIcns: true });
    assert.equal(
      readFileSync(path.join(paths.iconsDir, "icon.icns"), "utf8"),
      "fake-icns",
    );
    assert.ok(!existsSync(stagingDir), "staging dir must be cleaned up");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
