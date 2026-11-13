#!/usr/bin/env node
// Arlet release preflight. Architecture inspired by Zinnia; implementation is
// original. Verifies branch/version hygiene plus Arlet-specific safety gates:
// no .p8 keys, a live signed MusicKit token, updater pubkey present.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isIgnorableReleaseDirtyPath,
  porcelainPaths,
} from "./release-session.js";
import { assertStableReleaseOverridesAllowed } from "./release-policy.cjs";
import { validateChangelogForVersion } from "./changelog.cjs";
import { verifyUpdaterSignaturePayload } from "./updater-signature-verifier.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);

// The hosted token file is published by scripts/publish-musickit-token.js.
export const MUSICKIT_TOKEN_PUBLIC_URL =
  "https://music-api.arlet.rosiecdn.win/musickit/arlet-token.json";
export const MUSICKIT_TOKEN_OBJECT_KEY = "musickit/arlet-token.json";
export const MUSICKIT_TOKEN_SIGNED_PREFIX =
  "arlet-musickit-developer-token-v1\n";
export const MUSICKIT_TOKEN_FILE_VERSION = 1;
export const MUSICKIT_TOKEN_FILE_MAX_BYTES = 1024;
// Live checks need 45 days left (weekly canary); publishing needs 170.
export const MUSICKIT_TOKEN_LIVE_MIN_DAYS = 45;
export const MUSICKIT_TOKEN_PUBLISH_MIN_DAYS = 170;
const APPLE_CATALOG_URL =
  "https://api.music.apple.com/v1/catalog/us/search?term=hello&types=songs&limit=1";
const DAY_SECONDS = 24 * 60 * 60;

function expectedReleaseBranch(version) {
  const numeric = "(?:0|[1-9]\\d*)";
  if (
    new RegExp(`^${numeric}\\.${numeric}\\.${numeric}-beta\\.${numeric}$`).test(
      version,
    )
  ) {
    return "beta";
  }
  if (new RegExp(`^${numeric}\\.${numeric}\\.${numeric}$`).test(version)) {
    return "main";
  }
  throw new Error(
    `Unsupported release version '${version}'; Arlet releases use beta or stable only.`,
  );
}

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function checkVersionSync() {
  try {
    execFileSync(
      process.execPath,
      [path.join(root, "scripts", "sync-version.js"), "--check"],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const stdout = error?.stdout ? String(error.stdout).trim() : "";
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    const detail = [stderr, stdout].filter(Boolean).join("\n");
    throw new Error(
      `Version files are not synchronized with package.json. Run npm run sync-version.\n${detail}`.trim(),
    );
  }
}

function checkChangelog(version) {
  const errors = validateChangelogForVersion(
    fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
    version,
  );
  if (errors.length > 0) {
    throw new Error(
      `Release notes are invalid for ${version}:\n${errors.join("\n")}`,
    );
  }
}

function checkUpdaterPubkey() {
  const conf = JSON.parse(
    fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const pubkey = conf.plugins?.updater?.pubkey;
  if (typeof pubkey !== "string" || !pubkey.trim()) {
    throw new Error(
      "Updater pubkey is missing in src-tauri/tauri.conf.json (plugins.updater.pubkey).",
    );
  }
}

function checkCredentialLeaks() {
  // .p8 Media Services keys must never exist in the worktree.
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name === "target"
      ) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".p8")) {
        found.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  if (found.length > 0) {
    throw new Error(
      `Media Services private key file(s) in worktree (never ship .p8): ${found.join(", ")}`,
    );
  }
  // MusicKit tokens live in `.env` like postal-snap secrets. They must not
  // be Vite-prefixed; Rust reads them (runtime in debug, build.rs in release).
  const viteConfig = fs.readFileSync(path.join(root, "vite.config.ts"), "utf8");
  if (viteConfig.includes("VITE_MUSICKIT_DEVELOPER_TOKEN")) {
    throw new Error(
      "vite.config.ts must not expose VITE_MUSICKIT_DEVELOPER_TOKEN. Use MUSICKIT_DEVELOPER_TOKEN in .env.",
    );
  }
  const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  if (!envExample.includes("MUSICKIT_DEVELOPER_TOKEN=")) {
    throw new Error(".env.example must document MUSICKIT_DEVELOPER_TOKEN.");
  }
  const staged = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const paths = porcelainPaths(staged);
  if (paths.some((p) => p === ".env" || p.startsWith(".env."))) {
    throw new Error(".env must never be staged in a release.");
  }
  if (fs.existsSync(path.join(root, ".env.local"))) {
    console.warn(
      "release-preflight: warning: .env.local is ignored. House style is `.env`.",
    );
  }
  // Private-key markers must not be staged. The staged content is scanned;
  // file names alone can never contain the marker.
  const diff = (() => {
    try {
      return git(["diff", "--cached", "-U0", "--no-color", "--text"]);
    } catch {
      return "";
    }
  })();
  if (diff && /^\+.*-----BEGIN[A-Z ]*PRIVATE KEY-----/m.test(diff)) {
    throw new Error("Staged diff appears to contain a private key.");
  }
}

function checkWindowsTargets() {
  const conf = JSON.parse(
    fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const targets = conf.bundle?.targets;
  if (!Array.isArray(targets) || !targets.includes("nsis")) {
    throw new Error('Bundle targets must include "nsis" for Windows releases.');
  }
}

// The ARM64 build compiles `ring` with clang, found only on the VS developer
// shell PATH (`npm run wc`). Fail before tests and the draft, not mid-build.
function checkArm64Clang() {
  if (process.platform !== "win32") return;
  try {
    execFileSync("clang", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "clang is not on PATH; the ARM64 build needs it. Run `npm run wc` and release from inside that shell (VS needs the C++ Clang tools component).",
    );
  }
}

const messageOf = (error) =>
  error instanceof Error ? error.message : String(error);

/**
 * Shape and policy checks for a MusicKit developer JWT. Errors never include
 * the token. Days left are whole days, rounded down.
 */
export function checkMusicKitTokenPolicy(
  token,
  { nowSeconds = Math.floor(Date.now() / 1000), minRemainingDays = 0 } = {},
) {
  const segments = String(token ?? "")
    .trim()
    .split(".");
  const decode = (segment) => {
    try {
      return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    } catch {
      return undefined;
    }
  };
  const header = segments.length === 3 ? decode(segments[0]) : undefined;
  const payload = segments.length === 3 ? decode(segments[1]) : undefined;
  if (header?.alg !== "ES256" || !Number.isSafeInteger(payload?.exp)) {
    throw new Error(
      "MusicKit developer token is not an ES256 JWT with an integer exp claim.",
    );
  }
  // Apple refuses library (/v1/me) requests from an origin-restricted token,
  // even from the release origin. Mirrors build.rs.
  if (payload.origin !== undefined) {
    throw new Error(
      "MusicKit developer token has an origin claim; Apple then refuses library (/v1/me) requests. Mint it without MUSICKIT_TOKEN_ORIGINS.",
    );
  }
  const remaining = payload.exp - nowSeconds;
  if (remaining <= 0) {
    throw new Error("MusicKit developer token has expired.");
  }
  const daysLeft = Math.floor(remaining / DAY_SECONDS);
  if (daysLeft < minRemainingDays) {
    throw new Error(
      `MusicKit developer token expires in ${daysLeft} day(s); at least ${minRemainingDays} are required.`,
    );
  }
  return { exp: payload.exp, daysLeft };
}

// The Apple catalog answers 200 only for a token Apple signed for this team.
// A JWT that passes the policy checks can still be rejected (wrong key ID, no
// Media Services). Fails closed and never includes the token in an error.
export async function checkMusicKitTokenAcceptedByApple(
  token,
  fetchFn = globalThis.fetch,
) {
  let response;
  try {
    response = await fetchFn(APPLE_CATALOG_URL, {
      headers: { Authorization: `Bearer ${String(token ?? "").trim()}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : "request failed";
    throw new Error(
      `Could not reach the Apple Music API to verify the MusicKit developer token (${reason}).`,
    );
  }
  if (response.status !== 200) {
    throw new Error(
      `Apple Music API rejected the MusicKit developer token (HTTP ${response.status}). Check the Media Services key ID and .p8 for the team, then run npm run token:publish.`,
    );
  }
}

const HOSTED_FILE_KEYS = ["signature", "token", "version"];

/**
 * Parses the hosted file: exactly version, token, and signature, under 1 KB.
 * Errors describe the defect, never the file's contents.
 */
export function parseHostedTokenFile(bytes) {
  if (bytes.length >= MUSICKIT_TOKEN_FILE_MAX_BYTES) {
    throw new Error(
      `The hosted MusicKit token file must stay under 1 KB (it is ${bytes.length} bytes).`,
    );
  }
  let file;
  try {
    file = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("The hosted MusicKit token file is not valid JSON.");
  }
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new Error("The hosted MusicKit token file must be a JSON object.");
  }
  if (Object.keys(file).sort().join(",") !== HOSTED_FILE_KEYS.join(",")) {
    throw new Error(
      "The hosted MusicKit token file must have exactly the keys version, token, and signature.",
    );
  }
  if (file.version !== MUSICKIT_TOKEN_FILE_VERSION) {
    throw new Error(
      `The hosted MusicKit token file has unsupported version ${String(file.version)}; expected 1.`,
    );
  }
  if (
    typeof file.token !== "string" ||
    !file.token.trim() ||
    typeof file.signature !== "string" ||
    !file.signature.trim()
  ) {
    throw new Error(
      "The hosted MusicKit token file needs non-empty token and signature strings.",
    );
  }
  return {
    version: file.version,
    token: file.token.trim(),
    signature: file.signature.trim(),
  };
}

/** The exact bytes the Tauri signer signs and the updater key verifies. */
export function signedMusicKitTokenPayload(token) {
  return Buffer.from(`${MUSICKIT_TOKEN_SIGNED_PREFIX}${token}`, "utf8");
}

/**
 * Runs every live check on the hosted file and never throws: the result says
 * whether the file is usable (`ok`), its whole days left, and the first
 * `problem`. `minRemainingDays` 0 still rejects an expired token.
 */
export async function inspectHostedMusicKitToken({
  fetchFn = globalThis.fetch,
  url = MUSICKIT_TOKEN_PUBLIC_URL,
  nowSeconds = Math.floor(Date.now() / 1000),
  minRemainingDays = 0,
  verifySignature = null,
} = {}) {
  const fail = (problem) => ({ ok: false, daysLeft: null, exp: null, problem });
  let response;
  try {
    response = await fetchFn(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return fail(`${url} is unreachable (${error?.name ?? "request failed"})`);
  }
  if (response.status === 404) {
    return fail(`${url} is not published (HTTP 404)`);
  }
  if (response.status !== 200) {
    return fail(`${url} answered HTTP ${response.status}`);
  }
  let file;
  try {
    const bytes = Buffer.from(await response.arrayBuffer());
    file = parseHostedTokenFile(bytes);
  } catch (error) {
    return fail(messageOf(error));
  }
  let policy;
  try {
    policy = checkMusicKitTokenPolicy(file.token, {
      nowSeconds,
      minRemainingDays,
    });
  } catch (error) {
    return fail(messageOf(error));
  }
  try {
    await checkMusicKitTokenAcceptedByApple(file.token, fetchFn);
  } catch (error) {
    return fail(messageOf(error));
  }
  if (verifySignature) {
    try {
      verifySignature({
        payload: signedMusicKitTokenPayload(file.token),
        signature: file.signature,
      });
    } catch (error) {
      return fail(messageOf(error));
    }
  }
  return {
    ok: true,
    daysLeft: policy.daysLeft,
    exp: policy.exp,
    problem: null,
  };
}

/**
 * Release gate and `token:check`: the hosted file must be valid with at least
 * 45 days left. Pass `verifySignature` to also check the cryptographic
 * signature (the release preflight does; the keyless canary does not).
 */
export async function checkLiveMusicKitToken({
  fetchFn = globalThis.fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
  minRemainingDays = MUSICKIT_TOKEN_LIVE_MIN_DAYS,
  url = MUSICKIT_TOKEN_PUBLIC_URL,
  verifySignature = null,
} = {}) {
  const live = await inspectHostedMusicKitToken({
    fetchFn,
    nowSeconds,
    minRemainingDays,
    url,
    verifySignature,
  });
  if (!live.ok) {
    throw new Error(
      `Hosted MusicKit token check failed: ${live.problem}. Renew it with npm run token:publish.`,
    );
  }
  return { daysLeft: live.daysLeft, exp: live.exp };
}

async function runPreflight() {
  const version = String(packageJson.version ?? "");
  checkChangelog(version);
  assertStableReleaseOverridesAllowed(process.env, version);
  const expectedBranch = expectedReleaseBranch(version);
  const branch = git(["branch", "--show-current"]);
  if (branch !== expectedBranch) {
    throw new Error(
      `${version} must be released from ${expectedBranch}, not ${branch || "detached HEAD"}.`,
    );
  }
  const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty) {
    const dirtyPaths = porcelainPaths(dirty).filter(
      (filePath) => !isIgnorableReleaseDirtyPath(filePath),
    );
    if (dirtyPaths.length > 0) {
      throw new Error(
        `Working tree is not clean. Commit and push the exact release source first:\n${dirty}`,
      );
    }
  }
  git(["fetch", "--quiet", "origin"]);
  const upstream = git(["rev-parse", "--abbrev-ref", "@{upstream}"]);
  const expectedUpstream = `origin/${expectedBranch}`;
  if (upstream !== expectedUpstream) {
    throw new Error(
      `${expectedBranch} must track ${expectedUpstream}; current upstream is ${upstream}.`,
    );
  }
  const head = git(["rev-parse", "HEAD"]);
  const upstreamHead = git(["rev-parse", "@{upstream}"]);
  if (head !== upstreamHead) {
    throw new Error(
      `HEAD ${head.slice(0, 12)} does not match pushed ${expectedUpstream} ${upstreamHead.slice(0, 12)}.`,
    );
  }
  checkVersionSync();
  checkUpdaterPubkey();
  checkWindowsTargets();
  checkArm64Clang();
  checkCredentialLeaks();
  await checkLiveMusicKitToken({
    verifySignature: ({ payload, signature }) =>
      verifyUpdaterSignaturePayload({ root, payload, signature }),
  });
  console.log(
    `release-preflight: ok (${version}, ${expectedBranch}@${head.slice(0, 12)})`,
  );
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  runPreflight().catch((error) => {
    console.error(
      `release-preflight: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

export { checkChangelog, expectedReleaseBranch };
