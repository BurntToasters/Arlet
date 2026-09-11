#!/usr/bin/env node
// Arlet safe cargo updater. Architecture inspired by Zinnia; implementation is original.
// Runs `cargo update` against the Tauri manifest, keeping Cargo.lock consistent.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  let manifestPath = resolve(root, "src-tauri", "Cargo.toml");
  const flagIndex = argv.indexOf("--manifest-path");
  if (flagIndex >= 0) {
    manifestPath = resolve(root, argv[flagIndex + 1] || manifestPath);
  }
  return {
    manifestPath,
    check: argv.includes("--check"),
  };
}

function runCargo(args, cwd) {
  console.log(`> cargo ${args.join(" ")}`);
  const result = spawnSync("cargo", args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cargo ${args.join(" ")} exited with ${result.status}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const { manifestPath, check } = parseArgs(argv);
  if (check) {
    runCargo(
      ["update", "--manifest-path", manifestPath, "--locked", "--dry-run"],
      root,
    );
    console.log("[cargo-safe-update] Check passed: lockfile is in sync.");
    return;
  }
  runCargo(["update", "--manifest-path", manifestPath], root);
  console.log("[cargo-safe-update] Done. Review Cargo.lock and run test:all.");
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectExecution()) {
  try {
    main();
  } catch (error) {
    console.error(
      `[cargo-safe-update] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export { parseArgs };
