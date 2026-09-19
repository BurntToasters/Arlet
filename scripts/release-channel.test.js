import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
  draftVerificationDownloadNames,
  requiredDraftManifestNames,
} from "./verify-release-draft.js";
import {
  assertReleaseTargetsCommit,
  assertBetaManifestVersionsMonotonic,
  isTransactionalStagingAssetName,
  normalizeUpdaterSignature,
  parseReleaseVersion,
  replaceReleaseAssetsTransactionally,
  validateLiveBetaManifestVersions,
  withBetaManifestSyncLock,
} from "./gpg-sign.js";
import { assertStableReleaseOverridesAllowed } from "./release-policy.cjs";
import {
  verifyChecksums,
  verifyDetachedGpgSignature,
} from "./verify-release-draft.js";
import { validateUpdaterManifest } from "./validate-updater-manifest.js";
import {
  assertManifestReleaseUrls,
  collectManifestArtifactRefs,
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
    notes: "notes",
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

test("manifest target bindings reject cross-architecture and unexpected installers", () => {
  const signature = fixtureSignature();
  const base = {
    version: "0.1.0",
    pub_date: "2026-09-13T00:00:00.000Z",
    notes: "notes",
    platforms: {
      "windows-x86_64": {
        url: "https://github.com/BurntToasters/Arlet/releases/download/v0.1.0/Arlet_0.1.0_arm64-setup.exe",
        signature,
      },
      "windows-x86_64-nsis": {
        url: "https://github.com/BurntToasters/Arlet/releases/download/v0.1.0/Arlet_0.1.0_arm64-setup.exe",
        signature,
      },
    },
  };
  assert.ok(
    validateUpdaterManifest(base, "latest-windows-x86_64.json").some((error) =>
      error.includes("must reference Arlet_0.1.0_x64-setup.exe"),
    ),
  );
  assert.throws(
    () =>
      assertManifestAssetReferences(
        base,
        "latest-windows-x86_64.json",
        ["Arlet_0.1.0_arm64-setup.exe", "Arlet_0.1.0_arm64-setup.exe.sig"],
        {
          signatures: new Map([["Arlet_0.1.0_arm64-setup.exe", signature]]),
        },
      ),
    /must reference Arlet_0.1.0_x64-setup\.exe/,
  );
  assert.throws(
    () =>
      collectManifestArtifactRefs([
        {
          ...base,
          platforms: Object.fromEntries(
            Object.entries(base.platforms).map(([target, entry]) => [
              target,
              {
                ...entry,
                url: entry.url.replace(
                  "Arlet_0.1.0_arm64-setup.exe",
                  "Arlet_0.1.0_x86-setup.exe",
                ),
              },
            ]),
          ),
        },
      ]),
    /must reference Arlet_0.1.0_x64-setup\.exe/,
  );
});

test("draft verification download plan contains each path once for sidecar reuse", () => {
  const installers = [
    "Arlet_0.1.0_x64-setup.exe",
    "Arlet_0.1.0_arm64-setup.exe",
  ];
  const plan = draftVerificationDownloadNames({
    installers,
    manifests: [...REQUIRED_MANIFEST_NAMES],
  });
  assert.equal(new Set(plan).size, plan.length);
  for (const installer of installers) {
    assert.equal(plan.filter((name) => name === `${installer}.sig`).length, 1);
  }
  assert.ok(plan.includes("SHA256SUMS.asc"));
});

test("beta live manifests must agree and candidate versions are monotonic", () => {
  const signature = fixtureSignature();
  const generatedCurrent = buildManifests(installerFixtures("0.1.0-beta.1"), {
    version: "0.1.0-beta.1",
    tag: "v0.1.0-beta.1",
    notes: "notes",
    pubDate: "2026-09-13T00:00:00.000Z",
    readSig: () => signature,
  });
  const current = Object.fromEntries(
    REQUIRED_BETA_MANIFEST_NAMES.map((name) => [name, generatedCurrent[name]]),
  );
  assert.deepEqual(validateLiveBetaManifestVersions(current), [
    "0.1.0-beta.1",
    "0.1.0-beta.1",
    "0.1.0-beta.1",
    "0.1.0-beta.1",
  ]);
  assert.equal(parseReleaseVersion("0.1.0-beta.2").beta, 2);
  assert.doesNotThrow(() =>
    assertBetaManifestVersionsMonotonic("0.1.0-beta.1", [
      "0.1.0-beta.1",
      "0.1.0-beta.1",
      "0.1.0-beta.1",
      "0.1.0-beta.1",
    ]),
  );
  assert.doesNotThrow(() =>
    assertBetaManifestVersionsMonotonic("0.1.0-beta.2", [
      "0.1.0-beta.1",
      "0.1.0-beta.1",
      "0.1.0-beta.1",
      "0.1.0-beta.1",
    ]),
  );
  assert.doesNotThrow(() =>
    assertBetaManifestVersionsMonotonic("0.1.0-beta.10", [
      "0.1.0-beta.9",
      "0.1.0-beta.9",
      "0.1.0-beta.9",
      "0.1.0-beta.9",
    ]),
  );
  assert.throws(
    () =>
      assertBetaManifestVersionsMonotonic("0.1.0-beta.0", [
        "0.1.0-beta.1",
        "0.1.0-beta.1",
        "0.1.0-beta.1",
        "0.1.0-beta.1",
      ]),
    /older than the live beta/,
  );

  const generatedNewer = buildManifests(installerFixtures("0.1.0-beta.2"), {
    version: "0.1.0-beta.2",
    tag: "v0.1.0-beta.2",
    notes: "notes",
    pubDate: "2026-09-13T00:00:00.000Z",
    readSig: () => signature,
  });
  const newer = Object.fromEntries(
    REQUIRED_BETA_MANIFEST_NAMES.map((name) => [name, generatedNewer[name]]),
  );
  const inconsistent = { ...current };
  inconsistent[REQUIRED_BETA_MANIFEST_NAMES[0]] =
    newer[REQUIRED_BETA_MANIFEST_NAMES[0]];
  assert.throws(
    () => validateLiveBetaManifestVersions(inconsistent),
    /disagree on version/,
  );
  const malformedVersion = { ...current };
  malformedVersion[REQUIRED_BETA_MANIFEST_NAMES[1]] = {
    ...current[REQUIRED_BETA_MANIFEST_NAMES[1]],
    version: "not-semver",
  };
  assert.throws(
    () => validateLiveBetaManifestVersions(malformedVersion),
    /is invalid/,
  );
  const malformed = { ...current };
  malformed[REQUIRED_BETA_MANIFEST_NAMES[1]] = "not json";
  assert.throws(
    () => validateLiveBetaManifestVersions(malformed),
    /not valid JSON/,
  );
});

test("draft gate requires both installers, sidecars, and all feed manifests", () => {
  const installers = [
    "Arlet_0.1.0_x64-setup.exe",
    "Arlet_0.1.0_arm64-setup.exe",
  ];
  const assets = [
    ...installers,
    ...installers.flatMap((name) => [
      `${name}.sig`,
      `${name}.asc`,
      `${name}.sig.asc`,
    ]),
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
  assert.throws(
    () =>
      assertDraftReleaseShape({
        release: { draft: true, prerelease: false, tag_name: "v0.1.0" },
        assetNames: [...assets, "unexpected-release.bin"],
        version: "0.1.0",
      }),
    /unknown release asset/,
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

test("beta manifest publication is deferred until the GitHub publish response", () => {
  const signer = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "gpg-sign.js"),
    "utf8",
  );
  const publisher = fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "publish-release.cjs",
    ),
    "utf8",
  );
  assert.doesNotMatch(
    signer,
    /await uploadAll\(release, staged\);\s*if \(IS_PRERELEASE\)/,
  );
  assert.match(publisher, /await syncBetaManifestsAfterPublish\(\)/);
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

test("transactional GitHub replacement rolls back every swapped asset", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arlet-release-transaction-test-"),
  );
  try {
    const first = path.join(directory, "first.json");
    const second = path.join(directory, "second.json");
    fs.writeFileSync(first, "new first");
    fs.writeFileSync(second, "new second");
    const assets = [
      { id: 1, name: "first.json" },
      { id: 2, name: "second.json" },
    ];
    const calls = [];
    let nextId = 10;
    let failRenameId = null;
    const listAssets = () => assets.map((asset) => ({ ...asset }));
    const upload = async (_release, stagedPath) => {
      const uploaded = { id: nextId++, name: path.basename(stagedPath) };
      assets.push(uploaded);
      if (uploaded.name.endsWith("second.json")) failRenameId = uploaded.id;
      calls.push(["upload", uploaded.name]);
      return uploaded;
    };
    const rename = async (id, name) => {
      calls.push(["rename", id, name]);
      if (id === failRenameId && name === "second.json") {
        throw new Error("simulated rename conflict");
      }
      const asset = assets.find((candidate) => candidate.id === id);
      if (!asset) throw new Error(`missing asset ${id}`);
      asset.name = name;
      return asset;
    };
    const remove = async (id) => {
      calls.push(["delete", id]);
      const index = assets.findIndex((candidate) => candidate.id === id);
      if (index >= 0) assets.splice(index, 1);
    };

    await assert.rejects(
      replaceReleaseAssetsTransactionally({ id: 7 }, [first, second], {
        listAssets,
        upload,
        rename,
        remove,
      }),
      /simulated rename conflict/,
    );
    assert.deepEqual(
      assets.sort((left, right) => left.id - right.id),
      [
        { id: 1, name: "first.json" },
        { id: 2, name: "second.json" },
      ],
    );
    assert.ok(calls.some(([kind]) => kind === "delete"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("transactional replacement keeps committed live names when cleanup loses the lock", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arlet-release-transaction-commit-test-"),
  );
  try {
    const first = path.join(directory, "first.json");
    const second = path.join(directory, "second.json");
    fs.writeFileSync(first, "new first");
    fs.writeFileSync(second, "new second");
    const assets = [
      { id: 1, name: "first.json" },
      { id: 2, name: "second.json" },
    ];
    let nextId = 10;
    let lockLost = false;
    const listAssets = () => assets.map((asset) => ({ ...asset }));
    const upload = async (_release, stagedPath) => {
      const uploaded = { id: nextId++, name: path.basename(stagedPath) };
      assets.push(uploaded);
      return uploaded;
    };
    const rename = async (id, name) => {
      const asset = assets.find((candidate) => candidate.id === id);
      if (!asset) throw new Error(`missing asset ${id}`);
      asset.name = name;
      return asset;
    };
    const remove = async (id) => {
      if (id === 1) {
        lockLost = true;
        throw new Error("lock lost during committed cleanup");
      }
      const index = assets.findIndex((candidate) => candidate.id === id);
      if (index >= 0) assets.splice(index, 1);
    };

    await replaceReleaseAssetsTransactionally({ id: 7 }, [first, second], {
      listAssets,
      upload,
      rename,
      remove,
    });
    assert.equal(lockLost, true);
    assert.deepEqual(
      assets
        .filter(
          (asset) =>
            asset.name === "first.json" || asset.name === "second.json",
        )
        .sort((left, right) => left.id - right.id)
        .map((asset) => asset.name),
      ["first.json", "second.json"],
    );
    assert.ok(
      assets.some(
        (asset) => asset.id === 1 && asset.name.startsWith("arlet-previous-"),
      ),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("beta manifest lock retries conflicts and releases only its own lock", async () => {
  const lock = { id: 20, name: "arlet-beta-manifest-sync-lock" };
  const assets = [];
  let attempts = 0;
  const upload = async (_release, lockPath) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("HTTP 409");
      error.statusCode = 409;
      throw error;
    }
    assets.push(lock);
    assert.match(path.basename(lockPath), /^arlet-beta-manifest-sync-lock$/);
    return lock;
  };
  await withBetaManifestSyncLock(
    { id: 9 },
    async ({ assertStillHeld }) => {
      await assertStillHeld();
      return "ok";
    },
    {
      listAssets: () => assets,
      upload,
      remove: async (id) => {
        const index = assets.findIndex((asset) => asset.id === id);
        if (index >= 0) assets.splice(index, 1);
      },
      retries: 2,
      delayMs: 0,
    },
  );
  assert.equal(attempts, 2);
  assert.deepEqual(assets, []);
});

test("beta manifest lock refuses to remove a lock stolen during an operation", async () => {
  const own = { id: 30, name: "arlet-beta-manifest-sync-lock" };
  const stolen = { id: 31, name: "arlet-beta-manifest-sync-lock" };
  const assets = [];
  await assert.rejects(
    withBetaManifestSyncLock(
      { id: 9 },
      async () => {
        assets.splice(0, assets.length, stolen);
        throw new Error("operation failed");
      },
      {
        listAssets: () => assets,
        upload: async () => {
          assets.push(own);
          return own;
        },
        remove: async (id) => {
          const index = assets.findIndex((asset) => asset.id === id);
          if (index >= 0) assets.splice(index, 1);
        },
        retries: 1,
        delayMs: 0,
      },
    ),
    /operation failed/,
  );
  assert.deepEqual(assets, [stolen]);
});

test("checksum validation requires exact entries and GPG verifier fails closed", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arlet-checksum-test-"),
  );
  try {
    const file = path.join(directory, "artifact.exe");
    fs.writeFileSync(file, "artifact");
    const digest = crypto.createHash("sha256").update("artifact").digest("hex");
    const downloaded = new Map([["artifact.exe", file]]);
    assert.doesNotThrow(() =>
      verifyChecksums(`${digest}  artifact.exe\n`, downloaded, [
        "artifact.exe",
      ]),
    );
    assert.throws(
      () =>
        verifyChecksums(
          `${digest}  artifact.exe\n${digest}  artifact.exe\n`,
          downloaded,
          ["artifact.exe"],
        ),
      /duplicate entry/,
    );
    assert.throws(
      () =>
        verifyChecksums(`${digest}  artifact.exe\n`, downloaded, [
          "artifact.exe",
          "artifact.exe",
        ]),
      /duplicate intended artifacts/,
    );
    assert.throws(
      () =>
        verifyChecksums(`${digest}  unknown.exe\n`, downloaded, [
          "artifact.exe",
        ]),
      /unknown artifact/,
    );
    assert.throws(
      () => verifyChecksums("", downloaded, ["artifact.exe"]),
      /empty/,
    );
    assert.throws(
      () =>
        verifyChecksums(`${digest}  artifact.exe\n\n`, downloaded, [
          "artifact.exe",
        ]),
      /empty entry/,
    );
    assert.throws(
      () =>
        verifyDetachedGpgSignature("missing.asc", file, {
          runner: () => ({ status: 2, stderr: "bad signature" }),
        }),
      /SHA256SUMS\.asc GPG signature verification failed/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("stable release policy remains enforced by direct release helpers", () => {
  assert.throws(
    () => assertStableReleaseOverridesAllowed({ FORCE_UPLOAD: "1" }, "0.1.0"),
    /FORCE_UPLOAD/,
  );
});
