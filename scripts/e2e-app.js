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
import { runSongNavigation } from "./e2e-song-navigation.js";
import { runTransport } from "./e2e-transport.js";
import { runQueueEdit } from "./e2e-queue-edit.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IDENTIFIER = "run.rosie.arlet";
const TARGET_DIR = path.join(root, "src-tauri", "target", "e2e");
const EXE = path.join(TARGET_DIR, "release", "arlet.exe");
const DEBUG_PORT = 9333;
const RUNTIME_ENV_TOKEN = "runtime-env-token-must-be-ignored";
// Mirrors RELEASE_ORIGIN in src-tauri/src/token_policy.rs.
const RELEASE_ORIGIN = "http://tauri.localhost";
const USER_TOKEN = "AqmL0f7xY2/Zp+Q9wR3kT8vN1bC4dE6gH5jK7mP0sU2yW==";

function fail(message) {
  throw new Error(`[e2e-app] ${message}`);
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

function moveAside(stamp) {
  // A crashed run leaves real data in a backup and test data in place.
  // Moving again would bury that backup, so stop until it is restored.
  for (const dir of dataDirs()) {
    const parent = path.dirname(dir);
    const stale = fs.existsSync(parent)
      ? fs
          .readdirSync(parent)
          .filter((name) => name.startsWith(`${IDENTIFIER}.e2e-backup-`))
      : [];
    if (stale.length > 0) {
      fail(
        `previous E2E backup found: ${path.join(parent, stale[0])}. Delete ${dir} and rename the backup back to ${IDENTIFIER} first.`,
      );
    }
  }
  const moved = [];
  for (const dir of dataDirs()) {
    if (!fs.existsSync(dir)) continue;
    const backup = `${dir}.e2e-backup-${stamp}`;
    fs.renameSync(dir, backup);
    moved.push({ dir, backup });
  }
  return moved;
}

function restore(moved) {
  for (const dir of dataDirs()) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
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
};

function processAlive(pid) {
  const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
    encoding: "utf8",
  }).stdout;
  return new RegExp(`\\b${pid}\\b`, "u").test(out);
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

const near = (actual, expected) => Math.abs(actual - expected) <= 2;

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function findPageTarget(deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find(
        (target) =>
          target.type === "page" &&
          /^(https?:\/\/tauri\.localhost|tauri:\/\/localhost)/u.test(
            target.url,
          ),
      );
      if (page) return page;
    } catch {
      // WebView2 has not opened the debugging port yet.
    }
    await sleep(250);
  }
  fail("app webview never exposed a debugging target");
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

async function run() {
  if (process.platform !== "win32") fail("Windows only");
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
  };

  const moved = moveAside(stamp);
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
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG_PORT}`,
      },
      stdio: "ignore",
    });
    const target = await findPageTarget(Date.now() + 60_000);
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
    musicRuntimeCapabilities = await page.evaluate(`
      const deadline = Date.now() + 12000;
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

    // 13. Reset settings: Cancel changes nothing; confirming restores
    // defaults and restarts, keeping sign-in storage and pins.
    // Failure modes: Cancel resets anyway; the .bak or a pending save brings
    // old settings back; sign-in (WebView2 storage) or pins are wiped; the
    // app never restarts; saves stay blocked in the restarted process.
    const settingsFile = path.join(dataDirs()[0], "settings.json");
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
      ]) {
        try {
          await scenario({ page, check });
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

    // Stop the app, then confirm the cache file was migrated in place.
    killArlet();
    await sleep(1500);
    const db = new DatabaseSync(path.join(dataDirs()[0], "arlet-library.db"), {
      readOnly: true,
    });
    const version = db.prepare("PRAGMA user_version").get().user_version;
    db.close();
    check("legacy cache database migrated to schema 1", version === 1, {
      version,
    });
  } catch (error) {
    check("native E2E completes", false, String(error?.message ?? error));
  } finally {
    page?.close();
    if (child?.pid) {
      killArlet();
      await sleep(1500);
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
  if (!report.passed) fail("one or more checks failed");
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
