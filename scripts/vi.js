#!/usr/bin/env node
// Arlet VM/branch setup helper. Architecture inspired by Zinnia; implementation
// is original. Syncs the current branch to its upstream and installs deps.

import { spawnSync, execSync } from "node:child_process";

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  if (res.status !== 0) {
    console.error(`Command failed: ${cmd} ${args.join(" ")}`);
    process.exit(res.status || 1);
  }
}

try {
  run("git", ["fetch", "origin"]);
  run("git", ["reset", "--hard", "@{u}"]);
  run("git", ["clean", "-fd"]);
  run("git", ["pull"]);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  run(npm, ["ci", "--ignore-scripts"]);

  const branch = execSync("git rev-parse --abbrev-ref HEAD", {
    encoding: "utf8",
  }).trim();
  console.log(
    `\n\x1b[32mVM Setup Complete. You are on branch ${branch}.\x1b[0m\n`,
  );
} catch (error) {
  console.error("vi script failed:", error);
  process.exit(1);
}
