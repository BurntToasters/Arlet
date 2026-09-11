import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatPhase0PreflightReport,
  hasDeveloperToken,
  parseEnvFile,
  resolveDeveloperTokenEnv,
  runPhase0Preflight,
} from "./phase0-preflight.js";

test("parseEnvFile ignores comments and quoted values", () => {
  const root = mkdtempSync(path.join(tmpdir(), "arlet-phase0-"));
  const filePath = path.join(root, ".env.local");
  writeFileSync(
    filePath,
    '# comment\nVITE_MUSICKIT_DEVELOPER_TOKEN="secret-token"\n',
    "utf8",
  );
  assert.deepEqual(parseEnvFile(filePath), {
    VITE_MUSICKIT_DEVELOPER_TOKEN: "secret-token",
  });
  rmSync(root, { recursive: true, force: true });
});

test(".env.local overrides .env for developer token", () => {
  const root = mkdtempSync(path.join(tmpdir(), "arlet-phase0-"));
  writeFileSync(
    path.join(root, ".env"),
    "VITE_MUSICKIT_DEVELOPER_TOKEN=from-env\n",
    "utf8",
  );
  writeFileSync(
    path.join(root, ".env.local"),
    "VITE_MUSICKIT_DEVELOPER_TOKEN=from-local\n",
    "utf8",
  );
  assert.equal(
    resolveDeveloperTokenEnv(root).VITE_MUSICKIT_DEVELOPER_TOKEN,
    "from-local",
  );
  assert.equal(hasDeveloperToken(root), true);
  rmSync(root, { recursive: true, force: true });
});

test("require-token mode fails when developer token missing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "arlet-phase0-"));
  assert.throws(
    () => runPhase0Preflight({ root, requireToken: true }),
    /VITE_MUSICKIT_DEVELOPER_TOKEN is missing/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("preflight report includes toolchain lines without token value", () => {
  const report = formatPhase0PreflightReport({
    nodeVersion: "v24.0.0",
    npmVersion: "12.0.2",
    rustToolchain: "stable",
    rustcVersion: "rustc 1.88.0",
    windowsBuild: "24H2 build 26100.1",
    webview2Version: "152.0.0.0",
    developerTokenConfigured: true,
  });
  assert.match(report, /Developer token configured: yes/);
  assert.match(report, /Node: v24.0.0/);
  assert.doesNotMatch(report, /secret-token/);
});

test("phase0 scripts are explicit-only aliases", () => {
  const scripts = JSON.parse(
    readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "package.json",
      ),
      "utf8",
    ),
  ).scripts;
  assert.equal(scripts["phase0:preflight"], "node scripts/phase0-preflight.js");
  assert.match(scripts["phase0:gate"], /phase0-preflight\.js --require-token/);
});

test("vite loads MusicKit env files from the repo root", () => {
  const config = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "vite.config.ts",
    ),
    "utf8",
  );
  assert.match(config, /envDir:\s*resolve\(import\.meta\.dirname\)/);
  assert.match(config, /root:\s*"src"/);
});

test("WebView2 lookup uses the Evergreen Runtime client GUID", () => {
  const script = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "phase0-preflight.js",
    ),
    "utf8",
  );
  assert.match(script, /F3017226-FE2A-4295-8BDF-00C3A9A7E4C5/);
  assert.doesNotMatch(script, /00C3A9A7EAC2/);
});
