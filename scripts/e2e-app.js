#!/usr/bin/env node
// Native end-to-end gate (Windows, opt-in). Builds a release binary with a
// synthetic MusicKit token, drives the real app over WebView2's DevTools
// Protocol, and writes e2e-artifacts/<timestamp>/{report.json,screenshot.png,
// arlet.log}. Each run uses an isolated marked data and WebView2 profile.
// The failure modes it covers are listed in docs/TESTING.md.
//
// Usage: node scripts/e2e-app.js [--skip-build] [--real-token] [--foreground]
//   [--scenarios name1,name2]
// --real-token embeds MUSICKIT_DEVELOPER_TOKEN from the environment and checks
// that Apple accepts it from the release origin (catalog request, no sign-in).
// Arlet launches in the background (never the active window, behind other
// windows) so a run does not take the keyboard; --foreground opts out.

import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MUSIC_FIXTURE_SEED, musicFixtureSource } from "./e2e-music-fixture.js";
import { runLibraryActions } from "./e2e-library-actions.js";
import { runPlaylistPlayback } from "./e2e-playlist-playback.js";
import { runFlows } from "./e2e-flows.js";
import { runLibraryView } from "./e2e-library-view.js";
import { runShortcuts } from "./e2e-shortcuts.js";
import { runMultiSelect } from "./e2e-multi-select.js";
import { runMiniPlayer } from "./e2e-mini-player.js";
import { runSongNavigation } from "./e2e-song-navigation.js";
import { runTransport } from "./e2e-transport.js";
import { runQueueEdit } from "./e2e-queue-edit.js";
import { runNowPlaying } from "./e2e-now-playing.js";
import { runRadioArtist } from "./e2e-radio-artist.js";
import { runUnavailable } from "./e2e-unavailable.js";
import { runLayout } from "./e2e-layout.js";
import { desktopEventRecorderSource, runDesktop } from "./e2e-desktop.js";
import { runPerformance } from "./e2e-performance.js";
import { runPolish } from "./e2e-polish.js";
import { runDiscovery } from "./e2e-discovery.js";
import { runArtwork } from "./e2e-artwork.js";
import { runAccountSession } from "./e2e-account-session.js";
import { runAuditFixes } from "./e2e-audit-fixes.js";
import { runAuditRegressions } from "./e2e-audit-regressions.js";
import { runSessionRestore } from "./e2e-session-restore.js";
import { sleep } from "./e2e-helpers.js";
import { connectCdp, findPageTarget } from "./e2e-cdp.js";
import { withE2eProfileSetup } from "./e2e-profile.js";
import { startForegroundMonitor } from "./e2e-foreground.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_DIR = path.join(root, "src-tauri", "target", "e2e");
const EXE = path.join(TARGET_DIR, "release", "arlet.exe");
const E2E_BUILD_PROOF = path.join(TARGET_DIR, "e2e-feature-build.json");
let DEBUG_PORT;
let e2eProfileRoot;
let e2eProfileOwnership;
let processVerificationFailed = false;
const ownedAppPids = new Set();
// Launch-at-startup writes its Run value here, never to the real Run key:
// the app reads ARLET_E2E_RUN_KEY (Rust side) and the whole key is removed
// before and after each run.
const E2E_RUN_KEY = "Software\\ArletE2E\\Run";
const E2E_REG_ROOT = "HKCU\\Software\\ArletE2E";
// TEMP_WEBVIEW2_LOCKOUT_WORKAROUND: TEMPORARY UPSTREAM WORKAROUND, REMOVE when fixed.
// Cause: a fresh WebView2 environment can generate a failed Windows interactive
// logon (Event 4625); repeated launches increment the bad-password counter and
// can lock the account. The app is not trying passwords. Disabling the Chromium
// feature below is the workaround (Windows only).
// Tracking: MicrosoftEdge/WebView2Feedback #5722, Chromium #562403601.
// REMOVE only after the fixed stable WebView2 runtime is installed and several
// fresh-profile launches log no matching Event 4625 (Logon Type 2, Advapi,
// 0xC000006D/0xC000006A, msedgewebview2.exe) and the E2E passes without it.
// Chromium runs the probe when either feature is enabled
// (chrome_autofill_client.cc).
// Cleanup: delete this const and its use in buildWebView2Args only.
const TEMP_WEBVIEW2_LOCKOUT_WORKAROUND = [
  "AutofillAiWalletPrivatePasses",
  "AutofillAmbientAutofill",
];
const RUNTIME_ENV_TOKEN = "runtime-env-token-must-be-ignored";
// Mirrors RELEASE_ORIGIN in src-tauri/src/token_policy.rs.
const RELEASE_ORIGIN = "http://tauri.localhost";
// Apple's live MusicKit script. Each marker group lists alternatives; one must
// appear in the script text (docs/TESTING.md "Audit fixes", item 3).
const MUSICKIT_LIVE_SCRIPT_URL =
  "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
const LIVE_SCRIPT_MARKERS = [
  ["suppressErrorDialog"],
  ["MKDialog"],
  ['"lease-action"'],
  ["stopLicenseSession", "_license.stop"],
  ["userTokenIsValid"],
];
const USER_TOKEN = "AqmL0f7xY2/Zp+Q9wR3kT8vN1bC4dE6gH5jK7mP0sU2yW==";
const SCENARIO_REGISTRY = [
  ["playlist-playback", runPlaylistPlayback],
  ["song-navigation", runSongNavigation],
  ["transport", runTransport],
  ["queue-edit", runQueueEdit],
  ["library-actions", runLibraryActions],
  ["now-playing", runNowPlaying],
  ["radio-artist", runRadioArtist],
  ["unavailable", runUnavailable],
  ["layout", runLayout],
  ["desktop", runDesktop],
  ["flows", runFlows],
  ["library-view", runLibraryView],
  ["shortcuts", runShortcuts],
  ["multi-select", runMultiSelect],
  ["mini-player", runMiniPlayer],
  ["performance", runPerformance],
  ["polish", runPolish],
  ["discovery", runDiscovery],
  ["artwork", runArtwork],
  ["audit-fixes", runAuditFixes],
  ["audit-regressions", runAuditRegressions],
  ["account-session", runAccountSession],
  // Last in the full suite because it signs out at the end.
  ["session-restore", runSessionRestore],
];

function selectScenarios(argv) {
  const selectedValues = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--scenarios") {
      if (selectedValues.length) {
        return {
          selectedScenarios: [],
          fullSuite: false,
          error: "use --scenarios once",
        };
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        return {
          selectedScenarios: [],
          fullSuite: false,
          error: "--scenarios needs a comma-separated scenario list",
        };
      }
      selectedValues.push(value);
      index += 1;
    } else if (argument.startsWith("--scenarios=")) {
      if (selectedValues.length) {
        return {
          selectedScenarios: [],
          fullSuite: false,
          error: "use --scenarios once",
        };
      }
      selectedValues.push(argument.slice("--scenarios=".length));
    }
  }

  if (!selectedValues.length) {
    return {
      selectedScenarios: SCENARIO_REGISTRY.map(([name]) => name),
      fullSuite: true,
      error: null,
    };
  }

  const names = selectedValues[0].split(",").map((name) => name.trim());
  if (names.some((name) => !name)) {
    return {
      selectedScenarios: [],
      fullSuite: false,
      error: "scenario names must not be empty",
    };
  }
  if (new Set(names).size !== names.length) {
    return {
      selectedScenarios: [],
      fullSuite: false,
      error: "scenario names must be unique",
    };
  }
  const available = new Set(SCENARIO_REGISTRY.map(([name]) => name));
  const unknown = names.filter((name) => !available.has(name));
  if (unknown.length) {
    return {
      selectedScenarios: [],
      fullSuite: false,
      error:
        "unknown scenario(s): " +
        unknown.join(", ") +
        "; available: " +
        [...available].join(", "),
    };
  }
  return { selectedScenarios: names, fullSuite: false, error: null };
}

function fail(message) {
  throw new Error(`[e2e-app] ${message}`);
}

// Builds WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS from the developer's value plus
// extra switches. Feature lists are merged into one switch each so no list
// silently replaces another; other switches are kept once, first-seen order.
function buildWebView2Args(...extraSwitches) {
  const inherited = (
    process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ?? ""
  ).split(/\s+/u);
  const safeInherited = [];
  for (let index = 0; index < inherited.length; index += 1) {
    const token = inherited[index];
    if (
      /^--(?:remote-debugging-port|remote-debugging-address|user-data-dir)(?:=|$)/iu.test(
        token,
      )
    ) {
      if (!token.includes("=")) index += 1;
    } else if (
      /^--(?:no-sandbox|disable-web-security|allow-running-insecure-content)(?:=|$)/iu.test(
        token,
      )
    ) {
      continue;
    } else if (token) {
      safeInherited.push(token);
    }
  }
  const tokens = [...safeInherited, ...extraSwitches];
  const ordered = [];
  const featureLists = new Map();
  const addFeatures = (prefix, names) => {
    if (!featureLists.has(prefix)) {
      featureLists.set(prefix, []);
      ordered.push(prefix);
    }
    const list = featureLists.get(prefix);
    for (const name of names) {
      const feature = name.trim();
      if (feature && !list.includes(feature)) list.push(feature);
    }
  };
  for (const token of tokens) {
    if (!token) continue;
    const match = /^(--(?:disable|enable)-features=)(.*)$/.exec(token);
    if (match) {
      addFeatures(match[1], match[2].split(","));
    } else if (!ordered.includes(token)) {
      ordered.push(token);
    }
  }
  if (process.platform === "win32") {
    addFeatures("--disable-features=", TEMP_WEBVIEW2_LOCKOUT_WORKAROUND);
  }
  return ordered
    .filter((item) => !featureLists.has(item) || featureLists.get(item).length)
    .map((item) =>
      featureLists.has(item)
        ? `${item}${featureLists.get(item).join(",")}`
        : item,
    )
    .join(" ");
}

function syntheticToken() {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 120 * 24 * 60 * 60;
  return `${encode({ alg: "ES256", kid: "E2ETEST" })}.${encode({ iss: "E2E", iat: 0, exp })}.${Buffer.from("e2e-signature").toString("base64url")}`;
}

function tokenFingerprint(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function detectTokenMode(token) {
  try {
    const [headerPart, payloadPart] = String(token).split(".");
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString());
    const payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString(),
    );
    return header.kid === "E2ETEST" && payload.iss === "E2E"
      ? "synthetic"
      : "real";
  } catch {
    return "unknown";
  }
}

function build(token, tokenMode) {
  const env = { ...process.env, CARGO_TARGET_DIR: TARGET_DIR };
  env.MUSICKIT_DEVELOPER_TOKEN = token;
  delete env.ARLET_SKIP_MUSICKIT_TOKEN;
  const result = spawnSync(
    "cmd.exe",
    ["/d", "/s", "/c", "npx tauri build --no-bundle --features e2e"],
    { cwd: root, env, stdio: "inherit", windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    fail(
      `E2E release build failed (${result.error?.message ?? result.status})`,
    );
  }
  if (!fs.existsSync(EXE)) fail(`E2E build did not produce ${EXE}`);
  const sha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(EXE))
    .digest("hex");
  fs.writeFileSync(
    E2E_BUILD_PROOF,
    `${JSON.stringify(
      {
        feature: "e2e",
        tokenMode,
        tokenFingerprint: tokenFingerprint(token),
        builtAt: new Date().toISOString(),
        sha256,
      },
      null,
      2,
    )}\n`,
  );
}

function verifyE2eBuildProof(
  token,
  tokenMode,
  { allowRefreshedSyntheticToken = false } = {},
) {
  if (!fs.existsSync(EXE)) fail(`missing ${EXE}`);
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(E2E_BUILD_PROOF, "utf8"));
  } catch {
    fail(
      "--skip-build requires a prior E2E-feature build recorded by this harness",
    );
  }
  const sha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(EXE))
    .digest("hex");
  if (
    proof?.feature !== "e2e" ||
    proof.sha256 !== sha256 ||
    proof.tokenMode !== tokenMode ||
    !/^[a-f0-9]{64}$/u.test(proof.tokenFingerprint ?? "")
  ) {
    fail("--skip-build binary does not match the verified E2E-feature build");
  }
  if (
    (!allowRefreshedSyntheticToken || tokenMode !== "synthetic") &&
    proof.tokenFingerprint !== tokenFingerprint(token)
  ) {
    fail("E2E build token does not match the requested token mode and value");
  }
  return proof;
}

function dataDirs() {
  if (!e2eProfileRoot || !path.isAbsolute(e2eProfileRoot)) {
    fail("the isolated E2E profile root has not been initialized");
  }
  return {
    root: e2eProfileRoot,
    data: path.join(e2eProfileRoot, "data"),
    local: path.join(e2eProfileRoot, "local"),
    logs: path.join(e2eProfileRoot, "logs"),
    webview: path.join(e2eProfileRoot, "webview"),
  };
}

/**
 * Injected for the expired-token check only: answers `get_developer_token`
 * with the release build's expiry error, as Tauri's IPC protocol does.
 */
const EXPIRED_TOKEN_SOURCE = `(() => {
  if (sessionStorage.getItem("arlet-e2e-expired-token") !== "1") return;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const url = new URL(String(input?.url ?? input));
      if (
        url.hostname === "ipc.localhost" &&
        decodeURIComponent(url.pathname.slice(1)) === "get_developer_token"
      ) {
        return Promise.resolve(
          new Response(
            JSON.stringify("Arlet's Apple Music access token has expired. Install the latest Arlet update."),
            { headers: { "Content-Type": "application/json", "Tauri-Response": "error" } },
          ),
        );
      }
    } catch {}
    return nativeFetch(input, init);
  };
})();`;

// All files seeded by the harness stay below its fresh marked profile root.

/** The isolated profile's arlet.log (Tauri's app log dir), or "" when absent. */
function readTestLog() {
  try {
    return fs.readFileSync(path.join(dataDirs().logs, "arlet.log"), "utf8");
  } catch {
    return "";
  }
}

function seedCorruptSettings() {
  const roaming = dataDirs().data;
  fs.mkdirSync(roaming, { recursive: true });
  fs.writeFileSync(path.join(roaming, "settings.json"), '{"theme":');
  fs.writeFileSync(
    path.join(roaming, "settings.json.bak"),
    JSON.stringify({
      schemaVersion: 1,
      theme: "light",
      windowEffect: "solid",
      volume: 0.37,
    }),
  );
}

const CACHE_SCOPE = "current-account";

/** A cache written by the former SQL plugin: same tables, user_version 0. */
function seedLegacyCache() {
  const db = new DatabaseSync(path.join(dataDirs().data, "arlet-library.db"));
  try {
    db.exec(`
      CREATE TABLE music_resources (scope TEXT NOT NULL, resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, resource_type, resource_id));
      CREATE TABLE music_pages (scope TEXT NOT NULL, section TEXT NOT NULL,
        cursor TEXT NOT NULL, next_cursor TEXT, updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, section, cursor));
      CREATE TABLE music_page_items (scope TEXT NOT NULL, section TEXT NOT NULL,
        cursor TEXT NOT NULL, position INTEGER NOT NULL, resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL, PRIMARY KEY (scope, section, cursor, position));
      CREATE TABLE cache_meta (scope TEXT PRIMARY KEY, storefront TEXT, last_refresh_at INTEGER);
    `);
    const item = {
      id: "cached-1",
      type: "library-songs",
      resourceType: "library-songs",
      title: "Cached Song",
      artistName: "Cache Artist",
    };
    db.prepare("INSERT INTO music_resources VALUES (?, ?, ?, ?, ?)").run(
      CACHE_SCOPE,
      "library-songs",
      item.id,
      JSON.stringify(item),
      1,
    );
    db.prepare("INSERT INTO music_pages VALUES (?, 'songs', '', NULL, 1)").run(
      CACHE_SCOPE,
    );
    db.prepare(
      "INSERT INTO music_page_items VALUES (?, 'songs', '', 0, 'library-songs', ?)",
    ).run(CACHE_SCOPE, item.id);
    db.prepare("INSERT INTO cache_meta VALUES (?, 'us', 1)").run(CACHE_SCOPE);
  } finally {
    db.close();
  }
}

async function waitFor(page, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(`return Boolean(${expression});`)) return true;
    await sleep(250);
  }
  return false;
}

async function openAdvancedSettings(page) {
  const toggle =
    'document.querySelector(\'.settings-section[aria-labelledby="advanced-heading"] button[aria-controls="advanced-details"]\')';
  const found = await waitFor(page, toggle, 10_000);
  if (!found) return false;
  await page.evaluate(`
    const button = ${toggle};
    if (button?.getAttribute("aria-expanded") !== "true") button?.click();
    return true;`);
  return waitFor(
    page,
    `${toggle}?.getAttribute("aria-expanded") === "true" && document.getElementById("advanced-details")`,
    3000,
  );
}

// Mirrors DEFAULT_SETTINGS in src/state.ts.
const DEFAULT_SETTINGS_FOR_E2E = {
  schemaVersion: 1,
  theme: "system",
  windowEffect: "acrylic",
  autoCheckUpdates: true,
  updateChannel: "auto",
  volume: 1,
  autoplay: true,
  restoreSession: true,
  trayIcon: true,
  launchAtStartup: false,
  debugMode: false,
};

/** Polls a condition instead of guessing how long the app needs. */
async function waitUntil(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(250);
  }
  return condition();
}

/** Waits until this run's isolated app process has exited. */
function waitForArletExit(timeoutMs = 15_000) {
  return waitUntil(
    () => ownedProcessPids().every((pid) => !processAlive(pid)),
    timeoutMs,
  );
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (
    result.error ||
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    !result.stdout.trim()
  ) {
    processVerificationFailed = true;
    throw new Error(
      `could not verify process ${pid}: ${result.error?.message ?? result.stderr?.trim() ?? result.status ?? "missing tasklist output"}`,
    );
  }
  return new RegExp(`\\b${pid}\\b`, "u").test(result.stdout);
}

function readAppProcessRecord() {
  if (!e2eProfileRoot) return undefined;
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(e2eProfileRoot, "app.pid"), "utf8"),
    );
    if (
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      !Number.isFinite(value.startedAtUnixMs) ||
      !e2eProfileOwnership ||
      value.runId !== e2eProfileOwnership.runId ||
      value.ownerToken !== e2eProfileOwnership.ownerToken
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

// PID and start time recorded by the isolated app for safe restart tracking.
function runningArletInfo() {
  const value = readAppProcessRecord();
  return value && processAlive(value.pid) ? value : undefined;
}

function runningArletPid() {
  return runningArletInfo()?.pid;
}

function ownedProcessPids() {
  const candidates = new Set(ownedAppPids);
  const profileProcess = readAppProcessRecord();
  if (profileProcess?.pid) candidates.add(profileProcess.pid);
  return [...candidates];
}

// The settings reset restarts Arlet as a new process outside the original
// child's tree; run() refuses to start while any other Arlet is open.
/** Removes the test-only Run key; "not found" is expected and ignored. */
const FOREGROUND = process.argv.includes("--foreground");
// Read by background_launch.rs. The switches keep a window that sits behind
// others rendering at full speed, since Chromium throttles occluded windows.
const BACKGROUND_ENV = FOREGROUND ? {} : { ARLET_E2E_BACKGROUND: "1" };
const BACKGROUND_SWITCHES = FOREGROUND
  ? []
  : [
      "--disable-features=CalculateNativeWinOcclusion",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ];

function clearE2eRunKey() {
  const result = spawnSync("reg", ["delete", E2E_REG_ROOT, "/f"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (result.error) throw result.error;
  if (
    result.status !== 0 &&
    !/unable to find the specified registry key|cannot find the specified registry key/iu.test(
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    )
  ) {
    throw new Error(
      `registry cleanup failed (${result.status}): ${(result.stdout ?? result.stderr ?? "").trim()}`,
    );
  }
}

function isE2eExecutable(pid, startedAtUnixMs) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      '$ErrorActionPreference = "Stop"; try { $p = Get-CimInstance Win32_Process -Filter "ProcessId = $env:ARLET_E2E_PID" -ErrorAction Stop } catch { exit 2 }; if (-not $p -or -not $p.ExecutablePath -or -not [String]::Equals($p.ExecutablePath, $env:ARLET_E2E_EXE, [StringComparison]::OrdinalIgnoreCase)) { exit 1 }; if ($env:ARLET_E2E_STARTED_AT) { if (-not $p.CreationDate) { exit 1 }; $actual = ([DateTime]$p.CreationDate).ToUniversalTime(); $expected = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$env:ARLET_E2E_STARTED_AT).UtcDateTime; if ([Math]::Abs(($actual - $expected).TotalSeconds) -gt 30) { exit 1 } }; exit 0',
    ],
    {
      env: {
        ...process.env,
        ARLET_E2E_PID: String(pid),
        ARLET_E2E_EXE: EXE,
        ARLET_E2E_STARTED_AT: startedAtUnixMs ? String(startedAtUnixMs) : "",
      },
      stdio: "ignore",
      windowsHide: true,
      timeout: 5000,
    },
  );
  if (result.error || result.status === null || result.status === undefined) {
    processVerificationFailed = true;
    throw new Error(
      `could not verify E2E process identity for ${pid}: ${result.error?.message ?? result.stderr?.trim() ?? "PowerShell did not return a status"}`,
    );
  }
  if (result.status === 2 || (result.status !== 0 && result.status !== 1)) {
    processVerificationFailed = true;
    throw new Error(
      `could not verify E2E process identity for ${pid}: PowerShell exited with status ${result.status}`,
    );
  }
  return result.status === 0;
}

function killOwnedArlet() {
  const candidates = new Set(ownedAppPids);
  const profileProcess = runningArletInfo();
  if (profileProcess?.pid) candidates.add(profileProcess.pid);
  const failures = [];
  for (const pid of candidates) {
    let alive;
    try {
      alive = processAlive(pid);
    } catch (error) {
      failures.push({ pid, error: error.message });
      continue;
    }
    if (!alive) continue;
    const profileStart =
      profileProcess?.pid === pid ? profileProcess.startedAtUnixMs : undefined;
    let isOwned;
    try {
      isOwned = isE2eExecutable(pid, profileStart);
    } catch (error) {
      failures.push({ pid, error: error.message });
      continue;
    }
    if (!isOwned) continue;
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    let stillAlive;
    try {
      stillAlive = processAlive(pid);
    } catch (error) {
      failures.push({
        pid,
        error: `could not verify taskkill result: ${error.message}`,
      });
      continue;
    }
    if ((result.error || result.status !== 0) && stillAlive) {
      failures.push({
        pid,
        error: result.error?.message ?? `taskkill ${result.status}`,
      });
    }
  }
  return { candidates: [...candidates], failures };
}

// Physical pixels; deliberately not the 1000x700 default window.
const SEEDED_WINDOW_STATE = {
  x: 150,
  y: 110,
  width: 1100,
  height: 760,
  maximized: false,
};

/**
 * The main window's geometry as Arlet stores it: frame position
 * (GetWindowRect, which Tauri's outer_position reads) and client size
 * (GetClientRect, Tauri's inner_size). The page's screenX/innerHeight measure
 * the webview instead and differ by the invisible resize border.
 */
function nativeWindowGeometry() {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ArletE2eWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int maxCount);
  // The visible top-level window titled Arlet; MainWindowHandle can miss a
  // window that never became active (an E2E background launch).
  public static IntPtr Find(uint[] processIds) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, lParam) => {
      uint owner;
      GetWindowThreadProcessId(hwnd, out owner);
      if (Array.IndexOf(processIds, owner) < 0 || !IsWindowVisible(hwnd)) return true;
      var title = new System.Text.StringBuilder(64);
      GetWindowText(hwnd, title, title.Capacity);
      if (title.ToString() != "Arlet") return true;
      found = hwnd;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$ids = [uint32[]]@(Get-Process -Name arlet | ForEach-Object { $_.Id })
$handle = [ArletE2eWindow]::Find($ids)
$frame = New-Object ArletE2eWindow+RECT
$client = New-Object ArletE2eWindow+RECT
[void][ArletE2eWindow]::GetWindowRect($handle, [ref]$frame)
[void][ArletE2eWindow]::GetClientRect($handle, [ref]$client)
"{0} {1} {2} {3}" -f $frame.Left, $frame.Top, $client.Right, $client.Bottom`;
  const out = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" },
  ).stdout.trim();
  const [x, y, width, height] = out.split(/\s+/u).map(Number);
  return { x, y, width, height };
}

/** Visible top-level windows titled "Arlet" that belong to the process. */
function visibleArletWindows(pid) {
  const script = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ArletE2eVisibility {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
  public static int Count(uint processId) {
    int count = 0;
    EnumWindows((hwnd, lParam) => {
      uint owner;
      GetWindowThreadProcessId(hwnd, out owner);
      if (owner != processId || !IsWindowVisible(hwnd)) return true;
      StringBuilder title = new StringBuilder(64);
      GetWindowText(hwnd, title, title.Capacity);
      if (title.ToString() == "Arlet") count++;
      return true;
    }, IntPtr.Zero);
    return count;
  }
}
"@
[ArletE2eVisibility]::Count(${pid})`;
  const out = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" },
  ).stdout.trim();
  return Number(out);
}

const near = (actual, expected) => Math.abs(actual - expected) <= 2;

const invoke = (command, args = {}) =>
  `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`;

async function settle(page, command, args) {
  return page.evaluate(
    `try { return { ok: true, value: await ${invoke(command, args)} }; } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }`,
  );
}

// Run folders are named by the stamp written in run() (ISO time with ':' and
// '.' replaced by '-'), so only names of that exact shape are ever pruned.
const RUN_STAMP_PATTERN = /^\d{4}(?:-\d{2}){2}T(?:\d{2}-){2}\d{2}-\d{3}Z$/u;
const DEFAULT_KEEP_RUNS = 20;

function keepRunCount() {
  const raw = String(process.env.ARLET_E2E_KEEP_RUNS ?? "").trim();
  if (raw === "") return DEFAULT_KEEP_RUNS;
  if (!/^\d+$/u.test(raw)) {
    console.warn(
      `[e2e-app] ignoring ARLET_E2E_KEEP_RUNS=${raw}; using ${DEFAULT_KEEP_RUNS}`,
    );
    return DEFAULT_KEEP_RUNS;
  }
  return Number(raw);
}

// Deletes old run folders directly under e2e-artifacts/, keeping the newest
// `keep` (the current run included). Symlinks, junctions, files, and folders
// with other names are never touched. Failures are logged, never thrown.
function pruneOldRuns(artifactsRoot, currentStamp, keep) {
  if (keep === 0) return;
  try {
    const runs = [];
    for (const name of fs.readdirSync(artifactsRoot)) {
      if (!RUN_STAMP_PATTERN.test(name) || name === currentStamp) continue;
      const entry = path.join(artifactsRoot, name);
      const info = fs.lstatSync(entry);
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      runs.push(name);
    }
    // Fixed-width ISO stamps sort chronologically, so newest comes last.
    runs.sort();
    // The current run already occupies one of the `keep` slots.
    const stale = runs.slice(0, Math.max(0, runs.length - (keep - 1)));
    let pruned = 0;
    for (const name of stale) {
      try {
        fs.rmSync(path.join(artifactsRoot, name), {
          recursive: true,
          force: true,
        });
        pruned += 1;
      } catch (error) {
        console.warn(
          `[e2e-app] could not prune ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    console.log(
      `[e2e-app] pruned ${pruned} old run folder(s), keeping ${keep}`,
    );
  } catch (error) {
    console.warn(
      `[e2e-app] run pruning skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function allocateDebugPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function retainTail(previous, chunk, maxBytes = 256 * 1024) {
  const next = previous + chunk;
  const bytes = Buffer.from(next, "utf8");
  return bytes.length <= maxBytes
    ? next
    : bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

function captureChildOutput(child, output, onSpawnError) {
  for (const [stream, key] of [
    [child.stdout, "stdout"],
    [child.stderr, "stderr"],
  ]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk) => {
      output[key] = retainTail(output[key], chunk);
    });
  }
  child.on("error", (error) => {
    child.spawnError = error;
    onSpawnError(error);
  });
  child.on("exit", (code, signal) => {
    child.exitInfo = { code, signal, at: new Date().toISOString() };
    if (child.pid) ownedAppPids.delete(child.pid);
  });
}

function collectWebViewDiagnostics(startedAt) {
  const script = String.raw`
$ErrorActionPreference = "SilentlyContinue"
$start = [DateTimeOffset]::Parse($env:ARLET_E2E_STARTED_AT).LocalDateTime
$programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
$roots = @(
  (Join-Path $programFilesX86 "Microsoft\EdgeWebView\Application"),
  (Join-Path $env:ProgramFiles "Microsoft\EdgeWebView\Application")
)
$runtimes = @()
foreach ($root in $roots) {
  foreach ($directory in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
    $exe = Join-Path $directory.FullName "msedgewebview2.exe"
    if (Test-Path -LiteralPath $exe) {
      $file = Get-Item -LiteralPath $exe
      $runtimes += [pscustomobject]@{ path = $exe; fileVersion = $file.VersionInfo.FileVersion; productVersion = $file.VersionInfo.ProductVersion }
    }
  }
}
$processCandidates = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($env:ARLET_E2E_DATA_ROOT, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
foreach ($process in $processCandidates) {
  if ($process.ExecutablePath -and (Test-Path -LiteralPath $process.ExecutablePath) -and -not ($runtimes | Where-Object { $_.path -eq $process.ExecutablePath })) {
    $file = Get-Item -LiteralPath $process.ExecutablePath
    $runtimes += [pscustomobject]@{ path = $process.ExecutablePath; fileVersion = $file.VersionInfo.FileVersion; productVersion = $file.VersionInfo.ProductVersion }
  }
}
$processes = @($processCandidates | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine)
$webViewLogs = @(Get-WinEvent -ListLog '*WebView*' -ErrorAction SilentlyContinue | Where-Object { $_.IsEnabled } | Select-Object -ExpandProperty LogName)
$events = @()
foreach ($logName in $webViewLogs) {
  $events += Get-WinEvent -FilterHashtable @{ LogName = $logName; StartTime = $start } -MaxEvents 40 -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{ time = $_.TimeCreated; id = $_.Id; level = $_.LevelDisplayName; provider = $_.ProviderName; log = $logName; message = $_.Message }
  }
}
$applicationEvents = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $start } -MaxEvents 200 -ErrorAction SilentlyContinue | Where-Object { $_.ProviderName -match 'WebView|Edge|Application Error|Windows Error Reporting' } | Select-Object -First 40 | ForEach-Object {
  [pscustomobject]@{ time = $_.TimeCreated; id = $_.Id; level = $_.LevelDisplayName; provider = $_.ProviderName; log = 'Application'; message = $_.Message }
})
[pscustomobject]@{ runtimes = $runtimes; processes = $processes; eventLogs = $webViewLogs; events = @($events) + $applicationEvents } | ConvertTo-Json -Depth 6 -Compress
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        ARLET_E2E_STARTED_AT: startedAt,
        ARLET_E2E_DATA_ROOT: e2eProfileRoot ?? "",
      },
    },
  );
  let collected;
  try {
    collected = JSON.parse(result.stdout ?? "{}");
  } catch {
    collected = undefined;
  }
  return {
    collectedAt: new Date().toISOString(),
    startedAt,
    status: result.status,
    error: result.error?.message ?? result.stderr?.trim() ?? null,
    runtimes: collected?.runtimes ?? [],
    processes: collected?.processes ?? [],
    eventLogs: collected?.eventLogs ?? [],
    events: collected?.events ?? [],
    rawOutput: collected
      ? undefined
      : String(result.stdout ?? "").slice(-32_000),
  };
}

function saveJson(artifactDir, name, value) {
  fs.writeFileSync(
    path.join(artifactDir, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function run() {
  processVerificationFailed = false;
  const realToken = process.argv.includes("--real-token");
  const token = realToken
    ? String(process.env.MUSICKIT_DEVELOPER_TOKEN ?? "").trim()
    : syntheticToken();
  const tokenMode = realToken ? "real" : "synthetic";
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const artifactDir = path.join(root, "e2e-artifacts", stamp);
  const checks = [];
  let selectedScenarios = [];
  let fullSuite = false;
  let scenarioSelectionError = null;
  const check = (name, passed, detail) => {
    checks.push({ name, passed: Boolean(passed), detail });
    console.log(`[e2e-app] ${passed ? "PASS" : "FAIL"} ${name}`);
    // test:all shows only an output tail, so the reason must be printed too.
    if (!passed && detail !== undefined) {
      const text = typeof detail === "string" ? detail : JSON.stringify(detail);
      console.log(`[e2e-app]   ${String(text).slice(0, 600)}`);
    }
  };
  let profile;
  let child;
  let page;
  let foreground;
  let runKeyMayExist = false;
  let musicRuntimeCapabilities;
  let buildProof;
  let childSpawnError;
  let startupArguments = [];
  let webviewBrowserArguments = "";
  let interrupted = false;
  let webviewDiagnostics;
  let appProcessRecord;
  let childOutput = { stdout: "", stderr: "" };
  const startedAt = new Date().toISOString();
  const onInterrupt = () => {
    interrupted = true;
    console.error("[e2e-app] Interrupted; stopping this isolated E2E process.");
    try {
      page?.close();
    } catch {
      // The transport cleanup is retried in finally.
    }
    try {
      const stopped = killOwnedArlet();
      if (stopped.failures.length) {
        console.error(
          `[e2e-app] Process cleanup pending: ${JSON.stringify(stopped)}`,
        );
      }
    } catch (error) {
      console.error(`[e2e-app] Process cleanup failed: ${error.message}`);
    }
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGBREAK", onInterrupt);
  try {
    fs.mkdirSync(artifactDir, { recursive: true });
    const scenarioSelection = selectScenarios(process.argv.slice(2));
    selectedScenarios = scenarioSelection.selectedScenarios;
    fullSuite = scenarioSelection.fullSuite;
    scenarioSelectionError = scenarioSelection.error;
    check("scenario selection is valid", !scenarioSelectionError, {
      selectedScenarios,
      fullSuite,
      error: scenarioSelectionError,
    });
    if (scenarioSelectionError) fail(scenarioSelectionError);
    if (process.platform !== "win32") fail("Windows only");
    // Windows OpenSSH sessions are elevated and have no interactive desktop;
    // WebView2 fails there with "Invalid window handle" after a long wait.
    if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT) {
      fail(
        "cannot run in an SSH session (WebView2 has no desktop there); run it from a terminal at the machine's desktop",
      );
    }
    if (!token) {
      fail("--real-token needs MUSICKIT_DEVELOPER_TOKEN (run via dotenv)");
    }
    const skipBuild = process.argv.includes("--skip-build");
    if (!skipBuild) build(token, tokenMode);
    buildProof = verifyE2eBuildProof(token, tokenMode, {
      allowRefreshedSyntheticToken: skipBuild,
    });

    const running = spawnSync("tasklist", ["/FI", "IMAGENAME eq arlet.exe"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if (running.error || running.status !== 0) {
      fail(
        `could not verify Arlet process state: ${running.error?.message ?? running.status}`,
      );
    }
    if (/arlet\.exe/iu.test(running.stdout ?? "")) {
      fail("close every running Arlet instance first (single-instance app)");
    }

    DEBUG_PORT = await allocateDebugPort();
    runKeyMayExist = true;
    clearE2eRunKey();
    profile = await withE2eProfileSetup(
      { runId: crypto.randomUUID() },
      async (created) => {
        profile = created;
        e2eProfileRoot = created.root;
        e2eProfileOwnership = {
          runId: created.runId,
          ownerToken: created.ownerToken,
        };
        for (const directory of Object.values(dataDirs()).slice(1)) {
          fs.mkdirSync(directory, { recursive: true });
        }
        seedCorruptSettings();
        seedLegacyCache();
        fs.writeFileSync(
          path.join(dataDirs().data, "window-state.json"),
          JSON.stringify(SEEDED_WINDOW_STATE),
        );
      },
    );
    foreground = FOREGROUND ? undefined : startForegroundMonitor();
    startupArguments = [
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--remote-debugging-address=127.0.0.1",
      ...BACKGROUND_SWITCHES,
    ];
    webviewBrowserArguments = buildWebView2Args(...startupArguments);
    child = spawn(EXE, [], {
      env: {
        ...process.env,
        MUSICKIT_DEVELOPER_TOKEN: RUNTIME_ENV_TOKEN,
        ARLET_E2E_RUN_KEY: E2E_RUN_KEY,
        ARLET_E2E_DATA_ROOT: profile.root,
        WEBVIEW2_USER_DATA_FOLDER: path.join(profile.root, "webview"),
        ...BACKGROUND_ENV,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: webviewBrowserArguments,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.pid) ownedAppPids.add(child.pid);
    captureChildOutput(child, childOutput, (error) => {
      childSpawnError = error;
    });
    const target = await findPageTarget({
      port: DEBUG_PORT,
      timeoutMs: 60_000,
      launched: child,
    });
    page = connectCdp(target.webSocketDebuggerUrl);
    await page.opened;
    appProcessRecord = readAppProcessRecord();
    if (!FOREGROUND) {
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    }

    // 2. Shell renders.
    let shell = false;
    for (let attempt = 0; attempt < 80 && !shell; attempt += 1) {
      shell = await page.evaluate(
        "return Boolean(document.querySelector('.app-shell .player-bar'));",
      );
      if (!shell) await sleep(250);
    }
    check("shell renders", shell);
    // Not clicked: that would open the tester's browser. The URL is fixed in
    // Rust (commands::SUPPORT_URL) and the command takes no input.
    const support = await page.evaluate(
      `return Boolean(document.querySelector(".sidebar-footer .sidebar-support")?.textContent.includes("Support Me"));`,
    );
    check("sidebar shows the Support Me link", support);

    // Failure modes: the saved geometry is ignored, or applied after the
    // window is shown (visible jump). The window starts hidden, so reading
    // it after "shell renders" sees only the final geometry.
    const restoredGeometry = nativeWindowGeometry();
    check(
      "window opens at the saved size and position",
      near(restoredGeometry.x, SEEDED_WINDOW_STATE.x) &&
        near(restoredGeometry.y, SEEDED_WINDOW_STATE.y) &&
        near(restoredGeometry.width, SEEDED_WINDOW_STATE.width) &&
        near(restoredGeometry.height, SEEDED_WINDOW_STATE.height),
      { saved: SEEDED_WINDOW_STATE, actual: restoredGeometry },
    );

    // MusicKit sign-in and storage are keyed to the release origin.
    const origin = await page.evaluate("return location.origin;");
    check(`app origin is ${RELEASE_ORIGIN}`, origin === RELEASE_ORIGIN, {
      origin,
    });
    // Generous: a slow CDN must not read as Apple removing MusicKit.
    musicRuntimeCapabilities = await page.evaluate(`
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try {
          const music = window.MusicKit?.getInstance?.();
          if (music) return {
            loaded: true,
            playerIndexSelection: typeof music.player?.changeToMediaAtIndex === "function",
            instanceIndexSelection: typeof music.changeToMediaAtIndex === "function",
            queueRemove: typeof music.queue?.remove === "function",
            queueSplice: typeof music.queue?.splice === "function",
            queueAppend: typeof music.queue?.append === "function",
            queuePrepend: typeof music.queue?.prepend === "function",
            autoplayEnabled: "autoplayEnabled" in music,
            // Everything Arlet calls without a fallback. MusicKit loads from
            // Apple's CDN unversioned, so this is the early warning when
            // Apple changes it; see .github/workflows/musickit-canary.yml.
            missingRequired: [
              ...[
                "setQueue", "play", "pause", "stop", "seekToTime",
                "skipToNextItem", "skipToPreviousItem", "authorize",
                "unauthorize", "addEventListener", "removeEventListener",
                "playNext", "playLater",
              ].filter((name) => typeof music[name] !== "function"),
              ...(typeof music.api?.music === "function" ? [] : ["api.music"]),
              ...["playbackState", "storefrontId", "isAuthorized", "volume"]
                .filter((name) => !(name in music)),
              ...[
                "playbackStateDidChange", "nowPlayingItemDidChange",
                "playbackTimeDidChange", "queueItemsDidChange",
                "mediaPlaybackError",
              ].filter((name) => typeof window.MusicKit?.Events?.[name] !== "string")
                .map((name) => "Events." + name),
              ...(window.MusicKit?.PlaybackStates?.playing === undefined
                ? ["PlaybackStates.playing"]
                : []),
            ],
            // Optional: Arlet detects these and falls back when absent.
            missingOptional: [
              ...(typeof music.queue?.splice === "function" ? [] : ["queue.splice"]),
              ...["queuePositionDidChange", "shuffleModeDidChange", "repeatModeDidChange"]
                .filter((name) => typeof window.MusicKit?.Events?.[name] !== "string")
                .map((name) => "Events." + name),
              ...("shuffleMode" in music ? [] : ["shuffleMode"]),
              ...("repeatMode" in music ? [] : ["repeatMode"]),
            ],
          };
        } catch { /* MusicKit can load before its instance is configured. */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { loaded: false };
    `);
    if (musicRuntimeCapabilities.loaded) {
      check(
        "live MusicKit exposes indexed queue selection",
        musicRuntimeCapabilities.playerIndexSelection ||
          musicRuntimeCapabilities.instanceIndexSelection,
        musicRuntimeCapabilities,
      );
      check(
        "live MusicKit keeps every API Arlet relies on",
        musicRuntimeCapabilities.missingRequired.length === 0,
        {
          missingRequired: musicRuntimeCapabilities.missingRequired,
          missingOptional: musicRuntimeCapabilities.missingOptional,
        },
      );
    } else {
      check(
        "live MusicKit loads from Apple's CDN",
        false,
        musicRuntimeCapabilities,
      );
    }

    // Canary for the internals Arlet's error and sign-in handling read from
    // Apple's script text (docs/TESTING.md "Audit fixes", item 3). Each entry
    // lists alternatives; one must appear in the live script. The weekly
    // musickit-canary workflow runs this.
    const liveScript = await fetch(MUSICKIT_LIVE_SCRIPT_URL, {
      signal: AbortSignal.timeout(30_000),
    })
      .then(async (response) => ({
        ok: response.ok,
        text: response.ok ? await response.text() : "",
        status: response.status,
      }))
      .catch((error) => ({
        ok: false,
        text: "",
        error: String(error?.message ?? error).slice(0, 200),
      }));
    const missingMarkers = LIVE_SCRIPT_MARKERS.filter(
      (alternatives) =>
        !alternatives.some((marker) => liveScript.text.includes(marker)),
    ).map((alternatives) => alternatives.join(" or "));
    check(
      "live MusicKit script keeps the markers Arlet's error and sign-in code reads",
      liveScript.ok && missingMarkers.length === 0,
      {
        url: MUSICKIT_LIVE_SCRIPT_URL,
        bytes: liveScript.text.length,
        status: liveScript.status,
        error: liveScript.error,
        missingMarkers,
      },
    );

    if (realToken) {
      const catalog = await page.evaluate(`
        const deadline = Date.now() + 30000;
        while (!window.MusicKit?.getInstance?.() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const instance = window.MusicKit?.getInstance?.();
        if (!instance) return { ok: false, error: "MusicKit never configured" };
        try {
          const response = await instance.api.music("/v1/catalog/us/search", {
            term: "hello",
            types: "songs",
            limit: 1,
          });
          return { ok: Array.isArray(response?.data?.results?.songs?.data) };
        } catch (error) {
          return { ok: false, error: String(error?.errorCode ?? error?.message ?? error).slice(0, 200) };
        }`);
      check(
        "Apple accepts the embedded token from the release origin",
        catalog.ok,
        catalog,
      );
      // Probe: does queuing full song details skip MusicKit's per-song
      // lookup (one Apple request per 16 songs) that queuing IDs makes?
      // Informational; it decides whether Arlet queues details. No sign-in
      // or playback: setQueue only.
      const probe = await page.evaluate(`
        const instance = window.MusicKit?.getInstance?.();
        if (!instance) return { ok: false, error: "no MusicKit" };
        const lookups = () => performance.getEntriesByType("resource")
          .filter((entry) => entry.name.includes("/v1/catalog/") &&
            (entry.name.includes("/songs?") || entry.name.includes("/songs/"))).length;
        const measure = async (options) => {
          const before = lookups();
          const startedAt = performance.now();
          try {
            await instance.setQueue(options);
          } catch (error) {
            return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
          }
          const items = instance.queue?.items ?? [];
          return {
            ok: true,
            ms: Math.round(performance.now() - startedAt),
            lookups: lookups() - before,
            length: items.length,
            first: items[0] ? { id: items[0].id, title: items[0].title ?? items[0].attributes?.name } : null,
          };
        };
        try {
          const response = await instance.api.music("/v1/catalog/us/search", {
            term: "daft punk",
            types: "songs",
            limit: 5,
          });
          const songs = response?.data?.results?.songs?.data ?? [];
          if (songs.length === 0) return { ok: false, error: "no search results" };
          performance.clearResourceTimings();
          const byIds = await measure({ songs: songs.map((song) => song.id) });
          const byItems = await measure({ items: songs });
          return { ok: byIds.ok && byItems.ok, byIds, byItems };
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
        }`);
      check(
        "probe: setQueue with song details vs IDs (informational)",
        probe.ok,
        probe,
      );
    }

    // 3. Corrupt settings fall back to the backup.
    await sleep(1000);
    const appearance = await page.evaluate(
      "return { theme: document.documentElement.dataset.theme ?? null, volume: document.querySelector('input[aria-label=Volume]')?.value ?? null };",
    );
    check(
      "corrupt settings restore backup (theme light, volume 0.37)",
      appearance.theme === "light" && Number(appearance.volume) === 0.37,
      appearance,
    );

    // Debug Mode: off by default, so startup wrote no log file. Turning it
    // on in Settings saves it and starts the log at once; the rest of the
    // run relies on the log.
    const logOffBytes = readTestLog().length;
    check(
      "with Debug Mode off nothing is written to arlet.log",
      logOffBytes === 0,
      { logOffBytes },
    );
    await page.evaluate('location.hash = "#/settings"; return true;');
    const debugAdvancedOpen = await openAdvancedSettings(page);
    const debugToggled = await page.evaluate(`
      const deadline = Date.now() + 8000;
      let input;
      while (!input && Date.now() < deadline) {
        input = [...document.querySelectorAll("label.settings-toggle-field")]
          .find((label) => label.textContent.includes("Debug Mode"))
          ?.querySelector('input[type="checkbox"]');
        if (!input) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!input || input.checked) return false;
      input.click();
      return true;`);
    const settingsFile = path.join(dataDirs().data, "settings.json");
    let savedDebugMode = false;
    let debugLog = "";
    const debugDeadline = Date.now() + 8000;
    while (Date.now() < debugDeadline) {
      try {
        savedDebugMode =
          JSON.parse(fs.readFileSync(settingsFile, "utf8")).debugMode === true;
      } catch {
        savedDebugMode = false;
      }
      debugLog = readTestLog();
      if (savedDebugMode && debugLog.includes("Debug Mode turned on.")) break;
      await sleep(200);
    }
    check(
      "turning Debug Mode on saves it and starts arlet.log without a restart",
      debugAdvancedOpen &&
        debugToggled &&
        savedDebugMode &&
        debugLog.includes("Debug Mode turned on."),
      { debugToggled, savedDebugMode, logBytes: debugLog.length },
    );

    // Off again stops writing at once; then back on for the rest of the run.
    const clickDebugToggle = () =>
      page.evaluate(`
        const input = [...document.querySelectorAll("label.settings-toggle-field")]
          .find((label) => label.textContent.includes("Debug Mode"))
          ?.querySelector('input[type="checkbox"]');
        input?.click();
        return input?.checked ?? null;`);
    const waitForSavedDebugMode = async (expected) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        try {
          if (
            JSON.parse(fs.readFileSync(settingsFile, "utf8")).debugMode ===
            expected
          ) {
            return true;
          }
        } catch {
          // Mid-write; read again.
        }
        await sleep(200);
      }
      return false;
    };
    await clickDebugToggle();
    const savedOff = await waitForSavedDebugMode(false);
    await settle(page, "append_local_log", { entry: "e2e-debug-off-marker" });
    await sleep(500);
    const offLog = readTestLog();
    await clickDebugToggle();
    const savedOnAgain = await waitForSavedDebugMode(true);
    check(
      "turning Debug Mode off stops writing arlet.log at once",
      savedOff && savedOnAgain && !offLog.includes("e2e-debug-off-marker"),
      {
        savedOff,
        savedOnAgain,
        markerWritten: offLog.includes("e2e-debug-off-marker"),
      },
    );
    await page.evaluate('location.hash = "#/home"; return true;');

    // 1. Release serves the embedded token, never the runtime env.
    const served = await settle(page, "get_developer_token");
    const embeddedTokenMatchesBuild =
      served.ok &&
      typeof served.value === "string" &&
      tokenFingerprint(served.value) === buildProof.tokenFingerprint;
    const embeddedTokenMode =
      typeof served.value === "string"
        ? detectTokenMode(served.value)
        : "unknown";
    check(
      "release serves build-embedded token",
      embeddedTokenMatchesBuild &&
        embeddedTokenMode === buildProof.tokenMode &&
        served.value !== RUNTIME_ENV_TOKEN,
      {
        ok: served.ok,
        matchesEmbedded: embeddedTokenMatchesBuild,
        tokenMode: embeddedTokenMode,
        matchesTokenMode: embeddedTokenMode === buildProof.tokenMode,
      },
    );
    // Apple refuses library (/v1/me) requests from an origin-restricted
    // token (0.1.0), so the shipped token must carry none.
    let servedOrigin = "unreadable";
    try {
      servedOrigin =
        JSON.parse(Buffer.from(String(served.value).split(".")[1], "base64url"))
          .origin ?? null;
    } catch {
      // Left as "unreadable" so the check fails.
    }
    check(
      "embedded token has no origin claim",
      served.ok && servedOrigin === null,
      { origin: servedOrigin },
    );

    // 6. Windows build via registry, async command.
    const info = await settle(page, "get_app_info");
    check(
      "app info reports Windows build from registry",
      info.ok &&
        /build \d+\.\d+$/u.test(info.value.windows_build ?? "") &&
        info.value.debug === false,
      info.ok ? info.value : info,
    );

    // 4. Multibyte entry straddling the 8 KiB limit must not abort.
    const longEntry = `a${"€".repeat(4000)}`;
    const appended = await settle(page, "append_local_log", {
      entry: longEntry,
    });
    const alive = await settle(page, "get_log_dir");
    check(
      "multibyte log entry over limit is truncated, process alive",
      appended.ok && alive.ok,
      { appended, alive: alive.ok },
    );

    // 5. Music User Token redaction in the persisted log.
    await settle(page, "append_local_log", {
      entry: `Music-User-Token: ${USER_TOKEN} status=403`,
    });
    const logFile = path.join(alive.value ?? "", "arlet.log");
    const logText = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8")
      : "";
    if (logText) fs.copyFileSync(logFile, path.join(artifactDir, "arlet.log"));
    check(
      "log file truncates and redacts user token",
      logText.includes("… [truncated]") &&
        logText.includes("Music-User-Token: [REDACTED]") &&
        !logText.includes(USER_TOKEN),
      { logBytes: logText.length },
    );

    // 6. Media session + timeline commands.
    const session = await settle(page, "update_windows_media_session", {
      payload: {
        title: "E2E Song",
        artist: "E2E Artist",
        album: "E2E Album",
        playbackStatus: "playing",
        playEnabled: false,
        pauseEnabled: true,
        nextEnabled: true,
        previousEnabled: false,
      },
    });
    const timeline = await settle(page, "update_windows_media_timeline", {
      payload: { positionSeconds: 30, durationSeconds: 200 },
    });
    const cleared = await settle(page, "clear_windows_media_session");
    check(
      "media session, timeline, and clear succeed",
      session.ok && timeline.ok && cleared.ok,
      { session, timeline, cleared },
    );

    // 7. Removed plugins are unreachable.
    const dialog = await settle(page, "plugin:dialog|message", {
      message: "x",
    });
    const notify = await settle(page, "plugin:notification|notify", {
      options: { title: "x" },
    });
    check("dialog and notification plugins removed", !dialog.ok && !notify.ok, {
      dialog: dialog.error,
      notify: notify.error,
    });

    // 9. Library cache: legacy database readable, fixed commands work, and
    // the generic SQL plugin is gone from the webview.
    const legacy = await settle(page, "library_cache_read_section", {
      scope: CACHE_SCOPE,
      section: "songs",
    });
    const written = await settle(page, "library_cache_write_page", {
      scope: CACHE_SCOPE,
      section: "e2e",
      page: { items: [{ id: "w1", type: "songs" }], updatedAt: 2 },
    });
    const readBack = await settle(page, "library_cache_read_page", {
      scope: CACHE_SCOPE,
      section: "e2e",
    });
    const sql = await settle(page, "plugin:sql|execute", {
      db: "sqlite:x.db",
      query: "SELECT 1",
      values: [],
    });
    check(
      "library cache migrates legacy data and serves fixed commands only",
      legacy.ok &&
        legacy.value?.items?.[0]?.id === "cached-1" &&
        written.ok &&
        readBack.value?.items?.[0]?.id === "w1" &&
        !sql.ok,
      { legacy: legacy.ok, written: written.ok, sql: sql.error },
    );

    // 10. Licenses dialog lists the bundled inventories.
    await page.evaluate(`location.hash = "#/settings";`);
    await waitFor(
      page,
      `[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Open-source licenses"))`,
      10_000,
    );
    await page.evaluate(
      `[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Open-source licenses"))?.click();`,
    );
    await waitFor(
      page,
      `document.querySelectorAll(".licenses-entry").length > 50`,
      10_000,
    );
    const licenses = await page.evaluate(
      `return document.querySelectorAll(".licenses-entry").length;`,
    );
    check("licenses dialog lists bundled packages", licenses > 50, {
      licenses,
    });
    // Failure mode: a dialog rendered inside a page picks up the 960px page
    // column rule and dims only a band of the window (0.1.2).
    const backdrop = await page.evaluate(`
      const rect = document.querySelector(".playlist-dialog-backdrop")?.getBoundingClientRect();
      return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height, windowWidth: innerWidth, windowHeight: innerHeight } : null;`);
    check(
      "licenses dialog dims the whole window",
      Boolean(backdrop) &&
        backdrop.left === 0 &&
        backdrop.top === 0 &&
        backdrop.width === backdrop.windowWidth &&
        backdrop.height === backdrop.windowHeight,
      backdrop,
    );

    // Failure mode: after keyboard input, focusing the page <main> (done on
    // every navigation) drew the accent focus ring around the page (0.1.2).
    await page.evaluate(
      `document.querySelector("[aria-label='Close licenses']")?.click(); return true;`,
    );
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Shift",
      code: "ShiftLeft",
      windowsVirtualKeyCode: 16,
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Shift",
      code: "ShiftLeft",
      windowsVirtualKeyCode: 16,
    });
    const mainFocus = await page.evaluate(`
      const main = document.querySelector("main.content-area");
      main.focus();
      const style = getComputedStyle(main);
      return { focused: document.activeElement === main, focusVisible: main.matches(":focus-visible"), outline: style.outlineStyle };`);
    check(
      "page focus after keyboard input draws no focus ring",
      mainFocus.focused && mainFocus.outline === "none",
      mainFocus,
    );

    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(
      path.join(artifactDir, "screenshot.png"),
      Buffer.from(shot.data, "base64"),
    );

    // 11. Offline: with Apple's CDN unreachable MusicKit cannot start; the
    // cached library must still render, read-only, with a reconnect banner.
    await page.send("Network.enable");
    await page.send("Network.setBlockedURLs", {
      urls: ["*js-cdn.music.apple.com*"],
    });
    // Reload on the library route: Settings has no offline banner.
    await page.evaluate(`location.hash = "#/library/songs";`);
    await page.send("Page.reload", { ignoreCache: true });
    await sleep(1000);
    const banner = await waitFor(
      page,
      `document.querySelector(".offline-banner")`,
      45_000,
    );
    const cachedRow = await waitFor(
      page,
      `document.body.textContent.includes("Cached Song")`,
      10_000,
    );
    check(
      "offline shows the cached library with a banner",
      banner && cachedRow,
      {
        banner,
        cachedRow,
      },
    );
    const offlineShot = await page.send("Page.captureScreenshot", {
      format: "png",
    });
    fs.writeFileSync(
      path.join(artifactDir, "screenshot-offline.png"),
      Buffer.from(offlineShot.data, "base64"),
    );

    // 11a. Failure mode: the connection returning after a failed start never
    // retries (no listener). e2e-audit-fixes.js checks only that a healthy
    // app does not reload, which passes without a listener too. A reload
    // drops the page marker; polls during it may hit a torn-down context.
    await page.evaluate(
      "window.__ARLET_E2E_ONLINE_MARK__ = 1; window.dispatchEvent(new Event('online')); return true;",
    );
    let onlineReloaded = false;
    const onlineDeadline = Date.now() + 15_000;
    while (!onlineReloaded && Date.now() < onlineDeadline) {
      await sleep(250);
      try {
        onlineReloaded = await page.evaluate(
          "return typeof window.__ARLET_E2E_ONLINE_MARK__ === 'undefined' && document.readyState === 'complete';",
        );
      } catch {
        // The old document is going away; poll the new one.
      }
    }
    const offlineAgain =
      onlineReloaded &&
      (await waitFor(
        page,
        `document.querySelector(".offline-banner")`,
        45_000,
      ));
    check(
      "after a failed start, the connection returning reloads the app to retry",
      onlineReloaded && offlineAgain,
      { onlineReloaded, offlineAgain },
    );

    // 11b. An expired embedded token: the update notice shows, not the
    // offline banner (its Reconnect could never work). The token command is
    // answered with the release-build error through Tauri's IPC transport.
    await page.send("Page.enable");
    const expiredScript = await page.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: EXPIRED_TOKEN_SOURCE },
    );
    await page.evaluate(
      "sessionStorage.setItem('arlet-e2e-expired-token', '1'); return true;",
    );
    await page.send("Page.reload", { ignoreCache: true });
    await sleep(1000);
    const expiredNotice = await waitFor(
      page,
      `document.querySelector(".token-expiry-notice")?.textContent.includes("expired")`,
      30_000,
    );
    const expiredView = await page.evaluate(`return {
      offlineBanner: Boolean(document.querySelector(".offline-banner")),
      notice: document.querySelector(".token-expiry-notice")?.textContent ?? null,
    };`);
    check(
      "an expired embedded token shows the update notice, not the offline banner",
      expiredNotice && !expiredView.offlineBanner,
      expiredView,
    );
    await page.evaluate(
      "sessionStorage.removeItem('arlet-e2e-expired-token'); return true;",
    );
    await page.send("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: expiredScript.identifier,
    });

    await page.send("Network.setBlockedURLs", { urls: [] });

    // 12. Renderer crash: the window reloads instead of staying blank.
    void page.send("Page.crash").catch(() => undefined);
    page.close();
    await sleep(3000);
    const revived = await findPageTarget({
      port: DEBUG_PORT,
      timeoutMs: 30_000,
    });
    page = connectCdp(revived.webSocketDebuggerUrl);
    await page.opened;
    appProcessRecord = readAppProcessRecord();
    if (!FOREGROUND) {
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    }
    const recovered = await waitFor(
      page,
      `document.querySelector(".app-shell .player-bar")`,
      30_000,
    );
    check("renderer crash reloads the window", recovered);
    // The crash is recorded whatever Debug Mode says: nothing else would.
    const crashLogged = await (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (readTestLog().includes("[native] WebView2 process failed (kind")) {
          return true;
        }
        await sleep(200);
      }
      return false;
    })();
    check("a WebView2 crash is written to arlet.log", crashLogged);

    // 13. Reset settings: Cancel changes nothing; confirming restores
    // defaults and restarts, keeping sign-in storage and pins.
    // Failure modes: Cancel resets anyway; the .bak or a pending save brings
    // old settings back; sign-in (WebView2 storage) or pins are wiped; the
    // app never restarts; saves stay blocked in the restarted process.
    const pinsPayload = JSON.stringify({
      schemaVersion: 1,
      pins: [{ id: "p.e2eResetPin", source: "library" }],
    });
    await settle(page, "save_settings", {
      json: JSON.stringify({ ...DEFAULT_SETTINGS_FOR_E2E, theme: "dark" }),
    });
    await settle(page, "save_pins", { json: pinsPayload });
    await page.evaluate(
      "localStorage.setItem('arlet-e2e-signin-marker', 'kept'); return true;",
    );
    await page.evaluate(
      "document.querySelector('button[aria-label=Settings]').click(); return true;",
    );
    const resetAdvancedOpen = await openAdvancedSettings(page);
    const openReset = `
      const button = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent.trim() === "Reset settings…",
      );
      button?.click();
      return Boolean(button);`;
    const clickInDialog = (label) => `
      const button = [...document.querySelectorAll("[role=alertdialog] button")].find(
        (candidate) => candidate.textContent.trim() === ${JSON.stringify(label)},
      );
      button?.click();
      return Boolean(button);`;
    const resetButtonFound = await waitFor(
      page,
      `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Reset settings…")`,
      10_000,
    );
    await page.evaluate(openReset);
    const dialogShown = await waitFor(
      page,
      `document.querySelector("[role=alertdialog]")`,
      5_000,
    );
    await page.evaluate(clickInDialog("Cancel"));
    await sleep(500);
    const afterCancel = {
      dialogClosed: !(await page.evaluate(
        "return Boolean(document.querySelector('[role=alertdialog]'));",
      )),
      settingsKept: fs.existsSync(settingsFile),
    };
    check(
      "reset settings dialog opens and Cancel changes nothing",
      resetAdvancedOpen &&
        resetButtonFound &&
        dialogShown &&
        afterCancel.dialogClosed &&
        afterCancel.settingsKept,
      { resetButtonFound, dialogShown, ...afterCancel },
    );

    await page.evaluate(openReset);
    await waitFor(page, `document.querySelector("[role=alertdialog]")`, 5_000);
    await page.evaluate(clickInDialog("Reset and restart"));
    page.close();
    page = undefined;
    // request_restart exits this process and starts a new one with the same
    // environment, so the debugging port comes back on the new webview.
    const restartDeadline = Date.now() + 30_000;
    while (Date.now() < restartDeadline && processAlive(child.pid)) {
      await sleep(250);
    }
    const oldProcessExited = !processAlive(child.pid);
    await sleep(1000);
    const restarted = await findPageTarget({
      port: DEBUG_PORT,
      timeoutMs: 30_000,
    });
    page = connectCdp(restarted.webSocketDebuggerUrl);
    await page.opened;
    appProcessRecord = readAppProcessRecord();
    if (!FOREGROUND) {
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    }
    const restartedShell = await waitFor(
      page,
      `document.querySelector(".app-shell .player-bar")`,
      30_000,
    );
    await sleep(1000);
    const afterReset = await page.evaluate(`
      return {
        theme: document.documentElement.dataset.theme ?? "system",
        volume: document.querySelector("input[aria-label=Volume]")?.value ?? null,
        signInMarker: localStorage.getItem("arlet-e2e-signin-marker"),
      };`);
    const pinsAfter = await settle(page, "load_pins");
    const saveAfter = await settle(page, "save_settings", {
      json: JSON.stringify(DEFAULT_SETTINGS_FOR_E2E),
    });
    check(
      "reset restores defaults, restarts, and keeps sign-in and pins",
      oldProcessExited &&
        restartedShell &&
        afterReset.theme === "system" &&
        Number(afterReset.volume) === 1 &&
        afterReset.signInMarker === "kept" &&
        pinsAfter.ok &&
        String(pinsAfter.value).includes("p.e2eResetPin") &&
        saveAfter.ok,
      {
        oldProcessExited,
        restartedShell,
        ...afterReset,
        pinsKept: String(pinsAfter.value ?? "").includes("p.e2eResetPin"),
        saveAfterRestart: saveAfter.ok,
      },
    );
    const resetShot = await page.send("Page.captureScreenshot", {
      format: "png",
    });
    fs.writeFileSync(
      path.join(artifactDir, "screenshot-after-reset.png"),
      Buffer.from(resetShot.data, "base64"),
    );

    // Reset turned Debug Mode off with the other defaults. The scenarios
    // below read arlet.log, so turn it back on the way a user would.
    await page.evaluate('location.hash = "#/settings"; return true;');
    const resetDebugAdvancedOpen = await openAdvancedSettings(page);
    await waitFor(
      page,
      `[...document.querySelectorAll("label.settings-toggle-field")].some((label) => label.textContent.includes("Debug Mode"))`,
      10_000,
    );
    const debugOffAfterReset = await page.evaluate(`
      return [...document.querySelectorAll("label.settings-toggle-field")]
        .find((label) => label.textContent.includes("Debug Mode"))
        ?.querySelector('input[type="checkbox"]')?.checked === false;`);
    await clickDebugToggle();
    const debugOnAfterReset = await waitForSavedDebugMode(true);
    check(
      "reset turns Debug Mode off, and it can be turned on again",
      resetDebugAdvancedOpen && debugOffAfterReset && debugOnAfterReset,
      { resetDebugAdvancedOpen, debugOffAfterReset, debugOnAfterReset },
    );
    await page.evaluate('location.hash = "#/home"; return true;');

    // Reset deleted the saved geometry, and the closing window (reset
    // pending) must not have written it back.
    const windowStateFile = path.join(dataDirs().data, "window-state.json");
    const resetGeometry = nativeWindowGeometry();
    check(
      "reset forgets the saved window size and position",
      !fs.existsSync(windowStateFile) &&
        !near(resetGeometry.width, SEEDED_WINDOW_STATE.width),
      { stateFileExists: fs.existsSync(windowStateFile), resetGeometry },
    );

    // Exercise application behavior with a deterministic provider. The
    // fixture is injected only by DevTools; production code has no test hook.
    await page.send("Network.enable");
    await page.send("Network.setBlockedURLs", {
      urls: ["*js-cdn.music.apple.com*"],
    });
    await page.send("Page.enable");
    const fixtureScript = await page.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: musicFixtureSource },
    );
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: desktopEventRecorderSource,
    });
    await page.evaluate('location.hash = "#/home";');
    await page.send("Page.reload", { ignoreCache: true });
    await sleep(1000);
    const fixtureReady = await waitFor(
      page,
      "window.__ARLET_E2E_MUSIC__ && document.querySelector('.app-shell .player-bar')",
      30_000,
    );
    check("deterministic MusicKit fixture starts", fixtureReady, {
      seed: MUSIC_FIXTURE_SEED,
      state: fixtureReady
        ? undefined
        : await page.evaluate(
            `return JSON.stringify({fixture:!!window.__ARLET_E2E_MUSIC__,mk:typeof window.MusicKit,shell:!!document.querySelector('.app-shell'),bar:!!document.querySelector('.player-bar'),hash:location.hash,text:document.body.innerText.slice(0,300)})`,
          ),
    });
    if (fixtureReady) {
      const scenarioByName = new Map(SCENARIO_REGISTRY);
      for (const name of selectedScenarios) {
        const scenario = scenarioByName.get(name);
        if (!scenario) continue;
        try {
          // A menu left open by the previous scenario would intercept clicks.
          await page.evaluate(
            'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;',
          );
          await scenario({
            page,
            check,
            dataDir: dataDirs().data,
            logDir: dataDirs().logs,
            artifactDir,
          });
        } catch (error) {
          check(`${name} completes`, false, String(error?.message ?? error));
        } finally {
          const screenshot = await page.send("Page.captureScreenshot", {
            format: "png",
          });
          fs.writeFileSync(
            path.join(artifactDir, `screenshot-${name}.png`),
            Buffer.from(screenshot.data, "base64"),
          );
          const trace = await page.evaluate(
            "return window.__ARLET_E2E_MUSIC__.snapshot();",
          );
          fs.writeFileSync(
            path.join(artifactDir, `${name}-trace.json`),
            `${JSON.stringify(trace, null, 2)}\n`,
          );
        }
      }
    }
    await page.send("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: fixtureScript.identifier,
    });
    await page.send("Network.setBlockedURLs", { urls: [] });
    if (fs.existsSync(logFile)) {
      fs.copyFileSync(logFile, path.join(artifactDir, "arlet.log"));
    }

    // Tray on: closing hides the window and keeps the process alive, and a
    // second launch shows the hidden window again (single instance).
    // Failure modes: a second launch does not show a window hidden in the
    // tray; the tray leaves the app impossible to quit (docs/TESTING.md, Tray).
    const trayEnabled = await settle(page, "save_settings", {
      json: JSON.stringify({ ...DEFAULT_SETTINGS_FOR_E2E, trayIcon: true }),
    });
    const appPid = runningArletPid();
    void settle(page, "plugin:window|close", { label: "main" }).catch(
      () => undefined,
    );
    const hiddenInTray = await waitUntil(
      () => visibleArletWindows(appPid) === 0,
      10_000,
    );
    const aliveAfterClose = processAlive(appPid);
    // The first instance owns the debug port; the handoff relaunch must not
    // ask for it again.
    const relaunchWebView2Args = buildWebView2Args(...BACKGROUND_SWITCHES);
    const relaunch = spawn(EXE, [], {
      env: {
        ...process.env,
        MUSICKIT_DEVELOPER_TOKEN: RUNTIME_ENV_TOKEN,
        ARLET_E2E_RUN_KEY: E2E_RUN_KEY,
        ARLET_E2E_DATA_ROOT: profile.root,
        WEBVIEW2_USER_DATA_FOLDER: path.join(profile.root, "webview"),
        ...BACKGROUND_ENV,
        ...(relaunchWebView2Args && {
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: relaunchWebView2Args,
        }),
      },
      stdio: "ignore",
      windowsHide: true,
    });
    if (relaunch.pid) ownedAppPids.add(relaunch.pid);
    relaunch.once("exit", () => {
      if (relaunch.pid) ownedAppPids.delete(relaunch.pid);
    });
    relaunch.once("error", () => {
      if (relaunch.pid) ownedAppPids.delete(relaunch.pid);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(false), 20_000);
      relaunch.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
      relaunch.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const trayDeadline = Date.now() + 15_000;
    let shownAgain = false;
    while (Date.now() < trayDeadline && !shownAgain) {
      shownAgain = visibleArletWindows(appPid) === 1;
      if (!shownAgain) await sleep(250);
    }
    check(
      "with the tray on, closing hides the window and a second launch shows it again",
      trayEnabled.ok &&
        appPid !== undefined &&
        hiddenInTray &&
        aliveAfterClose &&
        shownAgain &&
        processAlive(appPid),
      { appPid, hiddenInTray, aliveAfterClose, shownAgain },
    );
    // Tray off: closing the window quits instead of hiding.
    const trayDisabled = await settle(page, "save_settings", {
      json: JSON.stringify({ ...DEFAULT_SETTINGS_FOR_E2E, trayIcon: false }),
    });

    // Quitting saves the queue position first. Sign back in (the session
    // scenario signed out), play, then report 100s and at once 123s: the
    // second report is inside the 30-second save throttle, so only the save
    // on quit can write it.
    await page.evaluate('location.hash = "#/settings"; return true;');
    await waitFor(
      page,
      '[...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Sign in")',
      10_000,
    );
    await page.evaluate(`
      [...document.querySelectorAll("button")]
        .find((node) => node.textContent.trim() === "Sign in")
        ?.click();
      return true;`);
    await waitFor(
      page,
      '[...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Sign out")',
      10_000,
    );
    await page.evaluate(
      'location.hash = "#/playlist/playlist-1"; return true;',
    );
    await waitFor(
      page,
      'document.querySelector(".library-track-row")?.textContent.includes("Track A")',
      10_000,
    );
    await page.evaluate(
      'document.querySelectorAll(".library-track-row")[0]?.click(); return true;',
    );
    const playingBeforeQuit = await waitFor(
      page,
      'document.querySelector(".player-bar .player-track-copy strong")?.textContent === "Track A"',
      10_000,
    );
    await sleep(2500);
    await page.evaluate(`
      window.__ARLET_E2E_MUSIC__.emitPlaybackTime(100);
      window.__ARLET_E2E_MUSIC__.emitPlaybackTime(123);
      return true;`);
    await sleep(300);
    const sessionFile = path.join(dataDirs().data, "playback-session.json");

    // Resize, then close normally: the new geometry is saved for next launch.
    const resized = await settle(page, "plugin:window|set_size", {
      label: "main",
      value: { Physical: { width: 1060, height: 740 } },
    });
    await sleep(800);
    const beforeClose = nativeWindowGeometry();
    void settle(page, "plugin:window|close", { label: "main" }).catch(
      () => undefined,
    );
    page.close();
    page = undefined;
    const closeDeadline = Date.now() + 15_000;
    while (Date.now() < closeDeadline && !fs.existsSync(windowStateFile)) {
      await sleep(250);
    }
    let savedAfterClose = null;
    try {
      savedAfterClose = JSON.parse(fs.readFileSync(windowStateFile, "utf8"));
    } catch {
      // Left null so the check fails with the detail below.
    }
    check(
      "closing the window saves its size and position",
      resized.ok &&
        Boolean(savedAfterClose) &&
        savedAfterClose.width === beforeClose.width &&
        savedAfterClose.height === beforeClose.height &&
        beforeClose.width === 1060 &&
        beforeClose.height === 740 &&
        savedAfterClose.x === beforeClose.x &&
        savedAfterClose.y === beforeClose.y,
      { resized: resized.ok, beforeClose, savedAfterClose },
    );
    const exitDeadline = Date.now() + 15_000;
    while (Date.now() < exitDeadline && processAlive(appPid)) {
      await sleep(250);
    }
    check(
      "with the tray off, closing the window quits Arlet",
      trayDisabled.ok && appPid !== undefined && !processAlive(appPid),
      { trayDisabled: trayDisabled.ok, appPid, alive: processAlive(appPid) },
    );
    let quitSession = null;
    try {
      quitSession = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    } catch {
      // Left null so the check fails with the detail below.
    }
    check(
      "quitting saves the queue's latest position before Arlet exits",
      playingBeforeQuit &&
        Math.abs(Number(quitSession?.positionSeconds) - 123) < 1,
      {
        playingBeforeQuit,
        positionSeconds: quitSession?.positionSeconds ?? null,
        firstId: quitSession?.items?.[0]?.id ?? null,
      },
    );

    // Stop this isolated app, then confirm the seeded legacy cache migrated.
    const stopped = killOwnedArlet();
    const appExited = await waitForArletExit();
    check(
      "isolated app process stops before cache verification",
      appExited && stopped.failures.length === 0,
      { appExited, ...stopped },
    );
    const legacyDb = path.join(dataDirs().data, "arlet-library.db");
    const db = new DatabaseSync(
      path.join(dataDirs().local, "arlet-library.db"),
      {
        readOnly: true,
      },
    );
    const version = db.prepare("PRAGMA user_version").get().user_version;
    db.close();
    check(
      "isolated legacy cache moved to local data and migrated to schema 2",
      version === 2 && !fs.existsSync(legacyDb),
      {
        version,
        legacyLeft: fs.existsSync(legacyDb),
      },
    );
  } catch (error) {
    const native = profile
      ? readTestLog()
          .split(/\r?\n/u)
          .filter((line) => line.includes("[native] "))
          .slice(-4)
      : [];
    if (interrupted) {
      check(
        "native E2E was not interrupted",
        false,
        "run interrupted by the user",
      );
    }
    check("native E2E completes", false, {
      error: String(error?.stack ?? error?.message ?? error),
      native,
      spawnError: childSpawnError?.message ?? null,
      childExit: child?.exitInfo ?? null,
    });
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGBREAK", onInterrupt);
    try {
      page?.close();
    } catch (error) {
      check(
        "DevTools connection closes",
        false,
        String(error?.message ?? error),
      );
    }
    if (profile) {
      try {
        webviewDiagnostics = collectWebViewDiagnostics(startedAt);
        saveJson(artifactDir, "webview-diagnostics.json", webviewDiagnostics);
        check(
          "WebView2 runtime and startup diagnostics are collected",
          webviewDiagnostics.status === 0 &&
            webviewDiagnostics.runtimes.length > 0,
          {
            status: webviewDiagnostics.status,
            runtimeCount: webviewDiagnostics.runtimes.length,
            isolatedProcessCount: webviewDiagnostics.processes.length,
            eventLogCount: webviewDiagnostics.eventLogs.length,
            eventCount: webviewDiagnostics.events.length,
            error: webviewDiagnostics.error,
          },
        );
      } catch (error) {
        webviewDiagnostics = {
          error: String(error?.message ?? error),
          collectedAt: new Date().toISOString(),
        };
        check(
          "WebView2 diagnostics collected",
          false,
          webviewDiagnostics.error,
        );
      }
    }
    if (child) {
      try {
        appProcessRecord = readAppProcessRecord() ?? appProcessRecord;
        const stopped = killOwnedArlet();
        const appExited = await waitForArletExit();
        if (!appExited || stopped.failures.length) {
          check("isolated app process stops before profile cleanup", false, {
            appExited,
            ...stopped,
          });
        }
      } catch (error) {
        check("isolated app process stops before profile cleanup", false, {
          error: String(error?.message ?? error),
        });
      }
    }
    if (runKeyMayExist) {
      try {
        clearE2eRunKey();
      } catch (error) {
        check(
          "E2E startup registry key is cleared",
          false,
          String(error?.message ?? error),
        );
      }
    }
    if (foreground) {
      try {
        const summary = foreground.stop();
        saveJson(artifactDir, "foreground.json", summary);
        check(
          "background launch: Arlet never became the active window or covered it",
          summary.samples > 0 &&
            summary.arletSamples === 0 &&
            summary.aboveSamples === 0,
          summary,
        );
      } catch (error) {
        check(
          "foreground monitor stops and reports",
          false,
          String(error?.message ?? error),
        );
      }
    }
    if (profile) {
      try {
        const testLog = readTestLog();
        if (testLog)
          fs.writeFileSync(path.join(artifactDir, "arlet.log"), testLog);
      } catch (error) {
        check(
          "native log is copied to artifacts",
          false,
          String(error?.message ?? error),
        );
      }
    }
    try {
      fs.writeFileSync(
        path.join(artifactDir, "browser-process.log"),
        `STDOUT\n${childOutput.stdout}\nSTDERR\n${childOutput.stderr}\n`,
      );
    } catch (error) {
      check(
        "browser process output is saved",
        false,
        String(error?.message ?? error),
      );
    }
    if (profile) {
      let livePids;
      let processCheckError;
      try {
        livePids = ownedProcessPids().filter((pid) => processAlive(pid));
      } catch (error) {
        processCheckError = String(error?.message ?? error);
      }
      if (processVerificationFailed || processCheckError) {
        check(
          "isolated profile is removed after app exit",
          false,
          `unable to verify app processes; marked profile retained at ${profile.root}: ${processCheckError ?? "a tasklist or CIM identity check failed earlier"}`,
        );
      } else if (livePids.length) {
        check(
          "isolated profile is removed after app exit",
          false,
          `Arlet process(es) ${livePids.join(", ")} are still running; marked profile retained at ${profile.root}`,
        );
      } else {
        try {
          profile.cleanup();
          check("isolated profile is removed after app exit", true);
        } catch (error) {
          check(
            "isolated profile is removed after app exit",
            false,
            `${String(error?.message ?? error)}; marked profile retained at ${profile.root}`,
          );
        }
      }
    }
  }

  if (
    interrupted &&
    !checks.some((entry) => entry.name === "native E2E was not interrupted")
  ) {
    check(
      "native E2E was not interrupted",
      false,
      "run interrupted by the user",
    );
  }

  let binary = { path: path.relative(root, EXE), sha256: null };
  try {
    binary.sha256 = crypto
      .createHash("sha256")
      .update(fs.readFileSync(EXE))
      .digest("hex");
  } catch (error) {
    check(
      "release binary is available for report",
      false,
      String(error?.message ?? error),
    );
  }
  const commitResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  const dirty = (status.stdout ?? "").trim().length > 0;
  const report = {
    passed: checks.length > 0 && checks.every((entry) => entry.passed),
    finishedAt: new Date().toISOString(),
    startedAt,
    commit: commitResult.stdout?.trim() ?? "",
    dirtyWorktree: dirty,
    host: `${os.type()} ${os.release()} ${os.arch()}`,
    binary,
    e2eBuild: buildProof ?? null,
    tokenMode,
    selectedScenarios,
    fullSuite,
    releaseProofEligible: fullSuite,
    scenarioSelectionError,
    musicFixtureSeed: MUSIC_FIXTURE_SEED,
    musicRuntimeCapabilities,
    startup: {
      debugPort: DEBUG_PORT ?? null,
      browserArguments: startupArguments,
      webviewBrowserArguments,
      webviewDataDirectory: profile ? path.join(profile.root, "webview") : null,
      profileRoot: profile?.root ?? null,
      childPid: child?.pid ?? null,
      appProcessRecord: appProcessRecord ?? null,
      spawnError: childSpawnError?.message ?? null,
      childExit: child?.exitInfo ?? null,
      webviewDiagnostics: webviewDiagnostics
        ? "webview-diagnostics.json"
        : null,
      processOutput: "browser-process.log",
    },
    checks,
  };
  saveJson(artifactDir, "report.json", report);
  console.log(`[e2e-app] artifact: ${path.relative(root, artifactDir)}`);
  if (!scenarioSelectionError) {
    pruneOldRuns(path.join(root, "e2e-artifacts"), stamp, keepRunCount());
  }
  if (!report.passed) fail("one or more checks failed");
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
