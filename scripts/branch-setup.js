#!/usr/bin/env node
// Safely select a release branch before vi synchronizes it. Never replace a
// branch while local work or commits that are not on origin could be lost.

import { execFileSync, spawnSync } from "node:child_process";
import npmCli from "./npm-cli.cjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    throw new Error(
      `git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
    );
  }
}

function requireCleanWorktree(cwd) {
  const dirty = git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty) {
    throw new Error(
      `Working tree is not clean; refusing to replace a branch or reset it:\n${dirty}`,
    );
  }
}

function currentBranch(cwd) {
  const branch = git(cwd, ["branch", "--show-current"]);
  if (!branch) {
    throw new Error(
      "Current checkout is detached HEAD; refusing branch setup.",
    );
  }
  return branch;
}

function gitConfig(cwd, key) {
  try {
    return git(cwd, ["config", "--get", key]);
  } catch {
    return "";
  }
}

// Read the configured upstream instead of resolving @{upstream}, which fails
// once a deleted remote branch has been pruned locally.
function currentUpstream(cwd, branch, remote) {
  const upstreamRemote = gitConfig(cwd, `branch.${branch}.remote`);
  const merge = gitConfig(cwd, `branch.${branch}.merge`);
  if (!upstreamRemote || !merge) {
    throw new Error(
      `Current branch ${branch} has no upstream; refusing branch setup.`,
    );
  }
  const upstream = `${upstreamRemote}/${merge.replace(/^refs\/heads\//, "")}`;
  const expected = `${remote}/${branch}`;
  if (upstream !== expected || merge !== `refs/heads/${branch}`) {
    throw new Error(
      `Current branch ${branch} must track ${expected}; current upstream is ${upstream}.`,
    );
  }
  return `refs/remotes/${upstream}`;
}

function commitExists(cwd, ref) {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** A deleted upstream is safe to leave only if origin still has every commit. */
function requireHeadOnRemote(cwd, remote, branch, upstreamRef) {
  const count = Number(
    git(cwd, ["rev-list", "--count", "HEAD", "--not", `--remotes=${remote}`]),
  );
  if (!Number.isInteger(count)) {
    throw new Error(`Could not compare ${branch} with ${remote} branches.`);
  }
  if (count > 0) {
    throw new Error(
      `Current upstream ${upstreamRef} was deleted from ${remote} and ${branch} has ${count} commit(s) on no ${remote} branch; push or preserve them before setup.`,
    );
  }
}

function requireCommitRef(cwd, ref, label) {
  try {
    git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    throw new Error(`${label} ${ref} does not exist after fetching origin.`);
  }
}

function aheadCount(cwd, remoteRef, localRef, label) {
  const counts = git(cwd, [
    "rev-list",
    "--left-right",
    "--count",
    `${remoteRef}...${localRef}`,
  ]);
  const match = /^(\d+)\s+(\d+)$/.exec(counts.trim());
  if (!match) throw new Error(`Could not compare ${label} with ${remoteRef}.`);
  const ahead = Number(match[2]);
  if (ahead > 0) {
    throw new Error(
      `${label} has ${ahead} unpublished commit(s) ahead of ${remoteRef}; push or preserve them before setup.`,
    );
  }
}

function hasLocalBranch(cwd, branch) {
  const result = spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd, stdio: "ignore", shell: false },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`Could not inspect local branch ${branch}.`);
}

function validateTarget(remote, branch) {
  if (remote !== "origin" || !["beta", "main"].includes(branch)) {
    throw new Error("Usage: node scripts/branch-setup.js origin <beta|main>.");
  }
  return `refs/remotes/${remote}/${branch}`;
}

/** Check every ref and worktree state before the caller performs a reset. */
function assertCurrentBranchSafe(cwd, remote = "origin") {
  requireCleanWorktree(cwd);
  const branch = currentBranch(cwd);
  const upstreamRef = currentUpstream(cwd, branch, remote);
  git(cwd, ["fetch", "--prune", remote]);
  requireCommitRef(cwd, upstreamRef, "Current upstream");
  aheadCount(cwd, upstreamRef, "HEAD", `Current branch ${branch}`);
  requireCleanWorktree(cwd);
  return { branch, remote, remoteRef: upstreamRef };
}

/** Check current and target branches before switch -C can replace the target. */
function assertTargetBranchSafe(cwd, remote, branch) {
  const targetRef = validateTarget(remote, branch);
  requireCleanWorktree(cwd);
  const current = currentBranch(cwd);
  const currentRef = currentUpstream(cwd, current, remote);
  git(cwd, ["fetch", "--prune", remote]);
  requireCommitRef(cwd, targetRef, "Target branch");
  if (commitExists(cwd, currentRef)) {
    aheadCount(cwd, currentRef, "HEAD", `Current branch ${current}`);
  } else {
    requireHeadOnRemote(cwd, remote, current, currentRef);
  }
  if (hasLocalBranch(cwd, branch)) {
    aheadCount(
      cwd,
      targetRef,
      `refs/heads/${branch}`,
      `target branch ${branch}`,
    );
  }
  requireCleanWorktree(cwd);
  if (currentBranch(cwd) !== current) {
    throw new Error("Current branch changed during preflight; refusing setup.");
  }
  return { targetRef, branch };
}

function runNpm(cwd, npm, args) {
  const result = spawnSync(npm.command, [...npm.prefixArgs, ...args], {
    cwd,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `npm ${args.join(" ")} failed with status ${result.status}.`,
    );
  }
}

function setupTargetBranch(cwd, remote, branch) {
  const { targetRef } = assertTargetBranchSafe(cwd, remote, branch);
  // Resolve npm before switching so an invalid invocation cannot follow the
  // branch replacement and leave setup half-complete.
  const npm = npmCli.npmInvocation();
  git(cwd, ["switch", "-C", branch, targetRef]);
  runNpm(cwd, npm, ["run", "vi"]);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    if (process.argv.length !== 4) {
      throw new Error(
        "Usage: node scripts/branch-setup.js origin <beta|main>.",
      );
    }
    setupTargetBranch(root, process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(
      `branch-setup: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export { assertCurrentBranchSafe, assertTargetBranchSafe, setupTargetBranch };
