#!/usr/bin/env node
// Arlet Windows Tauri build driver. Architecture inspired by Zinnia;
// implementation is original and scoped to Arlet (NSIS only, no 7-Zip or
// shell-extension steps).
//
// Usage:
//   node scripts/tauri-windows-build.js --target <triple> --bundles nsis

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertStableReleaseOverridesAllowed } from "./release-policy.cjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const args = process.argv.slice(2);

assertStableReleaseOverridesAllowed();

const skipSigning = process.env.SKIP_WIN_CODESIGN?.trim() === "1";
const requiredEnv = [
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_ARTIFACT_SIGNING_ENDPOINT",
  "AZURE_ARTIFACT_SIGNING_ACCOUNT",
  "AZURE_ARTIFACT_SIGNING_PROFILE",
  "AZURE_ARTIFACT_SIGNING_PUBLISHER",
  "AZURE_ARTIFACT_SIGNING_PUBLISHER_DN",
];

if (process.platform !== "win32") {
  throw new Error("Signed Windows builds must run on Windows.");
}

const missing = skipSigning
  ? []
  : requiredEnv.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(
    `Missing Artifact Signing environment variables: ${missing.join(", ")}. ` +
      "Set SKIP_WIN_CODESIGN=1 only for local unsigned builds.",
  );
}
if (skipSigning) {
  console.warn(
    "[tauri-windows-build] SKIP_WIN_CODESIGN=1; producing unsigned Windows artifacts.",
  );
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1] ?? "";
  const prefixed = args.find((a) => a.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : "";
}

const target = valueAfter("--target");
if (
  target !== "x86_64-pc-windows-msvc" &&
  target !== "aarch64-pc-windows-msvc"
) {
  throw new Error(
    `Unsupported --target "${target}" (expected x86_64-pc-windows-msvc or aarch64-pc-windows-msvc).`,
  );
}
const bundles = valueAfter("--bundles") || "nsis";

function run(cmd, cmdArgs, options = {}) {
  console.log(`> ${cmd} ${cmdArgs.join(" ")}`);
  const result = spawnSync(cmd, cmdArgs, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with ${result.status}`);
  }
}

function powershell(script, scriptArgs = []) {
  run("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join("scripts", script),
    ...scriptArgs,
  ]);
}

// Build via the Tauri CLI so tauri.conf.json remains the bundle authority.
const tauri = process.platform === "win32" ? "npx.cmd" : "npx";
run(tauri, [
  "tauri",
  "build",
  "--target",
  target,
  "--bundles",
  bundles,
  "--",
  "--locked",
]);

// Sign the produced installer + binaries, then verify.
if (!skipSigning) {
  const bundleDir = path.join(
    "src-tauri",
    "target",
    target,
    "release",
    "bundle",
  );
  if (!existsSync(path.join(root, bundleDir))) {
    throw new Error(`Expected bundle output missing: ${bundleDir}`);
  }
  // Safety net only: signCommand already signs during bundling, so files
  // carrying a valid signature are skipped rather than dual-signed.
  const signTargets = [path.join(bundleDir, "nsis")];
  for (const dir of signTargets) {
    const full = path.join(root, dir);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full)) {
      const file = path.join(full, entry);
      if (!statSync(file).isFile()) continue;
      if (!/\.(exe|msi)$/i.test(entry)) continue;
      powershell("windows-artifact-sign.ps1", [
        "-FilePath",
        file,
        "-SkipIfSigned",
      ]);
    }
  }
  powershell("verify-windows-authenticode.ps1", [
    "-TargetReleaseDir",
    path.join("src-tauri", "target", target, "release"),
  ]);
}

// Report the bundle outputs for the release log.
try {
  const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  console.log(
    `[tauri-windows-build] target=${target} bundles=${bundles} commit=${out}`,
  );
} catch {
  console.log(`[tauri-windows-build] target=${target} bundles=${bundles}`);
}
