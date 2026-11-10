#!/usr/bin/env node
// Arlet VM/branch setup helper. Architecture inspired by Zinnia; implementation
// is original. Syncs the current branch to its upstream and installs deps.

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import npmCli from "./npm-cli.cjs";
import { assertCurrentBranchSafe } from "./branch-setup.js";

function run(root, cmd, args) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (res.error) console.error(res.error);
  if (res.status !== 0) {
    console.error(`Command failed: ${cmd} ${args.join(" ")}`);
    process.exit(res.status || 1);
  }
}

function runSetup(root) {
  // Resolve npm first, then verify clean work plus both branch and upstream
  // state before reset or clean can remove anything.
  const npm = npmCli.npmInvocation();
  const { branch, remote, remoteRef } = assertCurrentBranchSafe(root);
  run(root, "git", ["reset", "--hard", remoteRef]);
  run(root, "git", ["clean", "-fd"]);
  run(root, "git", ["pull", "--ff-only", remote, branch]);
  // Runs npm-cli.js through node (npm_execpath), so no .cmd shim or shell.
  run(root, npm.command, [...npm.prefixArgs, "ci", "--ignore-scripts"]);

  console.log(
    `\n\x1b[32mVM Setup Complete. You are on branch ${branch}.\x1b[0m\n`,
  );
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    runSetup(root);
  } catch (error) {
    console.error("vi script failed:", error);
    process.exit(1);
  }
}

export { runSetup };
