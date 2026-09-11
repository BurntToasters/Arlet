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

function checkVersionSync(version) {
  const tauriConf = JSON.parse(
    fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  if (tauriConf.version !== version) {
    throw new Error(
      `src-tauri/tauri.conf.json version ${tauriConf.version} != package.json ${version}. Run sync-version.`,
    );
  }
  const cargo = fs.readFileSync(
    path.join(root, "src-tauri", "Cargo.toml"),
    "utf8",
  );
  if (!cargo.includes(`version = "${version}"`)) {
    throw new Error(
      `src-tauri/Cargo.toml does not contain version "${version}". Run sync-version.`,
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
  // A dev MusicKit token must not be configured for the production build.
  if (process.env.VITE_MUSICKIT_DEVELOPER_TOKEN?.trim()) {
    throw new Error(
      "VITE_MUSICKIT_DEVELOPER_TOKEN is set; unset it before a production release build.",
    );
  }
  const envLocal = path.join(root, ".env.local");
  if (fs.existsSync(envLocal)) {
    const staged = git(["status", "--porcelain=v1", "--untracked-files=all"]);
    const paths = porcelainPaths(staged);
    if (paths.some((p) => p === ".env.local" || p.startsWith(".env.local"))) {
      throw new Error(".env.local must never be staged in a release.");
    }
    console.warn(
      "release-preflight: warning: .env.local exists locally; ensure production builds do not embed it.",
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

function checkWindowsTargets() {
  const conf = JSON.parse(
    fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const targets = conf.bundle?.targets;
  if (!Array.isArray(targets) || !targets.includes("nsis")) {
    throw new Error('Bundle targets must include "nsis" for Windows releases.');
  }
}

function runPreflight() {
  const version = String(packageJson.version ?? "");
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
  checkVersionSync(version);
  checkUpdaterPubkey();
  checkWindowsTargets();
  checkCredentialLeaks();
  console.log(
    `release-preflight: ok (${version}, ${expectedBranch}@${head.slice(0, 12)})`,
  );
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    runPreflight();
  } catch (error) {
    console.error(
      `release-preflight: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export { expectedReleaseBranch };
