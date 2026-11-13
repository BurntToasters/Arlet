import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkLiveMusicKitToken,
  MUSICKIT_TOKEN_LIVE_MIN_DAYS,
  MUSICKIT_TOKEN_PUBLIC_URL,
} from "./release-preflight.js";

const DAY = 86_400;
const NOW = 1_800_000_000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function b64json(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeToken({ days = 180, exp, origin, alg = "ES256" } = {}) {
  const claims = { iss: "ABCDE12345", iat: NOW, exp: exp ?? NOW + days * DAY };
  if (origin !== undefined) claims.origin = origin;
  return `${b64json({ alg, kid: "KEYID12345" })}.${b64json(claims)}.c2lnbmF0dXJl`;
}

const FAKE_SIGNATURE = Buffer.from(
  "untrusted comment: signature from minisign secret key\nRUQfixture\ntrusted comment: timestamp:1\tfile:token\nAAAA\n",
).toString("base64");

function hostedBytes(overrides = {}) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      token: fakeToken({ days: 120 }),
      signature: FAKE_SIGNATURE,
      ...overrides,
    }),
  );
}

// Serves the hosted file and a fake Apple catalog answer; records URLs.
function liveFetch({
  bytes,
  apple = 200,
  unreachable = false,
  status = 200,
} = {}) {
  const requests = [];
  const fetchFn = async (url) => {
    requests.push(url);
    if (url.startsWith("https://api.music.apple.com/")) {
      return new Response("{}", { status: apple });
    }
    if (url !== MUSICKIT_TOKEN_PUBLIC_URL) throw new Error(`unexpected ${url}`);
    if (unreachable) throw new TypeError("fetch failed");
    if (bytes === null) return new Response("", { status: 404 });
    return new Response(bytes, { status });
  };
  return { fetchFn, requests };
}

// Failure modes for the release live check, written before the implementation.
// - Live file missing, unreachable, oversized, malformed, version 2, or with extra keys: fail.
// - Origin-scoped, non-ES256, or Apple-rejected token: fail, and the token never appears in errors.

// - Exactly 44 days left fails and exactly 45 passes (the weekly canary threshold).
// - The live file's signature is verified over prefix plus token; a failing verifier fails the check.

test("live check passes at exactly 45 days and fails at 44", async () => {
  const pass = liveFetch({
    bytes: hostedBytes({ token: fakeToken({ days: 45 }) }),
  });
  const live = await checkLiveMusicKitToken({
    fetchFn: pass.fetchFn,
    nowSeconds: NOW,
  });
  assert.equal(live.daysLeft, 45);
  assert.equal(MUSICKIT_TOKEN_LIVE_MIN_DAYS, 45);
  assert.deepEqual(pass.requests, [
    MUSICKIT_TOKEN_PUBLIC_URL,
    "https://api.music.apple.com/v1/catalog/us/search?term=hello&types=songs&limit=1",
  ]);

  const fail = liveFetch({
    bytes: hostedBytes({ token: fakeToken({ days: 44 }) }),
  });
  await assert.rejects(
    checkLiveMusicKitToken({ fetchFn: fail.fetchFn, nowSeconds: NOW }),
    /expires in 44 day/,
  );
});

test("live check refuses every malformed or unusable hosted file", async () => {
  const cases = {
    missing: { bytes: null },
    unreachable: { unreachable: true },
    oversized: {
      bytes: hostedBytes({ signature: "x".repeat(1100) }),
      pattern: /1 KB/,
    },
    "not JSON": { bytes: Buffer.from("{nope") },
    "wrong version": { bytes: hostedBytes({ version: 2 }), pattern: /version/ },
    "extra key": {
      bytes: Buffer.from(
        JSON.stringify({
          version: 1,
          token: fakeToken({ days: 120 }),
          signature: FAKE_SIGNATURE,
          extra: true,
        }),
      ),
      pattern: /keys/,
    },
    "origin claim": {
      bytes: hostedBytes({
        token: fakeToken({ origin: ["http://tauri.localhost"] }),
      }),
      pattern: /origin/,
    },
    "not ES256": {
      bytes: hostedBytes({ token: fakeToken({ alg: "HS256" }) }),
      pattern: /ES256/,
    },
    "Apple rejects it": {
      bytes: hostedBytes(),
      apple: 401,
      pattern: /HTTP 401/,
    },
  };
  for (const [label, { pattern = /./, ...options }] of Object.entries(cases)) {
    const token = fakeToken({ days: 120 });
    const { fetchFn } = liveFetch(options);
    await assert.rejects(
      checkLiveMusicKitToken({ fetchFn, nowSeconds: NOW }),
      (error) => {
        assert.match(error.message, pattern, label);
        assert.equal(error.message.includes(token), false, label);
        return true;
      },
      label,
    );
  }
});

test("live check verifies the signature over prefix plus token", async () => {
  const token = fakeToken({ days: 120 });
  const { fetchFn } = liveFetch({ bytes: hostedBytes({ token }) });
  const seen = [];
  const live = await checkLiveMusicKitToken({
    fetchFn,
    nowSeconds: NOW,
    verifySignature: (args) => seen.push(args),
  });
  assert.equal(live.daysLeft, 120);
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].payload.toString("utf8"),
    `arlet-musickit-developer-token-v1\n${token}`,
  );
  assert.equal(seen[0].signature, FAKE_SIGNATURE);
});

test("a failing signature verifier fails the live check", async () => {
  const { fetchFn } = liveFetch({ bytes: hostedBytes() });
  await assert.rejects(
    checkLiveMusicKitToken({
      fetchFn,
      nowSeconds: NOW,
      verifySignature: () => {
        throw new Error("Updater signature verification failed.");
      },
    }),
    /signature verification failed/,
  );
});

test("the canary runs the hosted check weekly without a release-age gate", () => {
  const workflow = read(".github/workflows/musickit-canary.yml");
  assert.match(workflow, /hosted-token:/);
  assert.match(workflow, /run: npm run token:check/);
  assert.match(workflow, /token:publish/);
  assert.doesNotMatch(workflow, /MAX_RELEASE_AGE_DAYS/);
  assert.doesNotMatch(workflow, /releases\/latest/);
});

test("ci and release tooling drop the embedded-token gate and skip switch", () => {
  assert.doesNotMatch(
    read(".github/workflows/ci.yml"),
    /ARLET_SKIP_MUSICKIT_TOKEN/,
  );
  assert.doesNotMatch(
    read("scripts/release-preflight.js"),
    /ARLET_SKIP_MUSICKIT_TOKEN/,
  );
  const windowsBuild = read("scripts/tauri-windows-build.js");
  assert.doesNotMatch(windowsBuild, /ARLET_SKIP_MUSICKIT_TOKEN/);
  assert.doesNotMatch(windowsBuild, /MUSICKIT_DEVELOPER_TOKEN is missing/);
});

test(".env.example documents the publish variables and keeps the debug token", () => {
  const envExample = read(".env.example");
  for (const key of [
    "ARLET_TOKEN_SPACES_KEY=",
    "ARLET_TOKEN_SPACES_SECRET=",
    "ARLET_TOKEN_SPACES_BUCKET=",
    "ARLET_TOKEN_SPACES_REGION=",
    "ARLET_TOKEN_CDN_ID=",
    "MUSICKIT_DEVELOPER_TOKEN=",
  ]) {
    assert.match(envExample, new RegExp(`^${key}`, "mu"), key);
  }
  assert.doesNotMatch(envExample, /ARLET_SKIP_MUSICKIT_TOKEN/);
});
