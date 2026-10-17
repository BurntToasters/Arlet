#!/usr/bin/env node
// Native end-to-end gate (Windows, opt-in). Builds a release binary with a
// synthetic MusicKit token, drives the real app over WebView2's DevTools
// Protocol, and writes e2e-artifacts/<timestamp>/{report.json,screenshot.png,
// arlet.log}. Per-user Arlet data folders are moved aside and restored.
// The failure modes it covers are listed in docs/TESTING.md.
//
// Usage: node scripts/e2e-app.js [--skip-build] [--real-token]
// --real-token embeds MUSICKIT_DEVELOPER_TOKEN from the environment and checks
// that Apple accepts it from the release origin (catalog request, no sign-in).

import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MUSIC_FIXTURE_SEED, musicFixtureSource } from "./e2e-music-fixture.js";
import { runLibraryActions } from "./e2e-library-actions.js";
import { runPlaylistPlayback } from "./e2e-playlist-playback.js";
import { runFlows } from "./e2e-flows.js";
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
import { runSessionRestore } from "./e2e-session-restore.js";
import { sleep } from "./e2e-helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IDENTIFIER = "run.rosie.arlet";
const TARGET_DIR = path.join(root, "src-tauri", "target", "e2e");
const EXE = path.join(TARGET_DIR, "release", "arlet.exe");
const DEBUG_PORT = 9333;
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
const USER_TOKEN = "AqmL0f7xY2/Zp+Q9wR3kT8vN1bC4dE6gH5jK7mP0sU2yW==";

function fail(message) {
  throw new Error(`[e2e-app] ${message}`);
}

// Builds WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS from the developer's value plus
// extra switches. Feature lists are merged into one switch each so no list
// silently replaces another; other switches are kept once, first-seen order.
function buildWebView2Args(...extraSwitches) {
  const tokens = [
    ...(process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ?? "").split(/\s+/),
    ...extraSwitches,
  ];
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

function build(token) {
  const env = { ...process.env, CARGO_TARGET_DIR: TARGET_DIR };
  env.MUSICKIT_DEVELOPER_TOKEN = token;
  delete env.ARLET_SKIP_MUSICKIT_TOKEN;
  const result = spawnSync(
    "cmd.exe",
    ["/d", "/s", "/c", "npx tauri build --no-bundle"],
    { cwd: root, env, stdio: "inherit", windowsHide: true },
  );
  if (result.status !== 0) fail(`release build failed (${result.status})`);
}

function dataDirs() {
  return ["APPDATA", "LOCALAPPDATA"].map((name) => {
    const parent = process.env[name];
    if (!parent || !path.isAbsolute(parent)) fail(`${name} must be absolute`);
    const target = path.resolve(parent, IDENTIFIER);
    if (
      path.dirname(target) !== path.resolve(parent) ||
      path.basename(target) !== IDENTIFIER
    ) {
      fail(`unsafe E2E data directory: ${target}`);
    }
    return target;
  });
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

// Written into the test profile so a later run can tell it from real data.
const TEST_PROFILE_MARKER = ".arlet-e2e-test-profile";

function isTestProfile(dir) {
  return fs.existsSync(path.join(dir, TEST_PROFILE_MARKER));
}

/**
 * A run that was killed (a timeout, a closed terminal) cannot restore in
 * `finally`, and Windows gives no signal to catch. It leaves the real data in
 * a backup and the marked test profile in place; put the real data back
 * before anything else. Real data without a marker is never deleted.
 */
function recoverInterruptedRun() {
  for (const dir of dataDirs()) {
    const parent = path.dirname(dir);
    const backups = fs.existsSync(parent)
      ? fs
          .readdirSync(parent)
          .filter((name) => name.startsWith(`${IDENTIFIER}.e2e-backup-`))
          .sort()
      : [];
    if (backups.length === 0) {
      // A run with no real data to move leaves only the test profile.
      if (isTestProfile(dir)) {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
      }
      continue;
    }
    if (backups.length > 1 || (fs.existsSync(dir) && !isTestProfile(dir))) {
      fail(
        `previous E2E backup found: ${path.join(parent, backups[0])}. ${dir} holds data this run did not create, so it is left alone. Restore the backup by hand first.`,
      );
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
    fs.renameSync(path.join(parent, backups[0]), dir);
    console.log(
      `[e2e-app] Restored ${dir} from an interrupted run (${backups[0]}).`,
    );
  }
}

function moveAside(stamp) {
  recoverInterruptedRun();
  const moved = [];
  for (const dir of dataDirs()) {
    if (fs.existsSync(dir)) {
      const backup = `${dir}.e2e-backup-${stamp}`;
      fs.renameSync(dir, backup);
      moved.push({ dir, backup });
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, TEST_PROFILE_MARKER), "");
  }
  return moved;
}

function restore(moved) {
  // One profile that cannot be deleted must not stop the other restores.
  for (const dir of dataDirs()) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
    } catch (error) {
      console.error(
        `[e2e-app] Could not remove the test profile at ${dir}: ${error.message}`,
      );
    }
  }
  for (const { dir, backup } of moved) {
    try {
      fs.renameSync(backup, dir);
    } catch (error) {
      console.error(
        `[e2e-app] Could not restore ${dir}; your data is at ${backup}: ${error.message}`,
      );
    }
  }
}

/** The test profile's arlet.log (Tauri's app log dir), or "" when absent. */
function readTestLog() {
  try {
    return fs.readFileSync(
      path.join(dataDirs()[1], "logs", "arlet.log"),
      "utf8",
    );
  } catch {
    return "";
  }
}

function seedCorruptSettings() {
  const roaming = dataDirs()[0];
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
  const db = new DatabaseSync(path.join(dataDirs()[0], "arlet-library.db"));
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

/** Waits until no Arlet process is left, so files are no longer locked. */
function waitForArletExit(timeoutMs = 15_000) {
  return waitUntil(() => runningArletPid() === undefined, timeoutMs);
}

function processAlive(pid) {
  const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
    encoding: "utf8",
  }).stdout;
  return new RegExp(`\\b${pid}\\b`, "u").test(out);
}

// PID of the running Arlet. After the settings reset restart this differs
// from the spawned child's PID.
function runningArletPid() {
  const out = spawnSync(
    "tasklist",
    ["/FI", "IMAGENAME eq arlet.exe", "/FO", "CSV", "/NH"],
    { encoding: "utf8" },
  ).stdout;
  const match = /^"arlet\.exe","(\d+)"/imu.exec(out ?? "");
  return match ? Number(match[1]) : undefined;
}

// The settings reset restarts Arlet as a new process outside the original
// child's tree; run() refuses to start while any other Arlet is open.
function killArlet() {
  spawnSync("taskkill", ["/IM", "arlet.exe", "/T", "/F"], { stdio: "ignore" });
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
}
"@
$handle = (Get-Process -Name arlet | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle
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

/**
 * Waits for the app page on the debugging port. `launched` is the process
 * just started; its early exit is reported instead of a 60-second timeout.
 */
async function findPageTarget(deadline, launched) {
  let lastSeen = "port never answered";
  while (Date.now() < deadline) {
    if (launched && launched.exitCode !== null) {
      fail(`Arlet exited during startup (exit code ${launched.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await response.json();
      lastSeen = `targets: ${JSON.stringify(
        targets.map((target) => ({ type: target.type, url: target.url })),
      ).slice(0, 300)}`;
      const page = targets.find(
        (target) =>
          target.type === "page" &&
          /^(https?:\/\/tauri\.localhost|tauri:\/\/localhost)/u.test(
            target.url,
          ),
      );
      if (page) return page;
    } catch (error) {
      // WebView2 has not opened the debugging port yet.
      lastSeen = String(error?.cause?.code ?? error?.message ?? error);
    }
    await sleep(250);
  }
  // A port that never answers usually means WebView2 ignored
  // WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (policy) or another app holds it.
  fail(
    `app webview never exposed a debugging target on port ${DEBUG_PORT} (${lastSeen})`,
  );
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      fail(
        `page script threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result.value;
  };
  return { opened, send, evaluate, close: () => socket.close() };
}

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

async function run() {
  if (process.platform !== "win32") fail("Windows only");
  // Windows OpenSSH sessions are elevated and have no interactive desktop;
  // WebView2 fails there with "Invalid window handle" after a long wait.
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT) {
    fail(
      "cannot run in an SSH session (WebView2 has no desktop there); run it from a terminal at the machine's desktop",
    );
  }
  const running = spawnSync("tasklist", ["/FI", "IMAGENAME eq arlet.exe"], {
    encoding: "utf8",
  }).stdout;
  if (/arlet\.exe/iu.test(running)) {
    fail("close every running Arlet instance first (single-instance app)");
  }

  const realToken = process.argv.includes("--real-token");
  const token = realToken
    ? String(process.env.MUSICKIT_DEVELOPER_TOKEN ?? "").trim()
    : syntheticToken();
  if (!token)
    fail("--real-token needs MUSICKIT_DEVELOPER_TOKEN (run via dotenv)");
  if (!process.argv.includes("--skip-build")) build(token);
  if (!fs.existsSync(EXE)) fail(`missing ${EXE}`);

  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const artifactDir = path.join(root, "e2e-artifacts", stamp);
  fs.mkdirSync(artifactDir, { recursive: true });
  const checks = [];
  const check = (name, passed, detail) => {
    checks.push({ name, passed: Boolean(passed), detail });
    console.log(`[e2e-app] ${passed ? "PASS" : "FAIL"} ${name}`);
    // test:all shows only an output tail, so the reason must be printed too.
    if (!passed && detail !== undefined) {
      const text = typeof detail === "string" ? detail : JSON.stringify(detail);
      console.log(`[e2e-app]   ${String(text).slice(0, 600)}`);
    }
  };

  const moved = moveAside(stamp);
  // Ctrl+C skips `finally`; put the real data back before exiting. A hard
  // kill is recovered by the next run instead (recoverInterruptedRun).
  const onInterrupt = () => {
    console.error("[e2e-app] Interrupted; restoring your Arlet data.");
    killArlet();
    restore(moved);
    process.exit(130);
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGBREAK", onInterrupt);
  let child;
  let page;
  let musicRuntimeCapabilities;
  try {
    seedCorruptSettings();
    seedLegacyCache();
    fs.writeFileSync(
      path.join(dataDirs()[0], "window-state.json"),
      JSON.stringify(SEEDED_WINDOW_STATE),
    );
    child = spawn(EXE, [], {
      env: {
        ...process.env,
        MUSICKIT_DEVELOPER_TOKEN: RUNTIME_ENV_TOKEN,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: buildWebView2Args(
          `--remote-debugging-port=${DEBUG_PORT}`,
        ),
      },
      stdio: "ignore",
    });
    const target = await findPageTarget(Date.now() + 60_000, child);
    page = connect(target.webSocketDebuggerUrl);
    await page.opened;

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
    const settingsFile = path.join(dataDirs()[0], "settings.json");
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
    check(
      "release serves build-embedded token",
      served.ok && served.value === token && served.value !== RUNTIME_ENV_TOKEN,
      { ok: served.ok, matchesEmbedded: served.value === token },
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
    const revived = await findPageTarget(Date.now() + 30_000);
    page = connect(revived.webSocketDebuggerUrl);
    await page.opened;
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
    const restarted = await findPageTarget(Date.now() + 30_000);
    page = connect(restarted.webSocketDebuggerUrl);
    await page.opened;
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
      debugOffAfterReset && debugOnAfterReset,
      { debugOffAfterReset, debugOnAfterReset },
    );
    await page.evaluate('location.hash = "#/home"; return true;');

    // Reset deleted the saved geometry, and the closing window (reset
    // pending) must not have written it back.
    const windowStateFile = path.join(dataDirs()[0], "window-state.json");
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
      for (const [name, scenario] of [
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
        ["performance", runPerformance],
        ["polish", runPolish],
        ["discovery", runDiscovery],
        ["artwork", runArtwork],
        // Last: it signs out at the end.
        ["session-restore", runSessionRestore],
      ]) {
        try {
          // A menu left open by the previous scenario would intercept clicks.
          await page.evaluate(
            'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;',
          );
          await scenario({
            page,
            check,
            dataDir: dataDirs()[0],
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
    const relaunchWebView2Args = buildWebView2Args();
    const relaunch = spawn(EXE, [], {
      env: {
        ...process.env,
        MUSICKIT_DEVELOPER_TOKEN: RUNTIME_ENV_TOKEN,
        ...(relaunchWebView2Args && {
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: relaunchWebView2Args,
        }),
      },
      stdio: "ignore",
    });
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 20_000);
      relaunch.once("exit", () => {
        clearTimeout(timer);
        resolve();
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
    const sessionFile = path.join(dataDirs()[0], "playback-session.json");

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

    // Stop the app, then confirm the roaming cache moved to the local data
    // dir and migrated to the current schema.
    killArlet();
    await waitForArletExit();
    const legacyDb = path.join(dataDirs()[0], "arlet-library.db");
    const db = new DatabaseSync(path.join(dataDirs()[1], "arlet-library.db"), {
      readOnly: true,
    });
    const version = db.prepare("PRAGMA user_version").get().user_version;
    db.close();
    check(
      "legacy roaming cache moved to local data and migrated to schema 2",
      version === 2 && !fs.existsSync(legacyDb),
      {
        version,
        legacyLeft: fs.existsSync(legacyDb),
      },
    );
  } catch (error) {
    // Startup failures and panics are written to the test profile's log,
    // which restore() deletes; carry the last of them into the report.
    const native = readTestLog()
      .split(/\r?\n/u)
      .filter((line) => line.includes("[native] "))
      .slice(-2);
    check(
      "native E2E completes",
      false,
      [String(error?.message ?? error), ...native].join(" | "),
    );
  } finally {
    page?.close();
    if (child?.pid) {
      killArlet();
      await waitForArletExit();
    }
    const testLog = readTestLog();
    if (testLog && !fs.existsSync(path.join(artifactDir, "arlet.log"))) {
      fs.writeFileSync(path.join(artifactDir, "arlet.log"), testLog);
    }
    restore(moved);
  }

  const exeHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(EXE))
    .digest("hex");
  const commit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();
  const dirty =
    spawnSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).stdout.trim().length > 0;
  const report = {
    passed: checks.every((entry) => entry.passed),
    finishedAt: new Date().toISOString(),
    commit,
    dirtyWorktree: dirty,
    host: `${os.type()} ${os.release()} ${os.arch()}`,
    binary: { path: path.relative(root, EXE), sha256: exeHash },
    tokenMode: realToken ? "real" : "synthetic",
    musicFixtureSeed: MUSIC_FIXTURE_SEED,
    musicRuntimeCapabilities,
    checks,
  };
  fs.writeFileSync(
    path.join(artifactDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`[e2e-app] artifact: ${path.relative(root, artifactDir)}`);
  pruneOldRuns(path.join(root, "e2e-artifacts"), stamp, keepRunCount());
  if (!report.passed) fail("one or more checks failed");
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
