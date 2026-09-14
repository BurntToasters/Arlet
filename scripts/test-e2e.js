#!/usr/bin/env node
// Deterministic application smoke gate. This verifies the production frontend
// build and its native/updater wiring without starting Tauri or contacting
// Apple Music, Azure, or GitHub.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const distDir = resolve(root, "dist");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function fail(message) {
  throw new Error(`[test:e2e] ${message}`);
}

function runBuild() {
  const isWindows = process.platform === "win32";
  const command = isWindows ? "cmd.exe" : "npm";
  const args = isWindows
    ? ["/d", "/s", "/c", "npm run build"]
    : ["run", "build"];
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 300_000,
    env: { ...process.env, CI: "1" },
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.error) {
    fail(`frontend build could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `frontend build failed (exit ${result.status ?? "unknown"}).\n${output}`,
    );
  }
  console.log("[test:e2e] production frontend build passed");
}

function resolveDistAsset(assetUrl, label) {
  let pathname;
  try {
    pathname = new URL(assetUrl, "http://arlet.test/").pathname;
  } catch {
    fail(`${label} has an invalid URL: ${assetUrl}`);
  }
  if (!pathname.startsWith("/assets/")) {
    fail(`${label} must be a local Vite asset: ${assetUrl}`);
  }
  const assetPath = resolve(distDir, `.${pathname}`);
  if (!assetPath.startsWith(`${distDir}${sep}`)) {
    fail(`${label} escapes the dist directory: ${assetUrl}`);
  }
  try {
    assert.ok(statSync(assetPath).isFile(), `${label} is not a file`);
  } catch (error) {
    fail(`${label} is missing: ${assetPath} (${error.message})`);
  }
  return assetPath;
}

function findAssetTag(html, tagName, attributeName, tagFilter = () => true) {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, "iu");
  const tag = html.match(new RegExp(tagPattern.source, "giu"))?.find(tagFilter);
  if (!tag) fail(`dist/index.html has no ${tagName} tag`);
  const attributePattern = new RegExp(
    `\\b${attributeName}=["']([^"']+)["']`,
    "iu",
  );
  const value = tag.match(attributePattern)?.[1];
  if (!value) fail(`dist/index.html ${tagName} has no ${attributeName}`);
  return { tag, value };
}

function requireText(value, needle, label) {
  assert.ok(
    value.includes(needle),
    `${label} is missing ${JSON.stringify(needle)}`,
  );
}

function verifyBuiltShell() {
  const html = read("dist/index.html");
  requireText(html, '<div id="app"></div>', "dist/index.html");
  requireText(
    html,
    "https://js-cdn.music.apple.com/musickit/v3/musickit.js",
    "dist/index.html",
  );

  const script = findAssetTag(html, "script", "src", (tag) =>
    /\btype=["']module["']/iu.test(tag),
  );
  assert.match(script.tag, /\btype=["']module["']/iu);
  const scriptPath = resolveDistAsset(script.value, "frontend entrypoint");
  const bundle = readFileSync(scriptPath, "utf8");
  assert.ok(
    bundle.length > 1_000,
    "frontend entrypoint bundle is unexpectedly small",
  );

  // These markers are emitted by separate runtime paths. Seeing them in the
  // same built entrypoint catches a disconnected entrypoint or tree-shaking
  // mistake while remaining independent of any provider account.
  for (const marker of [
    "Arlet shell ready.",
    "startupUpdateCheck",
    "get_app_info",
    "get_beta_updater_target",
    "Update downloaded",
    "Restart and update",
  ]) {
    requireText(bundle, marker, "frontend entrypoint bundle");
  }

  const stylesheet = findAssetTag(html, "link", "href", (tag) =>
    /\brel=["']stylesheet["']/iu.test(tag),
  );
  assert.match(stylesheet.tag, /\brel=["']stylesheet["']/iu);
  const stylesheetPath = resolveDistAsset(stylesheet.value, "stylesheet");
  const css = readFileSync(stylesheetPath, "utf8");
  for (const marker of [".app-shell", ".update-modal", ".sidebar"]) {
    requireText(css, marker, "built stylesheet");
  }
  console.log(
    "[test:e2e] built shell, updater modal, and native command wiring passed",
  );
}

function verifySourceContracts() {
  const entrypoint = read("src/main.tsx");
  requireText(
    entrypoint,
    'import { initializeApplication } from "./app-init.ts";',
    "src/main.tsx",
  );
  requireText(
    entrypoint,
    "void initializeApplication(appController, diagnosticsStore);",
    "src/main.tsx",
  );

  const startup = read("src/app-init.ts");
  requireText(startup, "await controller.loadSettings();", "src/app-init.ts");
  requireText(startup, "await controller.initialize();", "src/app-init.ts");
  requireText(
    startup,
    "void controller.startupUpdateCheck().catch",
    "src/app-init.ts",
  );

  const controller = read("src/app/controller.ts");
  requireText(
    controller,
    "updater.configure(settings);",
    "src/app/controller.ts",
  );
  requireText(
    controller,
    "startupUpdateCheck(): Promise<void>",
    "src/app/controller.ts",
  );

  const modal = read("src/components/UpdateReadyModal.tsx");
  requireText(modal, 'role="dialog"', "src/components/UpdateReadyModal.tsx");
  requireText(
    modal,
    "controller.dismissUpdate",
    "src/components/UpdateReadyModal.tsx",
  );
  requireText(
    modal,
    "controller.installUpdate()",
    "src/components/UpdateReadyModal.tsx",
  );
  console.log(
    "[test:e2e] startup ordering, settings configuration, and modal contracts passed",
  );
}

function main() {
  runBuild();
  verifyBuiltShell();
  verifySourceContracts();
  console.log(
    "[test:e2e] offline smoke complete; live Apple authorization, signed installers, Azure signing, and GitHub feeds remain separate gates",
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
