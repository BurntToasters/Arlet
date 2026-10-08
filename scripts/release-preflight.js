#!/usr/bin/env node
// Arlet release preflight. Architecture inspired by Zinnia; implementation is
// original. Verifies branch/version hygiene plus Arlet-specific safety gates:
// no .p8 keys, no dev MusicKit tokens in prod, updater pubkey present.

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

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);

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
  // Private-key markers must not be staged.
  const diff = (() => {
    try {
      return git(["diff", "--cached", "--name-only"]);
    } catch {
      return "";
    }
  })();
  if (diff && /BEGIN.*PRIVATE KEY/.test(diff)) {
    throw new Error("Staged diff appears to contain a private key.");
  }
}

const MIN_TOKEN_REMAINING_SECONDS = 30 * 24 * 60 * 60;

/**
 * Early copy of the build.rs embed gate so an expiring token fails before a
 * draft release exists. Messages never include the token.
 */
function checkMusicKitToken(
  env = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (env.ARLET_SKIP_MUSICKIT_TOKEN !== undefined) {
    throw new Error(
      "ARLET_SKIP_MUSICKIT_TOKEN must not be set for a release build.",
    );
  }
  const token = String(env.MUSICKIT_DEVELOPER_TOKEN ?? "").trim();
  if (!token) {
    throw new Error(
      "MUSICKIT_DEVELOPER_TOKEN is missing from the release .env; release builds embed it.",
    );
  }
  const segments = token.split(".");
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
      "MUSICKIT_DEVELOPER_TOKEN is not an ES256 JWT with an integer exp claim.",
    );
  }
  const remaining = payload.exp - nowSeconds;
  if (remaining < MIN_TOKEN_REMAINING_SECONDS) {
    throw new Error(
      `MUSICKIT_DEVELOPER_TOKEN expires in ${Math.max(0, Math.floor(remaining / 86400))} day(s); mint a new one (npm run phase0:mint-token).`,
    );
  }
  // Apple refuses library (/v1/me) requests from an origin-restricted token,
  // even from the release origin (0.1.0). Mirrors build.rs.
  if (payload.origin !== undefined) {
    throw new Error(
      "MUSICKIT_DEVELOPER_TOKEN has an origin claim; Apple then refuses library (/v1/me) requests. Mint the release token without MUSICKIT_TOKEN_ORIGINS.",
    );
  }
  return { exp: payload.exp };
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

// The static checks cannot tell whether Apple accepts the token: a JWT
// signed with a key Apple rejects (wrong key ID, no Media Services) still
// lets MusicKit configure and sign in, then every API call fails. Fails
// closed and never prints the token.
async function checkMusicKitTokenAcceptedByApple(
  env = process.env,
  fetchFn = globalThis.fetch,
) {
  const token = String(env.MUSICKIT_DEVELOPER_TOKEN ?? "").trim();
  let response;
  try {
    response = await fetchFn(
      "https://api.music.apple.com/v1/catalog/us/search?term=hello&types=songs&limit=1",
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.name : "request failed";
    throw new Error(
      `Could not reach the Apple Music API to verify MUSICKIT_DEVELOPER_TOKEN (${reason}).`,
    );
  }
  if (response.status !== 200) {
    throw new Error(
      `Apple Music API rejected MUSICKIT_DEVELOPER_TOKEN (HTTP ${response.status}). Check that MUSICKIT_KEY_ID and MUSICKIT_P8_PATH name a Media Services key in the MUSICKIT_TEAM_ID team, then run npm run release:mint-token.`,
    );
  }
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
  checkMusicKitToken();
  await checkMusicKitTokenAcceptedByApple();
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

export {
  checkChangelog,
  checkMusicKitToken,
  checkMusicKitTokenAcceptedByApple,
  expectedReleaseBranch,
};
