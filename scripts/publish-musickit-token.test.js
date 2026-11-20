import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildHostedTokenFile,
  CDN_POLL_ATTEMPTS,
  CDN_POLL_INTERVAL_MS,
  PUBLISH_RENEW_AT_DAYS,
  publishMusicKitToken,
  readPublishConfig,
  signAwsV4Request,
} from "./publish-musickit-token.js";
import { verifyUpdaterSignaturePayload } from "./updater-signature-verifier.js";

// Failure modes this file guards, written before publish-musickit-token.js.
// - Missing Spaces, bucket, region, CDN ID, or signing key/password: stop before
//   minting, signing, doctl, or upload, and name only the variable.
// - Token with an origin claim, under 170 days, or not ES256: refuse before signing.
// - Apple answers non-200 for the token: refuse before signing or uploading.
// - Signature does not verify or the Tauri signer fails: no upload, temp files removed.

// - Upload non-2xx or read-back bytes differ: the CDN is never flushed.
// - doctl missing (ENOENT), unauthenticated, or the endpoint origin is not the bucket: no upload.
// - Flush argv lacks --files, names a wildcard or second path, or names the wrong endpoint.
// - Flush fails: publish fails. CDN keeps serving old bytes: polling gives up after bounded tries.
// - --if-expiring publishes at 60 days or fewer and when the hosted file is missing, unreachable,
//   invalid, origin-scoped, Apple-rejected, or unsigned; it skips at 61 days.
// - Secrets reach logs, errors, or child output; children inherit stdio or receive the wrong env.
// - SigV4 signing diverges from the AWS reference vector.

const DAY = 86_400;
const NOW_MS = Date.UTC(2026, 10, 12, 12, 0, 0);
const NOW = NOW_MS / 1000;
const BUCKET = "arlet-musickit";
const REGION = "nyc3";
const HOST = `${BUCKET}.${REGION}.digitaloceanspaces.com`;
const ORIGIN_URL = `https://${HOST}/musickit/arlet-token.json`;
const PUBLIC_URL =
  "https://music-api.arlet.rosiecdn.win/musickit/arlet-token.json";
const CDN_ID = "7d1b6f0e-2a3c-4b5d-8e9f-0a1b2c3d4e5f";
const FLUSH_PATH = "musickit/arlet-token.json";
const PREFIX = "arlet-musickit-developer-token-v1\n";
const SPACES_KEY = "DOSPACESFIXTUREKEY01";
const SPACES_SECRET = "spacesSecretFixture/0002+x";
const SIGNING_KEY = "c2lnbmluZ0tleUZpeHR1cmUwMDM=";
const SIGNING_PASSWORD = "signingPasswordFixture4";
const SECRET_VALUES = [
  SPACES_KEY,
  SPACES_SECRET,
  SIGNING_KEY,
  SIGNING_PASSWORD,
];
const FAKE_SIGNATURE = Buffer.from(
  "untrusted comment: signature from minisign secret key\nRUQfixture\ntrusted comment: timestamp:1\tfile:token\nAAAA\n",
).toString("base64");
const ENV = {
  ARLET_TOKEN_SPACES_KEY: SPACES_KEY,
  ARLET_TOKEN_SPACES_SECRET: SPACES_SECRET,
  ARLET_TOKEN_SPACES_BUCKET: BUCKET,
  ARLET_TOKEN_SPACES_REGION: REGION,
  ARLET_TOKEN_CDN_ID: CDN_ID,
  TAURI_SIGNING_PRIVATE_KEY: SIGNING_KEY,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: SIGNING_PASSWORD,
};
const REQUIRED_ENV = Object.keys(ENV);
const testRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REAL_PUBKEY = JSON.parse(
  readFileSync(path.join(testRoot, "src-tauri", "tauri.conf.json"), "utf8"),
).plugins.updater.pubkey;

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

function b64json(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeToken({ days = 180, exp, origin, alg = "ES256" } = {}) {
  const claims = {
    iss: "ABCDE12345",
    iat: NOW - 60,
    exp: exp ?? NOW + days * DAY,
  };
  if (origin !== undefined) claims.origin = origin;
  return `${b64json({ alg, kid: "KEYID12345" })}.${b64json(claims)}.c2lnbmF0dXJl`;
}

function hostedBytes(overrides = {}) {
  const file = {
    version: 1,
    token: fakeToken({ days: 120 }),
    signature: FAKE_SIGNATURE,
    ...overrides,
  };
  return Buffer.from(`${JSON.stringify(file, null, 2)}\n`);
}

function bytesResponse(bytes) {
  return bytes
    ? new Response(bytes, { status: 200 })
    : new Response("", { status: 404 });
}

function makeWorld(initial = {}) {
  const world = {
    events: [],
    logs: [],
    sleeps: [],
    verifiedPayloads: [],
    mintCalls: 0,
    apple: 200,
    appleQueue: [],
    cargo: [],
    unreachable: false,
    cdnContent: null,
    cdnStalePolls: 0,
    flushed: false,
    origin: null,
    putStatus: 200,
    putBody: "<Error><Code>AccessDenied</Code></Error>",
    readback: null,
    doctl: {},
    doctlError: null,
    tauri: { status: 0, stdout: "", stderr: "" },
    mintResult: { wrote: false },
    freshToken: null,
    signedFile: null,
    signedBytes: null,
    ...initial,
  };
  world.fetchFn = async (url, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    world.events.push({
      type: "http",
      method,
      url,
      headers: { ...(init.headers ?? {}) },
      body: init.body ? Buffer.from(init.body) : null,
    });
    if (url.startsWith("https://api.music.apple.com/")) {
      const status =
        world.appleQueue.length > 0 ? world.appleQueue.shift() : world.apple;
      return new Response("{}", { status });
    }
    if (url === PUBLIC_URL) {
      if (world.unreachable && !world.flushed)
        throw new TypeError("fetch failed");
      let bytes = world.cdnContent;
      if (world.flushed) {
        if (world.cdnStalePolls > 0) world.cdnStalePolls -= 1;
        else bytes = world.origin;
      }
      return bytesResponse(bytes);
    }
    if (url === ORIGIN_URL && method === "PUT") {
      const ok = world.putStatus >= 200 && world.putStatus < 300;
      if (ok) world.origin = Buffer.from(init.body);
      return new Response(ok ? "" : world.putBody, { status: world.putStatus });
    }
    if (url === ORIGIN_URL)
      return bytesResponse(world.readback ?? world.origin);
    throw new Error(`unexpected request: ${method} ${url}`);
  };
  world.runner = (cmd, args, opts = {}) => {
    world.events.push({ type: "run", cmd, args: [...args], opts });
    if (cmd === "doctl") {
      if (world.doctlError) return { error: world.doctlError, status: null };
      if (args[2] === "get") {
        return {
          status: 0,
          stdout: JSON.stringify([{ id: CDN_ID, origin: HOST }]),
          stderr: "",
          ...world.doctl.get,
        };
      }
      if (args[2] === "flush") {
        const result = {
          status: 0,
          stdout: "",
          stderr: "",
          ...world.doctl.flush,
        };
        if (result.status === 0) world.flushed = true;
        return result;
      }
    }
    if (cmd === "cargo") {
      world.verifiedPayloads.push(readFileSync(args[args.length - 2]));
      const status = world.cargo.length > 0 ? world.cargo.shift() : 0;
      return { status, stdout: "", stderr: "" };
    }
    if (cmd === process.execPath && args.includes("signer")) {
      const file = args[args.length - 1];
      world.signedFile = file;
      world.signedBytes = readFileSync(file);
      if (world.tauri.status === 0) {
        writeFileSync(`${file}.sig`, `${FAKE_SIGNATURE}\n`);
      }
      return { ...world.tauri };
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
  world.sleep = async (ms) => {
    world.sleeps.push(ms);
  };
  world.log = (line) => {
    world.logs.push(line);
  };
  world.mint = async () => {
    world.mintCalls += 1;
    return world.mintResult;
  };
  world.readEnvFile = () => ({
    MUSICKIT_DEVELOPER_TOKEN: world.freshToken ?? "",
  });
  return world;
}

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "arlet-publish-root-"));
  mkdirSync(path.join(root, "src-tauri"));
  writeFileSync(
    path.join(root, "src-tauri", "tauri.conf.json"),
    JSON.stringify({ plugins: { updater: { pubkey: REAL_PUBKEY } } }),
  );
  return root;
}

function fixture({ world: worldInit = {}, env = {}, options = {} } = {}) {
  const root = makeRoot();
  const tempRoot = mkdtempSync(path.join(tmpdir(), "arlet-publish-temp-"));
  const world = makeWorld(worldInit);
  const publishOptions = {
    root,
    tempRoot,
    env: {
      ...ENV,
      MUSICKIT_DEVELOPER_TOKEN: fakeToken({ days: 180 }),
      ...env,
    },
    fetchFn: world.fetchFn,
    runner: world.runner,
    sleep: world.sleep,
    log: world.log,
    mint: world.mint,
    readEnvFile: world.readEnvFile,
    nowMs: NOW_MS,
    ...options,
  };
  return {
    world,
    publishOptions,
    tempRoot,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

const runsOf = (world, cmd) =>
  world.events.filter((event) => event.type === "run" && event.cmd === cmd);
const doctlRuns = (world, verb) =>
  runsOf(world, "doctl").filter((event) => event.args[2] === verb);
const httpOf = (world, method, url) =>
  world.events.filter(
    (event) =>
      event.type === "http" &&
      event.method === method &&
      (url === undefined || event.url === url),
  );
const signedOrUploaded = (world) =>
  world.events.some(
    (event) =>
      (event.type === "run" && event.args.includes("signer")) ||
      (event.type === "http" && event.method === "PUT"),
  );

function assertSingleFlush(world, cdnId = CDN_ID) {
  const flushes = doctlRuns(world, "flush");
  assert.equal(flushes.length, 1, "exactly one flush call");
  assert.deepEqual(flushes[0].args, [
    "compute",
    "cdn",
    "flush",
    cdnId,
    "--files",
    FLUSH_PATH,
  ]);
  assert.equal(
    flushes[0].args.some((arg) => arg.includes("*")),
    false,
    "no wildcard",
  );
}

test("publish signs prefix plus JWT, verifies before upload, and removes temp files", async () => {
  const token = fakeToken({ days: 180 });
  const fx = fixture({ env: { MUSICKIT_DEVELOPER_TOKEN: token } });
  try {
    const result = await publishMusicKitToken(fx.publishOptions);
    assert.equal(result.published, true);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(fx.world.signedBytes.toString("utf8"), `${PREFIX}${token}`);
    assert.ok(
      fx.world.verifiedPayloads[0].equals(Buffer.from(`${PREFIX}${token}`)),
    );
    const at = (predicate) => fx.world.events.findIndex(predicate);
    const sign = at((e) => e.type === "run" && e.args?.includes("signer"));
    const verify = at((e) => e.type === "run" && e.cmd === "cargo");
    const put = at((e) => e.type === "http" && e.method === "PUT");
    const flush = at((e) => e.type === "run" && e.args?.[2] === "flush");
    const poll = at((e) => e.type === "http" && e.url === PUBLIC_URL);
    assert.ok(sign >= 0 && sign < verify && verify < put && put < flush);
    assert.ok(flush < poll);
    const hosted = JSON.parse(fx.world.origin.toString("utf8"));
    assert.deepEqual(Object.keys(hosted), ["version", "token", "signature"]);
    assert.equal(hosted.version, 1);
    assert.equal(hosted.token, token);
    assert.equal(hosted.signature, FAKE_SIGNATURE);
    assert.equal(existsSync(fx.world.signedFile), false);
    assert.deepEqual(readdirSync(fx.tempRoot), []);
  } finally {
    fx.cleanup();
  }
});

test("exactly 170 days left publishes and 169 days is refused", async () => {
  const ok = fixture({
    env: { MUSICKIT_DEVELOPER_TOKEN: fakeToken({ days: 170 }) },
  });
  try {
    assert.equal(
      (await publishMusicKitToken(ok.publishOptions)).published,
      true,
    );
  } finally {
    ok.cleanup();
  }
  const short = fixture({
    env: { MUSICKIT_DEVELOPER_TOKEN: fakeToken({ days: 169 }) },
  });
  try {
    await assert.rejects(
      publishMusicKitToken(short.publishOptions),
      /expires in 169 day/,
    );
    assert.equal(signedOrUploaded(short.world), false);
  } finally {
    short.cleanup();
  }
});

test("refuses an origin-scoped, short-lived, or non-ES256 token before signing", async () => {
  const bad = [
    {
      token: fakeToken({ origin: ["http://tauri.localhost"] }),
      pattern: /origin claim/,
    },
    { token: fakeToken({ days: 169 }), pattern: /expires in 169 day/ },
    { token: fakeToken({ alg: "HS256" }), pattern: /ES256/ },
    { token: "not.a.jwt", pattern: /ES256/ },
  ];
  for (const { token, pattern } of bad) {
    const fx = fixture({ env: { MUSICKIT_DEVELOPER_TOKEN: token } });
    try {
      await assert.rejects(publishMusicKitToken(fx.publishOptions), (error) => {
        assert.match(error.message, pattern);
        assert.equal(error.message.includes(token), false);
        return true;
      });
      assert.equal(signedOrUploaded(fx.world), false, token);
    } finally {
      fx.cleanup();
    }
  }
});

test("Apple rejecting the token blocks signing and upload", async () => {
  const fx = fixture({ world: { apple: 401 } });
  try {
    await assert.rejects(publishMusicKitToken(fx.publishOptions), /HTTP 401/);
    assert.equal(signedOrUploaded(fx.world), false);
  } finally {
    fx.cleanup();
  }
});

test("missing config names the variable and stops before any side effect", async () => {
  for (const key of REQUIRED_ENV) {
    const fx = fixture({ env: { [key]: "" } });
    try {
      await assert.rejects(publishMusicKitToken(fx.publishOptions), (error) => {
        assert.match(error.message, new RegExp(key));
        return true;
      });
      assert.equal(fx.world.mintCalls, 0, key);
      assert.equal(fx.world.events.length, 0, key);
    } finally {
      fx.cleanup();
    }
  }
});

test("bucket and region must be DNS-safe before a host is built", () => {
  assert.throws(
    () =>
      readPublishConfig({ ...ENV, ARLET_TOKEN_SPACES_BUCKET: "Bad/Bucket" }),
    /bucket/i,
  );
  assert.throws(
    () => readPublishConfig({ ...ENV, ARLET_TOKEN_SPACES_REGION: "nyc3/../x" }),
    /region/i,
  );
  assert.equal(readPublishConfig(ENV).bucket, BUCKET);
});

test("a signature that does not verify blocks the upload", async () => {
  const fx = fixture({ world: { cargo: [1] } });
  try {
    await assert.rejects(
      publishMusicKitToken(fx.publishOptions),
      /does not verify/,
    );
    assert.equal(httpOf(fx.world, "PUT").length, 0);
    assert.deepEqual(readdirSync(fx.tempRoot), []);
  } finally {
    fx.cleanup();
  }
});

test("a failing Tauri signer blocks the upload and removes temp files", async () => {
  const fx = fixture({
    world: { tauri: { status: 1, stdout: "", stderr: "" } },
  });
  try {
    await assert.rejects(publishMusicKitToken(fx.publishOptions), /signer/);
    assert.equal(httpOf(fx.world, "PUT").length, 0);
    assert.deepEqual(readdirSync(fx.tempRoot), []);
  } finally {
    fx.cleanup();
  }
});

test("upload is a SigV4 PUT with the required headers and no Cache-Control", async () => {
  const fx = fixture();
  try {
    await publishMusicKitToken(fx.publishOptions);
    const [put] = httpOf(fx.world, "PUT");
    assert.equal(put.url, ORIGIN_URL);
    const headers = Object.fromEntries(
      Object.entries(put.headers).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );
    assert.equal(headers["x-amz-acl"], "public-read");
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers["x-amz-content-sha256"], sha256Hex(put.body));
    assert.equal(headers["cache-control"], undefined);
    assert.equal(headers["x-amz-date"], "20261112T120000Z");
    assert.match(
      headers.authorization,
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=${SPACES_KEY}/20261112/${REGION}/s3/aws4_request, SignedHeaders=content-type;host;x-amz-acl;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$`,
      ),
    );
    assert.ok(put.body.equals(fx.world.origin));
  } finally {
    fx.cleanup();
  }
});

test("a non-2xx upload fails with the S3 error code and never echoes the body", async () => {
  const fx = fixture({
    world: {
      putStatus: 403,
      putBody: `<Error><Code>SignatureDoesNotMatch</Code><Message>${SPACES_SECRET}</Message></Error>`,
    },
  });
  try {
    await assert.rejects(publishMusicKitToken(fx.publishOptions), (error) => {
      assert.match(error.message, /HTTP 403, SignatureDoesNotMatch/);
      assert.equal(error.message.includes(SPACES_SECRET), false);
      return true;
    });
    assert.equal(doctlRuns(fx.world, "flush").length, 0);
  } finally {
    fx.cleanup();
  }
});

test("a read-back that differs from the uploaded bytes fails before the CDN flush", async () => {
  const fx = fixture({ world: { readback: Buffer.from("{}\n") } });
  try {
    await assert.rejects(publishMusicKitToken(fx.publishOptions), /read-back/);
    assert.equal(doctlRuns(fx.world, "flush").length, 0);
  } finally {
    fx.cleanup();
  }
});

test("missing doctl fails before minting or uploading", async () => {
  const fx = fixture({
    world: {
      doctlError: Object.assign(new Error("spawnSync doctl ENOENT"), {
        code: "ENOENT",
      }),
    },
  });
  try {
    await assert.rejects(
      publishMusicKitToken(fx.publishOptions),
      /doctl is not installed/,
    );
    assert.equal(fx.world.mintCalls, 0);
    assert.equal(httpOf(fx.world, "PUT").length, 0);
  } finally {
    fx.cleanup();
  }
});

test("doctl that is not authenticated fails before minting or uploading", async () => {
  const fx = fixture({
    world: {
      doctl: {
        get: {
          status: 1,
          stdout: "",
          stderr: "Error: Unable to authenticate you.",
        },
      },
    },
  });
  try {
    await assert.rejects(
      publishMusicKitToken(fx.publishOptions),
      /not authenticated/,
    );
    assert.equal(fx.world.mintCalls, 0);
    assert.equal(httpOf(fx.world, "PUT").length, 0);
  } finally {
    fx.cleanup();
  }
});

test("a CDN endpoint whose origin is another bucket is refused before uploading", async () => {
  const fx = fixture({
    world: {
      doctl: {
        get: {
          stdout: JSON.stringify([
            { id: CDN_ID, origin: "other-bucket.nyc3.digitaloceanspaces.com" },
          ]),
        },
      },
    },
  });
  try {
    await assert.rejects(publishMusicKitToken(fx.publishOptions), /origin/);
    assert.equal(fx.world.mintCalls, 0);
    assert.equal(httpOf(fx.world, "PUT").length, 0);
  } finally {
    fx.cleanup();
  }
});

test("a flush failure fails the publish and polls nothing", async () => {
  const fx = fixture({
    world: { doctl: { flush: { status: 1, stdout: "", stderr: "failed" } } },
  });
  try {
    await assert.rejects(
      publishMusicKitToken(fx.publishOptions),
      /CDN flush failed/,
    );
    assertSingleFlush(fx.world);
    assert.equal(httpOf(fx.world, "GET", PUBLIC_URL).length, 0);
  } finally {
    fx.cleanup();
  }
});

test("every doctl call names the configured endpoint and flushes exactly one path", async () => {
  for (const cdnId of [CDN_ID, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]) {
    const fx = fixture({ env: { ARLET_TOKEN_CDN_ID: cdnId } });
    try {
      await publishMusicKitToken(fx.publishOptions);
      assert.deepEqual(
        doctlRuns(fx.world, "get").map((event) => event.args),
        [["compute", "cdn", "get", cdnId, "--output", "json"]],
      );
      assertSingleFlush(fx.world, cdnId);
    } finally {
      fx.cleanup();
    }
  }
});

test("polls the exact public URL until the CDN serves the new bytes", async () => {
  const fx = fixture({ world: { cdnStalePolls: 2 } });
  try {
    const result = await publishMusicKitToken(fx.publishOptions);
    assert.equal(result.polls, 3);
    assert.deepEqual(fx.world.sleeps, [
      CDN_POLL_INTERVAL_MS,
      CDN_POLL_INTERVAL_MS,
    ]);
    const polls = httpOf(fx.world, "GET", PUBLIC_URL);
    assert.equal(polls.length, 3);
    assert.ok(polls.every((poll) => poll.url === PUBLIC_URL));
  } finally {
    fx.cleanup();
  }
});

test("fails when the CDN still serves old bytes after the bounded polls", async () => {
  const fx = fixture({
    world: { cdnStalePolls: 999, cdnContent: hostedBytes() },
  });
  try {
    await assert.rejects(
      publishMusicKitToken(fx.publishOptions),
      /still does not serve/,
    );
    assert.equal(httpOf(fx.world, "GET", PUBLIC_URL).length, CDN_POLL_ATTEMPTS);
    assert.equal(fx.world.sleeps.length, CDN_POLL_ATTEMPTS - 1);
  } finally {
    fx.cleanup();
  }
});

test("poll defaults give about two minutes of CDN propagation", () => {
  assert.equal(CDN_POLL_ATTEMPTS, 12);
  assert.equal(CDN_POLL_INTERVAL_MS, 10_000);
  const window = (CDN_POLL_ATTEMPTS - 1) * CDN_POLL_INTERVAL_MS;
  assert.ok(window >= 100_000 && window <= 120_000);
});

test("secrets never reach logs, errors, or child output", async () => {
  const token = fakeToken({ days: 180 });
  const leaky = new Map([
    [
      "tauri",
      {
        world: {
          tauri: {
            status: 1,
            stdout: SIGNING_KEY,
            stderr: `${SIGNING_PASSWORD} ${token} ${SPACES_SECRET}`,
          },
        },
      },
    ],
    [
      "doctl",
      {
        world: {
          doctl: {
            get: {
              status: 1,
              stdout: "",
              stderr: `Error: bad credentials ${SPACES_SECRET}`,
            },
          },
        },
      },
    ],
  ]);
  for (const [label, { world }] of leaky) {
    const fx = fixture({ world, env: { MUSICKIT_DEVELOPER_TOKEN: token } });
    try {
      let message = "";
      await assert.rejects(publishMusicKitToken(fx.publishOptions), (error) => {
        message = error.message;
        return true;
      });
      const captured = [message, ...fx.world.logs].join("\n");
      for (const secret of [...SECRET_VALUES, token]) {
        assert.equal(captured.includes(secret), false, label);
      }
    } finally {
      fx.cleanup();
    }
  }
  const success = fixture({ env: { MUSICKIT_DEVELOPER_TOKEN: token } });
  try {
    await publishMusicKitToken(success.publishOptions);
    const captured = success.world.logs.join("\n");
    for (const secret of [...SECRET_VALUES, token]) {
      assert.equal(captured.includes(secret), false);
    }
  } finally {
    success.cleanup();
  }
});

test("children never inherit stdio and only the signer receives the signing key", async () => {
  const fx = fixture();
  try {
    await publishMusicKitToken(fx.publishOptions);
    const runs = fx.world.events.filter((event) => event.type === "run");
    assert.ok(runs.length >= 4);
    for (const run of runs) {
      assert.ok(Array.isArray(run.opts.stdio), run.cmd);
      assert.equal(run.opts.stdio.includes("inherit"), false, run.cmd);
      assert.equal(run.opts.env.ARLET_TOKEN_SPACES_SECRET, undefined, run.cmd);
      assert.equal(run.opts.env.MUSICKIT_DEVELOPER_TOKEN, undefined, run.cmd);
    }
    const signer = runs.find((run) => run.args.includes("signer"));
    assert.equal(signer.cmd, process.execPath);
    assert.match(signer.args[0], /tauri\.js$/);
    assert.equal(signer.opts.env.TAURI_SIGNING_PRIVATE_KEY, SIGNING_KEY);
    for (const run of runs.filter((event) => event.cmd !== process.execPath)) {
      assert.equal(run.opts.env.TAURI_SIGNING_PRIVATE_KEY, undefined, run.cmd);
      assert.equal(
        run.opts.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
        undefined,
        run.cmd,
      );
    }
  } finally {
    fx.cleanup();
  }
});

test("publishes the token re-read from .env after a fresh mint", async () => {
  const fresh = fakeToken({ days: 175 });
  const fx = fixture({
    world: { mintResult: { wrote: true }, freshToken: fresh },
  });
  try {
    await publishMusicKitToken(fx.publishOptions);
    assert.equal(fx.world.mintCalls, 1);
    assert.equal(fx.world.signedBytes.toString("utf8"), `${PREFIX}${fresh}`);
    assert.equal(JSON.parse(fx.world.origin.toString("utf8")).token, fresh);
  } finally {
    fx.cleanup();
  }
});

test("--if-expiring skips at 61 days left without minting, signing, or uploading", async () => {
  const fx = fixture({
    world: {
      cdnContent: hostedBytes({ token: fakeToken({ days: 61 }) }),
      cargo: [0],
    },
    options: { ifExpiring: true },
  });
  try {
    const result = await publishMusicKitToken(fx.publishOptions);
    assert.equal(result.skipped, true);
    assert.equal(result.published, false);
    assert.equal(result.daysLeft, 61);
    assert.ok(fx.world.logs.some((line) => /skipped, 61 days left/.test(line)));
    assert.equal(fx.world.mintCalls, 0);
    assert.equal(signedOrUploaded(fx.world), false);
    assert.equal(doctlRuns(fx.world, "get").length, 0);
  } finally {
    fx.cleanup();
  }
});

test("--if-expiring publishes at exactly 60 days left", async () => {
  const fx = fixture({
    world: {
      cdnContent: hostedBytes({ token: fakeToken({ days: 60 }) }),
      cargo: [0, 0],
    },
    options: { ifExpiring: true },
  });
  try {
    const result = await publishMusicKitToken(fx.publishOptions);
    assert.equal(result.skipped, false);
    assert.equal(result.published, true);
    assert.equal(httpOf(fx.world, "PUT").length, 1);
  } finally {
    fx.cleanup();
  }
});

test("--if-expiring publishes for every unusable or expiring hosted file", async () => {
  const cases = {
    "missing (404)": { cdnContent: null },
    unreachable: { unreachable: true },
    "not JSON": { cdnContent: Buffer.from("not json") },
    "wrong version": { cdnContent: hostedBytes({ version: 2 }) },
    "origin claim": {
      cdnContent: hostedBytes({
        token: fakeToken({ origin: ["http://tauri.localhost"] }),
      }),
    },
    "Apple rejects it": {
      cdnContent: hostedBytes(),
      appleQueue: [401],
    },
    "20 days left": {
      cdnContent: hostedBytes({ token: fakeToken({ days: 20 }) }),
    },
  };
  for (const [label, worldInit] of Object.entries(cases)) {
    const fx = fixture({
      world: { cargo: [], ...worldInit },
      options: { ifExpiring: true },
    });
    try {
      const result = await publishMusicKitToken(fx.publishOptions);
      assert.equal(result.published, true, label);
      assert.equal(result.skipped, false, label);
      assert.equal(httpOf(fx.world, "PUT").length, 1, label);
    } finally {
      fx.cleanup();
    }
  }
});

test("--if-expiring republishes a 100-day file whose signature does not verify", async () => {
  const fx = fixture({
    world: {
      cdnContent: hostedBytes({ token: fakeToken({ days: 100 }) }),
      cargo: [1],
    },
    options: { ifExpiring: true },
  });
  try {
    const result = await publishMusicKitToken(fx.publishOptions);
    assert.equal(result.published, true);
    assert.equal(fx.world.verifiedPayloads.length, 2);
  } finally {
    fx.cleanup();
  }
});

test("renewal threshold is 60 days", () => {
  assert.equal(PUBLISH_RENEW_AT_DAYS, 60);
});

test("hosted file keeps the fixed contract shape and stays under 1 KB", () => {
  const bytes = buildHostedTokenFile({
    token: fakeToken(),
    signature: FAKE_SIGNATURE,
  });
  const parsed = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(Object.keys(parsed), ["version", "token", "signature"]);
  assert.equal(parsed.version, 1);
  assert.ok(bytes.length < 1024);
  assert.throws(
    () =>
      buildHostedTokenFile({
        token: "x".repeat(1100),
        signature: FAKE_SIGNATURE,
      }),
    /1 KB/,
  );
});

test("the verifier runs cargo once with the pinned key, payload, and envelope", () => {
  const root = makeRoot();
  const tempRoot = mkdtempSync(path.join(tmpdir(), "arlet-verify-temp-"));
  const calls = [];
  const runner = (cmd, args) => {
    const [publicKey, payload, signature] = args
      .slice(-3)
      .map((file) => readFileSync(file));
    calls.push({ cmd, args, publicKey, payload, signature });
    return { status: 0 };
  };
  try {
    assert.equal(
      verifyUpdaterSignaturePayload({
        root,
        payload: Buffer.from("payload"),
        signature: FAKE_SIGNATURE,
        runner,
        tempRoot,
      }),
      true,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "cargo");
    assert.ok(calls[0].args.includes("verify_updater_signatures"));
    assert.equal(
      calls[0].publicKey.toString("utf8"),
      Buffer.from(REAL_PUBKEY, "base64").toString("utf8"),
    );
    assert.equal(calls[0].payload.toString("utf8"), "payload");
    assert.equal(
      calls[0].signature.toString("utf8"),
      Buffer.from(FAKE_SIGNATURE, "base64").toString("utf8"),
    );
    assert.throws(
      () =>
        verifyUpdaterSignaturePayload({
          root,
          payload: Buffer.from("payload"),
          signature: Buffer.from("plain text").toString("base64"),
          runner,
          tempRoot,
        }),
      /minisign envelope/,
    );
    assert.equal(
      calls.length,
      1,
      "a non-envelope signature never reaches cargo",
    );
    assert.deepEqual(readdirSync(tempRoot), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("SigV4 matches the AWS reference ListUsers vector", () => {
  const signed = signAwsV4Request({
    method: "GET",
    canonicalUri: "/",
    canonicalQuery: "Action=ListUsers&Version=2010-05-08",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      Host: "iam.amazonaws.com",
      "X-Amz-Date": "20150830T123600Z",
    },
    payloadHash: sha256Hex(Buffer.alloc(0)),
    amzDate: "20150830T123600Z",
    region: "us-east-1",
    service: "iam",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  });
  assert.equal(
    signed.signingKey.toString("hex"),
    "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
  );
  assert.equal(
    signed.stringToSign.split("\n").at(-1),
    "f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59",
  );
  assert.equal(
    signed.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
  );
});

test("package.json wires token:publish and token:check to the documented commands", () => {
  const scripts = JSON.parse(
    readFileSync(path.join(testRoot, "package.json"), "utf8"),
  ).scripts;
  assert.equal(
    scripts["token:publish"],
    "dotenv -e .env -- node scripts/publish-musickit-token.js",
  );
  assert.equal(
    scripts["token:check"],
    "node scripts/publish-musickit-token.js --check-live",
  );
});
