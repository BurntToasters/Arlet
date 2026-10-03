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
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  return `${encode({ alg: "ES256", kid: "E2ETEST" })}.${encode({ iss: "E2E", iat: 0, exp, origin: [RELEASE_ORIGIN] })}.${Buffer.from("e2e-signature").toString("base64url")}`;
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
  return [
    path.join(process.env.APPDATA ?? "", IDENTIFIER),
    path.join(process.env.LOCALAPPDATA ?? "", IDENTIFIER),
  ];
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
  try {
    seedCorruptSettings();
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

    // Origin-scoped tokens only work if the app really runs on RELEASE_ORIGIN.
    const origin = await page.evaluate("return location.origin;");
    check(`app origin is ${RELEASE_ORIGIN}`, origin === RELEASE_ORIGIN, {
      origin,
    });

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

    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(
      path.join(artifactDir, "screenshot.png"),
      Buffer.from(shot.data, "base64"),
    );
  } finally {
    page?.close();
    if (child?.pid) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
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
