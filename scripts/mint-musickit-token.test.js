import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertP8OutsideRepo,
  MAX_TTL_SECONDS,
  mintDeveloperTokenIntoEnv,
  mintMusicKitDeveloperToken,
  mintReleaseTokenIntoEnv,
  parseTokenOrigins,
  TOKEN_ENV_KEY,
  upsertEnvKey,
} from "./mint-musickit-token.js";

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "arlet-mint-"));
}

function testKeyPair() {
  return generateKeyPairSync("ec", { namedCurve: "P-256" });
}

test("mints an ES256 MusicKit JWT that verifies", () => {
  const { publicKey, privateKey } = testKeyPair();
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const nowMs = 1_700_000_000_000;
  const { token, iat, exp } = mintMusicKitDeveloperToken({
    teamId: "ABCDE12345",
    keyId: "KEYID12345",
    privateKeyPem: pem,
    nowMs,
    ttlSeconds: 3600,
  });
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  const header = JSON.parse(
    Buffer.from(parts[0], "base64url").toString("utf8"),
  );
  const payload = JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf8"),
  );
  assert.equal(header.alg, "ES256");
  assert.equal(header.kid, "KEYID12345");
  assert.equal(payload.iss, "ABCDE12345");
  assert.equal(iat, 1_700_000_000);
  assert.equal(exp, 1_700_000_000 + 3600);
  const verify = createVerify("SHA256");
  verify.update(`${parts[0]}.${parts[1]}`);
  assert.equal(
    verify.verify(
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(parts[2], "base64url"),
    ),
    true,
  );
});

test("rejects a .p8 path inside the repository", () => {
  const root = tempRoot();
  try {
    assert.throws(
      () => assertP8OutsideRepo(path.join(root, "AuthKey_TEST.p8"), root),
      /outside the repository/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writes MUSICKIT_DEVELOPER_TOKEN into .env without a VITE_ key", () => {
  const root = tempRoot();
  const outside = mkdtempSync(path.join(tmpdir(), "arlet-p8-"));
  const { privateKey } = testKeyPair();
  const p8Path = path.join(outside, "AuthKey_KEYID12345.p8");
  try {
    writeFileSync(
      p8Path,
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    writeFileSync(
      path.join(root, ".env"),
      [
        "MUSICKIT_TEAM_ID=ABCDE12345",
        "MUSICKIT_KEY_ID=KEYID12345",
        `MUSICKIT_P8_PATH=${p8Path.replaceAll("\\", "/")}`,
        "MUSICKIT_DEVELOPER_TOKEN=",
      ].join("\n") + "\n",
    );
    const result = mintDeveloperTokenIntoEnv({ root, nowMs: Date.now() });
    assert.equal(result.wrote, true);
    assert.equal(result.key, TOKEN_ENV_KEY);
    assert.ok(result.tokenLength > 80);
    const envText = readFileSync(path.join(root, ".env"), "utf8");
    assert.match(envText, /^MUSICKIT_DEVELOPER_TOKEN=eyJ/mu);
    assert.doesNotMatch(envText, /VITE_MUSICKIT_DEVELOPER_TOKEN=/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("upsertEnvKey replaces an existing key", () => {
  const root = tempRoot();
  const envPath = path.join(root, ".env");
  try {
    writeFileSync(envPath, "FOO=old\nBAR=keep\n", "utf8");
    upsertEnvKey(envPath, "FOO", "new");
    assert.equal(readFileSync(envPath, "utf8"), "FOO=new\nBAR=keep\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("phase0:mint-token is an explicit script alias", () => {
  const scripts = JSON.parse(
    readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "package.json",
      ),
      "utf8",
    ),
  ).scripts;
  assert.equal(
    scripts["phase0:mint-token"],
    "node scripts/mint-musickit-token.js",
  );
});

function decodePayload(token) {
  return JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  );
}

// Failure modes: Apple matches origins as exact strings, so a trailing
// slash, path, query, missing scheme, wildcard, or non-http(s) scheme
// silently produces a token MusicKit rejects; blanks or duplicates leak
// into the claim; an unset variable adds an empty claim that blocks all use.
test("parseTokenOrigins rejects anything that is not an exact origin", () => {
  for (const bad of [
    "http://tauri.localhost/",
    "http://tauri.localhost/app",
    "http://tauri.localhost?x=1",
    "tauri.localhost",
    "*",
    "https://*.apple.com",
    "ftp://tauri.localhost",
    "tauri://localhost",
  ]) {
    assert.throws(() => parseTokenOrigins(bad), /MUSICKIT_TOKEN_ORIGINS/u, bad);
  }
});

test("parseTokenOrigins trims, drops blanks, and dedupes", () => {
  assert.deepEqual(parseTokenOrigins(undefined), []);
  assert.deepEqual(parseTokenOrigins(" , "), []);
  assert.deepEqual(
    parseTokenOrigins(
      " http://tauri.localhost ,http://localhost:5173,,http://tauri.localhost",
    ),
    ["http://tauri.localhost", "http://localhost:5173"],
  );
});

test("mint adds the origin claim only when origins are given", () => {
  const pem = testKeyPair()
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const base = {
    teamId: "ABCDE12345",
    keyId: "KEYID12345",
    privateKeyPem: pem,
    ttlSeconds: 3600,
  };
  const open = mintMusicKitDeveloperToken(base);
  assert.equal("origin" in decodePayload(open.token), false);
  const scoped = mintMusicKitDeveloperToken({
    ...base,
    origins: ["http://tauri.localhost"],
  });
  assert.deepEqual(decodePayload(scoped.token).origin, [
    "http://tauri.localhost",
  ]);
});

function releaseFixture(lines) {
  const root = tempRoot();
  const outside = mkdtempSync(path.join(tmpdir(), "arlet-p8-"));
  const p8Path = path.join(outside, "AuthKey_KEYID12345.p8");
  writeFileSync(
    p8Path,
    testKeyPair()
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
  );
  const envText = lines(p8Path.replaceAll("\\", "/")).join("\n") + "\n";
  writeFileSync(path.join(root, ".env"), envText);
  return {
    root,
    envText,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    },
  };
}

// Failure modes: a release ships an origin-restricted or short-lived token
// because the release mint honoured dev MUSICKIT_TOKEN_ORIGINS/TTL; a release machine
// without the .p8 cannot release at all; a half-configured .p8 silently
// falls back to a stale token; other .env lines are rewritten; the token is
// returned for printing.
test("release mint drops every origin claim and forces maximum lifetime", () => {
  const fixture = releaseFixture((p8) => [
    "MUSICKIT_TEAM_ID=ABCDE12345",
    "MUSICKIT_KEY_ID=KEYID12345",
    `MUSICKIT_P8_PATH=${p8}`,
    "MUSICKIT_TOKEN_ORIGINS=http://localhost:5173",
    "MUSICKIT_TOKEN_TTL_SECONDS=3600",
    "MUSICKIT_DEVELOPER_TOKEN=old",
    "AFTER_PACK_LOC=C:/archive",
  ]);
  try {
    const nowMs = 1_800_000_000_000;
    const result = mintReleaseTokenIntoEnv({ root: fixture.root, nowMs });
    assert.equal(result.wrote, true);
    assert.equal("token" in result, false);
    assert.equal(result.exp, 1_800_000_000 + MAX_TTL_SECONDS);
    const envText = readFileSync(path.join(fixture.root, ".env"), "utf8");
    const token = /^MUSICKIT_DEVELOPER_TOKEN=(.+)$/mu.exec(envText)[1];
    assert.equal("origin" in decodePayload(token), false);
    assert.equal(
      envText.replace(
        /^MUSICKIT_DEVELOPER_TOKEN=.*$/mu,
        "MUSICKIT_DEVELOPER_TOKEN=old",
      ),
      fixture.envText,
    );
  } finally {
    fixture.cleanup();
  }
});

test("release mint keeps the existing token when no .p8 is configured", () => {
  const fixture = releaseFixture(() => ["MUSICKIT_DEVELOPER_TOKEN=pasted"]);
  try {
    assert.deepEqual(mintReleaseTokenIntoEnv({ root: fixture.root }), {
      wrote: false,
    });
    assert.equal(
      readFileSync(path.join(fixture.root, ".env"), "utf8"),
      fixture.envText,
    );
  } finally {
    fixture.cleanup();
  }
});

test("release mint refuses a partially configured .p8", () => {
  const fixture = releaseFixture((p8) => [
    `MUSICKIT_P8_PATH=${p8}`,
    "MUSICKIT_DEVELOPER_TOKEN=pasted",
  ]);
  try {
    assert.throws(
      () => mintReleaseTokenIntoEnv({ root: fixture.root }),
      /MUSICKIT_TEAM_ID/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("prerelease:prepare mints before the preflight token check", () => {
  const scripts = JSON.parse(
    readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "package.json",
      ),
      "utf8",
    ),
  ).scripts;
  assert.equal(
    scripts["release:mint-token"],
    "node scripts/mint-musickit-token.js --release",
  );
  const prepare = String(scripts["prerelease:prepare"]);
  assert.ok(prepare.includes("npm run release:mint-token"));
  assert.ok(
    prepare.indexOf("release:mint-token") <
      prepare.indexOf("release:preflight"),
  );
});
