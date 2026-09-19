import assert from "node:assert/strict";
import {
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
import {
  buildManifests,
  findSignedInstallers,
  platformForInstaller,
} from "./generate-updater-manifests.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function fixtureEnvelope() {
  const packet = Buffer.concat([Buffer.from([0x45, 0x64]), Buffer.alloc(72)]);
  const global = Buffer.alloc(64);
  const inner = [
    "untrusted comment: test signature",
    packet.toString("base64"),
    "trusted comment: timestamp:1",
    global.toString("base64"),
  ].join("\n");
  return Buffer.from(inner, "utf8").toString("base64");
}

function fixtureBundle() {
  const root = mkdtempSync(path.join(tmpdir(), "arlet-manifests-"));
  const nsis = path.join(
    root,
    "src-tauri",
    "target",
    "x",
    "release",
    "bundle",
    "nsis",
  );
  mkdirSync(nsis, { recursive: true });
  const sig = fixtureEnvelope();
  for (const arch of ["x64", "arm64"]) {
    const exe = path.join(nsis, `Arlet_0.1.0_${arch}-setup.exe`);
    writeFileSync(exe, "fake-exe");
    writeFileSync(`${exe}.sig`, sig);
  }
  return root;
}

test("platform mapping covers both Windows arches", () => {
  assert.equal(
    platformForInstaller("Arlet_0.1.0_x64-setup.exe"),
    "windows-x86_64",
  );
  assert.equal(
    platformForInstaller("Arlet_0.1.0_arm64-setup.exe"),
    "windows-aarch64",
  );
  assert.equal(platformForInstaller("Arlet_0.1.0-setup.exe"), null);
});

test("unsigned installers are ignored", () => {
  const root = fixtureBundle();
  try {
    rmSync(path.join(root, "src-tauri"), { recursive: true, force: true });
    mkdirSync(path.join(root, "src-tauri", "target"), { recursive: true });
    writeFileSync(
      path.join(root, "src-tauri", "target", "lonely-setup.exe"),
      "no-sig",
    );
    assert.deepEqual(findSignedInstallers(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifests carry deterministic URLs and valid shape", () => {
  const root = fixtureBundle();
  try {
    const installers = findSignedInstallers(root);
    assert.equal(installers.length, 2);
    const manifests = buildManifests(installers, {
      version: "0.1.0",
      tag: "v0.1.0",
      owner: "BurntToasters",
      repo: "Arlet",
      notes: "notes",
      pubDate: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(Object.keys(manifests).sort(), [
      "latest-windows-aarch64.json",
      "latest-windows-beta-aarch64-nsis.json",
      "latest-windows-beta-aarch64.json",
      "latest-windows-beta-x86_64-nsis.json",
      "latest-windows-beta-x86_64.json",
      "latest-windows-x86_64.json",
    ]);
    for (const manifest of Object.values(manifests)) {
      assert.equal(manifest.version, "0.1.0");
      assert.equal(manifest.pub_date, "2026-01-01T00:00:00.000Z");
      assert.equal(manifest.notes, "notes");
      assert.ok(!Object.hasOwn(manifest, "pubdate"));
    }
    assert.match(
      manifests["latest-windows-x86_64.json"].platforms["windows-x86_64"].url,
      /releases\/download\/v0\.1\.0\/Arlet_0\.1\.0_x64-setup\.exe$/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every stable and beta manifest carries only the selected section", () => {
  const root = fixtureBundle();
  try {
    const installers = findSignedInstallers(root);
    const stable = buildManifests(installers, {
      version: "1.2.3",
      tag: "v1.2.3",
      notes: "- Stable release notes.",
    });
    const beta = buildManifests(installers, {
      version: "1.2.3-beta.1",
      tag: "v1.2.3-beta.1",
      notes: "- Beta release notes.",
    });
    assert.ok(
      Object.values(stable).every(
        (manifest) => manifest.notes === "- Stable release notes.",
      ),
    );
    assert.ok(
      Object.values(beta).every(
        (manifest) => manifest.notes === "- Beta release notes.",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate arch installers fail closed", () => {
  const root = fixtureBundle();
  try {
    const installers = findSignedInstallers(root);
    const doubled = [...installers, installers[0]];
    assert.throws(
      () => buildManifests(doubled, { notes: "notes" }),
      /Duplicate/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("script wiring is consistent", () => {
  const scripts = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).scripts;
  assert.equal(
    scripts["release:updater-manifests"],
    "dotenv -e .env -- node scripts/generate-updater-manifests.js",
  );
  assert.equal(
    scripts["release:sync-beta-manifests"],
    "dotenv -e .env -- node scripts/gpg-sign.js --sync-beta-manifests",
  );
  assert.ok(
    String(scripts["release:win:continue"]).includes(
      "release:updater-manifests",
    ),
    "release:win:continue must generate manifests before signing",
  );
  assert.ok(
    existsSync(path.join(repoRoot, "scripts/generate-updater-manifests.js")),
  );
});
