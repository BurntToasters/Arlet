#!/usr/bin/env node
// Publishes the MusicKit developer token that app builds fetch at runtime.
// Mints or reuses a 180-day ES256 token, checks it with Apple, signs
// `prefix + token` with the Tauri updater key, verifies that signature against
// the pinned pubkey, uploads to DigitalOcean Spaces with a hand-written SigV4
// PUT, reads it back from the origin, flushes one CDN path, and polls the
// public URL. Never prints the token or any key or secret.
//
//   npm run token:publish                     publish a fresh token
//   npm run token:publish -- --if-expiring    publish only at 60 days or fewer
//   npm run token:check                       check the live file (no secrets)

import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mintReleaseTokenIntoEnv } from "./mint-musickit-token.js";
import { parseEnvFile, repoRoot } from "./phase0-preflight.js";
import {
  checkLiveMusicKitToken,
  checkMusicKitTokenAcceptedByApple,
  checkMusicKitTokenPolicy,
  inspectHostedMusicKitToken,
  MUSICKIT_TOKEN_FILE_MAX_BYTES,
  MUSICKIT_TOKEN_OBJECT_KEY,
  MUSICKIT_TOKEN_PUBLIC_URL,
  MUSICKIT_TOKEN_PUBLISH_MIN_DAYS,
  signedMusicKitTokenPayload,
} from "./release-preflight.js";
import {
  decodeUpdaterSignatureEnvelope,
  normalizeUpdaterSignature,
  verifyUpdaterSignaturePayload,
} from "./updater-signature-verifier.js";

export const PUBLISH_RENEW_AT_DAYS = 60;
export const CDN_POLL_ATTEMPTS = 12;
export const CDN_POLL_INTERVAL_MS = 10_000;

const HTTP_TIMEOUT_MS = 20_000;
const DOCTL_TIMEOUT_MS = 60_000;
const SIGNER_TIMEOUT_MS = 120_000;
const TOKEN_ENV = "MUSICKIT_DEVELOPER_TOKEN";
const SPACES_SECRET_ENV = [
  "ARLET_TOKEN_SPACES_KEY",
  "ARLET_TOKEN_SPACES_SECRET",
];
const SIGNING_ENV = [
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
];
const REQUIRED_ENV = [
  ...SPACES_SECRET_ENV,
  "ARLET_TOKEN_SPACES_BUCKET",
  "ARLET_TOKEN_SPACES_REGION",
  "ARLET_TOKEN_CDN_ID",
  ...SIGNING_ENV,
];
const SECRET_ENV_KEYS = [...SPACES_SECRET_ENV, ...SIGNING_ENV, TOKEN_ENV];
const TAURI_CLI = path.join(
  repoRoot,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);
const SIGNED_FILE_NAME = "arlet-musickit-developer-token-v1.txt";

const messageOf = (error) =>
  error instanceof Error ? error.message : String(error);
const errorCodeOf = (error) => error?.code ?? "error";
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const defaultSleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function withoutKeys(env, keys) {
  const copy = { ...env };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * Replaces every known secret value, PEM block, and JWT in text. Child output
 * and error text pass through this before anything is printed.
 */
export function scrubSecrets(text, env = {}) {
  let scrubbed = String(text ?? "");
  for (const key of SECRET_ENV_KEYS) {
    const value = String(env[key] ?? "").trim();
    if (value.length >= 4) scrubbed = scrubbed.split(value).join("[redacted]");
  }
  return scrubbed
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
      "[key redacted]",
    )
    .replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/gu,
      "[jwt redacted]",
    );
}

function summarizeOutput(text, env) {
  const line = String(text ?? "")
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ? scrubSecrets(line, env).slice(0, 200) : "";
}

/** Required publish settings, read from env. Errors name variables only. */
export function readPublishConfig(env = process.env) {
  const missing = REQUIRED_ENV.filter((key) => !String(env[key] ?? "").trim());
  if (missing.length > 0) {
    throw new Error(
      `Set ${missing.join(", ")} in .env before publishing (see .env.example).`,
    );
  }
  const config = {
    spacesKey: String(env.ARLET_TOKEN_SPACES_KEY).trim(),
    spacesSecret: String(env.ARLET_TOKEN_SPACES_SECRET).trim(),
    bucket: String(env.ARLET_TOKEN_SPACES_BUCKET).trim(),
    region: String(env.ARLET_TOKEN_SPACES_REGION).trim(),
    cdnId: String(env.ARLET_TOKEN_CDN_ID).trim(),
    signingKey: String(env.TAURI_SIGNING_PRIVATE_KEY).trim(),
    signingPassword: String(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD),
  };
  spacesHost(config);
  return config;
}

/** The Space's origin host, the only host the CDN may pull from. */
export function spacesHost({ bucket, region }) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucket)) {
    throw new Error(
      "ARLET_TOKEN_SPACES_BUCKET must be a DNS-safe Spaces bucket name.",
    );
  }
  if (!/^[a-z0-9-]{2,20}$/u.test(region)) {
    throw new Error(
      "ARLET_TOKEN_SPACES_REGION must be a Spaces region slug such as nyc3.",
    );
  }
  return `${bucket}.${region}.digitaloceanspaces.com`;
}

/**
 * AWS Signature Version 4 for one request. `headers` names must include host.
 * Returns the Authorization value plus intermediate values for tests.
 */
export function signAwsV4Request({
  method,
  canonicalUri,
  canonicalQuery = "",
  headers,
  payloadHash,
  amzDate,
  region,
  service,
  accessKeyId,
  secretAccessKey,
}) {
  const dateStamp = amzDate.slice(0, 8);
  const lowered = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      String(value).trim().replace(/\s+/gu, " "),
    ]),
  );
  const names = Object.keys(lowered).sort();
  const signedHeaders = names.join(";");
  const canonicalHeaders = names
    .map((name) => `${name}:${lowered[name]}\n`)
    .join("");
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = [dateStamp, region, service, "aws4_request"].reduce(
    (key, part) => createHmac("sha256", key).update(part, "utf8").digest(),
    `AWS4${secretAccessKey}`,
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signature,
    signingKey,
    canonicalRequest,
    stringToSign,
  };
}

const toAmzDate = (nowMs) =>
  new Date(nowMs).toISOString().replace(/[:-]|\.\d{3}/gu, "");

/** The hosted file: exactly version, token, and signature, under 1 KB. */
export function buildHostedTokenFile({ token, signature }) {
  const bytes = Buffer.from(
    `${JSON.stringify({ version: 1, token, signature }, null, 2)}\n`,
    "utf8",
  );
  if (bytes.length >= MUSICKIT_TOKEN_FILE_MAX_BYTES) {
    throw new Error("The hosted MusicKit token file must stay under 1 KB.");
  }
  return bytes;
}

/**
 * Signs the payload with `tauri signer sign` (keys from TAURI_SIGNING_* env)
 * and returns the base64 minisign envelope. The payload and signature live in
 * a private temp directory removed on every path; child output is piped.
 */
export function signMusicKitTokenPayload({
  payload,
  env,
  runner = spawnSync,
  tempRoot = os.tmpdir(),
}) {
  const directory = fs.mkdtempSync(path.join(tempRoot, "arlet-musickit-sign-"));
  try {
    const file = path.join(directory, SIGNED_FILE_NAME);
    fs.writeFileSync(file, payload, { mode: 0o600 });
    const result = runner(
      process.execPath,
      [TAURI_CLI, "signer", "sign", file],
      {
        cwd: repoRoot,
        env: withoutKeys(env, [...SPACES_SECRET_ENV, TOKEN_ENV]),
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: SIGNER_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    if (result?.error) {
      throw new Error(
        `Could not run the Tauri signer (${errorCodeOf(result.error)}).`,
      );
    }
    if (result?.status !== 0) {
      throw new Error(
        `The Tauri signer exited with ${result?.status ?? "unknown"}; the token was not signed.`,
      );
    }
    const signaturePath = `${file}.sig`;
    if (!fs.existsSync(signaturePath)) {
      throw new Error("The Tauri signer wrote no signature file.");
    }
    const signature = normalizeUpdaterSignature(signaturePath);
    decodeUpdaterSignatureEnvelope(signature);
    return signature;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Uploads the hosted file with a SigV4 PUT. Non-2xx fails; the body is never echoed. */
export async function putSpacesObject({
  config,
  body,
  fetchFn = globalThis.fetch,
  nowMs = Date.now(),
}) {
  const host = spacesHost(config);
  const amzDate = toAmzDate(nowMs);
  const payloadHash = sha256Hex(body);
  const canonicalUri = `/${MUSICKIT_TOKEN_OBJECT_KEY.split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const contentType = "application/json";
  const { authorization } = signAwsV4Request({
    method: "PUT",
    canonicalUri,
    headers: {
      host,
      "content-type": contentType,
      "x-amz-acl": "public-read",
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
    payloadHash,
    amzDate,
    region: config.region,
    service: "s3",
    accessKeyId: config.spacesKey,
    secretAccessKey: config.spacesSecret,
  });
  let response;
  try {
    response = await fetchFn(`https://${host}${canonicalUri}`, {
      method: "PUT",
      headers: {
        "content-type": contentType,
        "x-amz-acl": "public-read",
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        authorization,
      },
      body,
    });
  } catch (error) {
    throw new Error(
      `Spaces upload could not reach ${host} (${error?.name ?? "request failed"}).`,
    );
  }
  const text = await response.text().catch(() => "");
  if (response.status < 200 || response.status > 299) {
    const code = /<Code>([A-Za-z0-9.]+)<\/Code>/u.exec(text)?.[1];
    throw new Error(
      `Spaces upload failed (HTTP ${response.status}${code ? `, ${code}` : ""}).`,
    );
  }
}

/** Reads the object back from the Space origin (not the CDN). */
export async function getSpacesObject({ config, fetchFn = globalThis.fetch }) {
  const host = spacesHost(config);
  let response;
  try {
    response = await fetchFn(`https://${host}/${MUSICKIT_TOKEN_OBJECT_KEY}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Spaces read-back could not reach ${host} (${error?.name ?? "request failed"}).`,
    );
  }
  if (response.status !== 200) {
    throw new Error(`Spaces read-back failed (HTTP ${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

const doctlError = (error) =>
  error?.code === "ENOENT"
    ? new Error(
        "doctl is not installed or not on PATH. Install doctl and run doctl auth init.",
      )
    : new Error(`Could not run doctl (${error?.code ?? "error"}).`);

function runDoctl(runner, args, env) {
  return runner("doctl", args, {
    cwd: repoRoot,
    env: withoutKeys(env, SECRET_ENV_KEYS),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: DOCTL_TIMEOUT_MS,
    windowsHide: true,
  });
}

/**
 * Reads the configured CDN endpoint. Refuses unless its origin is this Space,
 * so a flush can only ever act on the bucket this module wrote to.
 */
export function checkCdnEndpoint({ config, env, runner = spawnSync }) {
  const result = runDoctl(
    runner,
    ["compute", "cdn", "get", config.cdnId, "--output", "json"],
    env,
  );
  if (result?.error) throw doctlError(result.error);
  if (result?.status !== 0) {
    const detail = summarizeOutput(result?.stderr, env);
    throw new Error(
      `doctl is not authenticated or cannot read CDN endpoint ${config.cdnId} (exit ${result?.status ?? "unknown"}). Run doctl auth init with a CDN-scoped token.${detail ? ` Detail: ${detail}` : ""}`,
    );
  }
  let endpoint;
  try {
    const parsed = JSON.parse(result.stdout || "null");
    endpoint = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    throw new Error("doctl returned an unexpected CDN endpoint response.");
  }
  const expected = spacesHost(config);
  const origin = String(endpoint?.origin ?? "").toLowerCase();
  if (origin !== expected) {
    throw new Error(
      `CDN endpoint ${config.cdnId} has origin "${origin || "none"}", not ${expected}; refusing to publish.`,
    );
  }
  return endpoint;
}

/** Flushes exactly one endpoint and one path. Never a wildcard, never omit --files. */
export function flushCdnPath({ config, env, runner = spawnSync }) {
  const result = runDoctl(
    runner,
    [
      "compute",
      "cdn",
      "flush",
      config.cdnId,
      "--files",
      MUSICKIT_TOKEN_OBJECT_KEY,
    ],
    env,
  );
  if (result?.error) throw doctlError(result.error);
  if (result?.status !== 0) {
    throw new Error(
      `CDN flush failed (doctl exit ${result?.status ?? "unknown"}). The public file may serve the old token until the edge TTL expires.`,
    );
  }
}

/** Polls the exact public URL (no query string) until it serves `expected`. */
export async function waitForPublicBytes({
  fetchFn = globalThis.fetch,
  url = MUSICKIT_TOKEN_PUBLIC_URL,
  expected,
  sleep = defaultSleep,
  attempts = CDN_POLL_ATTEMPTS,
  intervalMs = CDN_POLL_INTERVAL_MS,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchFn(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (
        response.status === 200 &&
        Buffer.from(await response.arrayBuffer()).equals(expected)
      ) {
        return attempt;
      }
    } catch {
      // An unreachable edge counts as one failed attempt.
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new Error(
    `The CDN still does not serve the new token file at ${url} after ${attempts} checks. Run npm run token:check later; the edge TTL may still hold the old file.`,
  );
}

/**
 * Mints or reuses, checks, signs, verifies, uploads, reads back, flushes, and
 * polls. With `ifExpiring`, first checks the live file and returns
 * `{ skipped: true }` when it has more than 60 days left. Never returns or
 * logs the token or any key.
 */
export async function publishMusicKitToken(options = {}) {
  const root = options.root ?? repoRoot;
  const env = options.env ?? process.env;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const runner = options.runner ?? spawnSync;
  const mint = options.mint ?? mintReleaseTokenIntoEnv;
  const readEnvFile =
    options.readEnvFile ?? (() => parseEnvFile(path.join(root, ".env")));
  const nowMs = options.nowMs ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const sleep = options.sleep ?? defaultSleep;
  const tempRoot = options.tempRoot ?? os.tmpdir();
  const log = options.log ?? ((line) => console.log(line));
  const attempts = options.attempts ?? CDN_POLL_ATTEMPTS;
  const intervalMs = options.intervalMs ?? CDN_POLL_INTERVAL_MS;
  const verifySignature = ({ payload, signature }) =>
    verifyUpdaterSignaturePayload({
      root,
      payload,
      signature,
      runner,
      tempRoot,
      env: withoutKeys(env, SECRET_ENV_KEYS),
    });

  if (options.ifExpiring) {
    const live = await inspectHostedMusicKitToken({
      fetchFn,
      nowSeconds,
      minRemainingDays: 0,
      verifySignature,
    });
    if (live.ok && live.daysLeft > PUBLISH_RENEW_AT_DAYS) {
      log(
        `token:publish: skipped, ${live.daysLeft} days left (renews at ${PUBLISH_RENEW_AT_DAYS} or fewer).`,
      );
      return {
        published: false,
        skipped: true,
        daysLeft: live.daysLeft,
        exp: live.exp,
        polls: 0,
      };
    }
    log(
      `token:publish: renewing (${live.ok ? `${live.daysLeft} days left` : live.problem}).`,
    );
  }

  const config = readPublishConfig(env);
  checkCdnEndpoint({ config, env, runner });
  log(`token:publish: CDN endpoint origin is ${spacesHost(config)}.`);

  const minted = await mint({ root, nowMs });
  const source = minted.wrote ? readEnvFile() : env;
  const token = String(source[TOKEN_ENV] ?? "").trim();
  const { daysLeft, exp } = checkMusicKitTokenPolicy(token, {
    nowSeconds,
    minRemainingDays: MUSICKIT_TOKEN_PUBLISH_MIN_DAYS,
  });
  await checkMusicKitTokenAcceptedByApple(token, fetchFn);
  log(`token:publish: Apple accepted the token (${daysLeft} days left).`);

  const payload = signedMusicKitTokenPayload(token);
  const signature = signMusicKitTokenPayload({
    payload,
    env,
    runner,
    tempRoot,
  });
  verifySignature({ payload, signature });
  log("token:publish: signature verifies against plugins.updater.pubkey.");

  const body = buildHostedTokenFile({ token, signature });
  await putSpacesObject({ config, body, fetchFn, nowMs });
  const stored = await getSpacesObject({ config, fetchFn });
  if (!stored.equals(body)) {
    throw new Error(
      "Spaces read-back does not match the uploaded token file; the CDN was not flushed.",
    );
  }
  log("token:publish: uploaded and read back from the Spaces origin.");

  flushCdnPath({ config, env, runner });
  log(`token:publish: flushed ${MUSICKIT_TOKEN_OBJECT_KEY} on the CDN.`);
  const polls = await waitForPublicBytes({
    fetchFn,
    url: MUSICKIT_TOKEN_PUBLIC_URL,
    expected: body,
    sleep,
    attempts,
    intervalMs,
  });
  log(
    `token:publish: CDN serves the new file after ${polls} check(s); the token has ${daysLeft} days left.`,
  );
  return { published: true, skipped: false, daysLeft, exp, polls };
}

async function main(argv) {
  if (argv.includes("--check-live")) {
    try {
      const live = await checkLiveMusicKitToken();
      console.log(
        `token:check: ok, the hosted MusicKit token has ${live.daysLeft} days left and Apple accepts it.`,
      );
      return 0;
    } catch (error) {
      console.error(
        `token:check: FAILED: ${scrubSecrets(messageOf(error), process.env)}`,
      );
      return 1;
    }
  }
  try {
    await publishMusicKitToken({ ifExpiring: argv.includes("--if-expiring") });
    return 0;
  } catch (error) {
    console.error(
      `token:publish: FAILED: ${scrubSecrets(messageOf(error), process.env)}`,
    );
    return 1;
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
