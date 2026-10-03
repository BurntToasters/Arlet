#!/usr/bin/env node
// Final release step: return the checkout to the pushed upstream tip. The
// reset and clean are destructive, so they run only when the only local
// changes are release by-products and no local commits would be dropped.
//
// Usage: node scripts/finalize-reset.js [--check]

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isIgnorableReleaseDirtyPath,
  porcelainPaths,
} from "./release-session.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

export function unsafeResetReasons({ porcelain, aheadCount }) {
  const reasons = [];
  const userPaths = porcelainPaths(porcelain).filter(
    (filePath) => !isIgnorableReleaseDirtyPath(filePath),
  );
  if (userPaths.length > 0) {
    reasons.push(
      `uncommitted changes outside release by-products:\n  ${userPaths.join("\n  ")}`,
    );
  }
  if (aheadCount > 0) {
    reasons.push(`${aheadCount} local commit(s) not on the upstream branch`);
  }
  return reasons;
}

function main() {
  const checkOnly = process.argv.includes("--check");
  git(["fetch", "--quiet", "origin"]);
  const reasons = unsafeResetReasons({
    porcelain: git(["status", "--porcelain=v1", "--untracked-files=all"]),
    aheadCount: Number(git(["rev-list", "--count", "@{upstream}..HEAD"])),
  });
  if (reasons.length > 0) {
    throw new Error(
      `Refusing git reset --hard / git clean: ${reasons.join("; ")}`,
    );
  }
  if (checkOnly) {
    console.log("finalize-reset: safe to reset (check only).");
    return;
  }
  git(["reset", "--hard", "@{upstream}"]);
  git(["clean", "-fd"]);
  console.log("finalize-reset: checkout reset to upstream.");
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    console.error(
      `finalize-reset: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
