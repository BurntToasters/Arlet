import assert from "node:assert/strict";
import test from "node:test";
import {
  REQUIRED_BETA_MANIFEST_NAMES,
  REQUIRED_MANIFEST_NAMES,
  REQUIRED_STABLE_MANIFEST_NAMES,
  buildManifests,
  normalizeUpdaterSignature as normalizeGeneratedUpdaterSignature,
} from "./generate-updater-manifests.js";
import {
  assertDraftReleaseShape,
  assertManifestAssetReferences,
  requiredDraftManifestNames,
} from "./verify-release-draft.js";
import {
  assertReleaseTargetsCommit,
  isTransactionalStagingAssetName,
  normalizeUpdaterSignature,
} from "./gpg-sign.js";
import { validateUpdaterManifest } from "./validate-updater-manifest.js";
import {
  assertManifestReleaseUrls,
  requiredLiveTargets,
} from "./verify-release-published.js";

function fixtureSignature() {
  const packet = Buffer.concat([Buffer.from([0x45, 0x64]), Buffer.alloc(72)]);
  const global = Buffer.alloc(64);
  const inner = [
    "untrusted comment: signature",
    packet.toString("base64"),
    "trusted comment: timestamp:0",
    global.toString("base64"),
  ].join("\n");
  return Buffer.from(inner, "utf8").toString("base64");
}

function installerFixtures(version = "0.1.0") {
  return ["x64", "arm64"].map((arch) => ({
    exe: `Arlet_${version}_${arch}-setup.exe`,
    sig: `${arch}.sig`,
  }));
}

test("live feed expectations contain two stable and four beta endpoints", () => {
  assert.deepEqual(requiredLiveTargets("0.1.0"), [
    "windows-x86_64",
    "windows-aarch64",
    "windows-beta-x86_64",
    "windows-beta-x86_64-nsis",
    "windows-beta-aarch64",
    "windows-beta-aarch64-nsis",
  ]);
  assert.deepEqual(requiredLiveTargets("0.1.0-beta.1"), [
    "windows-beta-x86_64",
    "windows-beta-x86_64-nsis",
    "windows-beta-aarch64",
    "windows-beta-aarch64-nsis",
  ]);
});

test("release channels generate the complete stable/beta Windows matrix", () => {
  const signature = fixtureSignature();
  const manifests = buildManifests(installerFixtures(), {
    version: "0.1.0",
    tag: "v0.1.0",
    notes: "notes",
    pubDate: "2026-09-13T00:00:00.000Z",
    readSig: () => signature,
  });
  assert.deepEqual(
    Object.keys(manifests).sort(),
    [...REQUIRED_MANIFEST_NAMES].sort(),
  );
  for (const name of REQUIRED_MANIFEST_NAMES) {
    const manifest = manifests[name];
    assert.equal(validateUpdaterManifest(manifest, name).length, 0);
    assert.equal(manifest.pub_date, "2026-09-13T00:00:00.000Z");
    assert.equal(Object.hasOwn(manifest, "pubdate"), false);
  }
  for (const name of REQUIRED_STABLE_MANIFEST_NAMES) {
    const keys = Object.keys(manifests[name].platforms).sort();
    const arch = name.includes("aarch64") ? "aarch64" : "x86_64";
    assert.deepEqual(keys, [`windows-${arch}`, `windows-${arch}-nsis`].sort());
  }
  for (const name of REQUIRED_BETA_MANIFEST_NAMES) {
    const keys = Object.keys(manifests[name].platforms).sort();
    const arch = name.includes("aarch64") ? "aarch64" : "x86_64";
    const expectedKeys = name.endsWith("-nsis.json")
      ? [`windows-beta-${arch}-nsis`]
      : [`windows-beta-${arch}`, `windows-beta-${arch}-nsis`].sort();
    assert.deepEqual(keys, expectedKeys);
  }
  assert.doesNotThrow(() =>
    assertManifestReleaseUrls(
      manifests["latest-windows-beta-x86_64.json"],
      "latest-windows-beta-x86_64.json",
      "0.1.0",
    ),
  );
  assert.throws(
    () =>
      assertManifestReleaseUrls(
        manifests["latest-windows-beta-x86_64.json"],
        "latest-windows-beta-x86_64.json",
        "0.2.0",
      ),
    /must reference release v0\.2\.0/,
  );
});

test("manifest generation normalizes raw minisign sidecars", () => {
  const signature = fixtureSignature();
  const rawEnvelope = Buffer.from(signature, "base64").toString("utf8");
  const manifests = buildManifests(installerFixtures(), {
    version: "0.1.0",
    tag: "v0.1.0",
    readSig: () => rawEnvelope,
    pubDate: "2026-09-13T00:00:00.000Z",
  });
  assert.equal(
    manifests["latest-windows-x86_64.json"].platforms["windows-x86_64"]
      .signature,
    signature,
  );
  assert.equal(normalizeGeneratedUpdaterSignature(rawEnvelope), signature);
});

test("manifest validation rejects obsolete pubdate and malformed feed targets", () => {
  const signature = fixtureSignature();
  const base = {
    version: "0.1.0",
    notes: "notes",
    pub_date: "2026-09-13T00:00:00.000Z",
    platforms: {
      "windows-x86_64": {
        url: "https://github.com/BurntToasters/Arlet/releases/download/v0.1.0/Arlet_0.1.0_x64-setup.exe",
        signature,
      },
      "windows-x86_64-nsis": {
        url: "https://github.com/BurntToasters/Arlet/releases/download/v0.1.0/Arlet_0.1.0_x64-setup.exe",
        signature,
      },
    },
  };
  assert.deepEqual(
    validateUpdaterManifest(base, "latest-windows-x86_64.json"),
    [],
  );
  assert.ok(
    validateUpdaterManifest(
      { ...base, pubdate: base.pub_date },
      "latest-windows-x86_64.json",
    ).some((error) => error.includes("obsolete")),
  );
  assert.ok(
    validateUpdaterManifest(
      {
        ...base,
        platforms: {
          ...base.platforms,
          linux: base.platforms["windows-x86_64"],
        },
      },
      "latest-windows-x86_64.json",
    ).some((error) => error.includes("unexpected")),
  );
});

test("draft gate requires both installers, sidecars, and all feed manifests", () => {
  const installers = [
    "Arlet_0.1.0_x64-setup.exe",
    "Arlet_0.1.0_arm64-setup.exe",
  ];
  const assets = [
    ...installers,
    ...installers.flatMap((name) => [`${name}.sig`, `${name}.asc`]),
    "SHA256SUMS",
    "SHA256SUMS.asc",
    ...REQUIRED_MANIFEST_NAMES,
    ...REQUIRED_MANIFEST_NAMES.map((name) => `${name}.asc`),
  ];
  const result = assertDraftReleaseShape({
    release: {
      draft: true,
      prerelease: false,
      tag_name: "v0.1.0",
      target_commitish: "abc",
    },
    assetNames: assets,
    version: "0.1.0",
  });
  assert.deepEqual(result.manifests, requiredDraftManifestNames());
  assert.throws(
    () =>
      assertDraftReleaseShape({
        release: { draft: true, prerelease: false, tag_name: "v0.1.0" },
        assetNames: assets.filter(
          (name) => name !== "latest-windows-beta-x86_64.json",
        ),
        version: "0.1.0",
      }),
    /missing updater manifests/,
  );
});

test("beta synchronization helpers use Arlet staging names and commit fence", () => {
  assert.equal(
    isTransactionalStagingAssetName("arlet-pending-token-feed.json"),
    true,
  );
  assert.equal(
    isTransactionalStagingAssetName("arlet-previous-token-feed.json"),
    true,
  );
  assert.equal(
    isTransactionalStagingAssetName("latest-windows-beta-x86_64.json"),
    false,
  );
  assert.equal(normalizeUpdaterSignature("abc\n"), "abc");
  assert.throws(
    () =>
      assertReleaseTargetsCommit({ target_commitish: "old" }, "new", {
        force: false,
      }),
    /Refusing to upload stale artifacts/,
  );
  assert.doesNotThrow(() =>
    assertReleaseTargetsCommit({ target_commitish: "old" }, "new", {
      force: true,
      log: { warn() {} },
    }),
  );
});

test("draft manifest references require matching artifact and updater sidecar", () => {
  const signature = fixtureSignature();
  const manifest = {
    version: "0.1.0",
    pub_date: "2026-09-13T00:00:00.000Z",
    notes: "notes",
    platforms: {
      "windows-x86_64": {
        url: "https://github.com/BurntToasters/Arlet/releases/download/v0.1.0/Arlet_0.1.0_x64-setup.exe",
        signature,
      },
      "windows-x86_64-nsis": {
        url: "https://github.com/BurntToasters/Arlet/releases/download/v0.1.0/Arlet_0.1.0_x64-setup.exe",
        signature,
      },
    },
  };
  assert.doesNotThrow(() =>
    assertManifestAssetReferences(
      manifest,
      "latest-windows-x86_64.json",
      ["Arlet_0.1.0_x64-setup.exe", "Arlet_0.1.0_x64-setup.exe.sig"],
      { signatures: new Map([["Arlet_0.1.0_x64-setup.exe", signature]]) },
    ),
  );
  assert.throws(
    () =>
      assertManifestAssetReferences(manifest, "latest-windows-x86_64.json", [
        "Arlet_0.1.0_x64-setup.exe",
      ]),
    /missing updater sidecar/,
  );
});
