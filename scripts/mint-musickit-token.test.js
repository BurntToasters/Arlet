import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertP8OutsideRepo,
  mintDeveloperTokenIntoEnv,
  mintMusicKitDeveloperToken,
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
