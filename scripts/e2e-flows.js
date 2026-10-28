/* Failure modes live in docs/TESTING.md ("Search, playlist dialogs, and
 * support report"): search results that cannot be played, playlist dialogs
 * that drop the song or the name, and a support report that leaks tokens. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { restoreClipboard } from "./e2e-clipboard.js";
import { fixtureCall, sleep, waitFor } from "./e2e-helpers.js";

const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPPORT_REPORT_PREFIX = "# Arlet diagnostics report";
const VERSION = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
async function clickMenuItem(page, target, itemId) {
  await fixtureCall(page, "selectContext", [target]);
  const ready = await waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item="${itemId}"]:not(:disabled)')`,
  );
  if (!ready) return false;
  await page.evaluate(
    `document.querySelector('.context-menu [data-menu-item="${itemId}"]').click(); return true;`,
  );
  return true;
}

/** Types into a Preact-controlled field the way a user would. */
function typeInto(page, selector, value) {
  return page.evaluate(`
    const field = document.querySelector(${JSON.stringify(selector)});
    if (!field) return false;
    field.focus();
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(field),
      "value",
    ).set;
    setter.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
}

function requestsSince(page, since) {
  return page.evaluate(
    `return ${FIXTURE}.snapshot().requests.slice(${since});`,
  );
}

async function searchAndPlay({ page, check }) {
  await fixtureCall(page, "reset");
  // Same route the sidebar search box opens; the view searches its query.
  await page.evaluate(
    `location.hash = "#/search?q=fixture%20top"; return true;`,
  );
  const typed = await waitFor(
    page,
    `document.querySelector('.search-form input[type="search"]')?.value === "fixture top"`,
  );
  const listed = await waitFor(
    page,
    `document.querySelectorAll(".search-results-list .search-row").length >= 3`,
  );
  const titles = await page.evaluate(
    `return [...document.querySelectorAll(".search-results-list .search-row")].map((row) => row.textContent);`,
  );
  await page.evaluate(
    `document.querySelectorAll(".search-results-list .search-row")[1]?.click(); return true;`,
  );
  const queued = await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.some((item) => item.type === "setQueue" && item.ids?.[0] === "top-2")`,
  );
  // Slow starts are diagnosed from this line in support reports.
  let timingLine;
  const timingDeadline = Date.now() + 8000;
  while (!timingLine && Date.now() < timingDeadline) {
    timingLine = (await readAppLog(page))
      .split(/\r?\n/u)
      .find(
        (line) =>
          line.includes("Play timing: audible after") &&
          line.includes("setQueue"),
      );
    if (!timingLine) await sleep(250);
  }
  check("a Play logs how long it took to become audible", Boolean(timingLine), {
    timingLine: timingLine ?? null,
  });
  check(
    "a search result plays that song first",
    typed &&
      listed &&
      titles.some((title) => title.includes("Top Song 2")) &&
      queued,
    {
      typed,
      listed,
      titles,
      feedback: await page.evaluate(
        `return document.querySelector(".search-feedback")?.textContent ?? null;`,
      ),
      searchRequests: (await fixtureCall(page, "snapshot")).requests
        .filter((request) => request.path.includes("search"))
        .map((request) => ({ path: request.path, error: request.error })),
    },
  );
}

async function addToPlaylist({ page, check }) {
  await fixtureCall(page, "reset");
  await page.evaluate(`location.hash = "#/home"; return true;`);
  const opened = await clickMenuItem(page, "song-a", "add-to-playlist");
  // The picker lists playlists only after its library load answers (the
  // fixture delays it 800 ms, and a refresh left by an earlier scenario can
  // run alongside it), so wait for the rendered option, not a fixed pause.
  const pickerTimeoutMs = 20000;
  const dialogShown = await waitFor(
    page,
    `document.querySelector(".playlist-dialog-backdrop")`,
    pickerTimeoutMs,
  );
  const listed = await waitFor(
    page,
    `[...document.querySelectorAll(".playlist-dialog-option")].some((node) => node.textContent.includes("Fixture Playlist"))`,
    pickerTimeoutMs,
  );
  const picker = await page.evaluate(`
    return {
      options: [...document.querySelectorAll(".playlist-dialog-option")].map((node) => node.textContent),
      feedback: document.querySelector(".playlist-dialog-feedback")?.textContent ?? null,
      playlistRequests: ${FIXTURE}.snapshot().requests
        .filter((request) => request.path.includes("/v1/me/library/playlists"))
        .map((request) => ({ method: request.method, path: request.path, error: request.error })),
    };`);
  const since = (await fixtureCall(page, "snapshot")).requests.length;
  await page.evaluate(`
    [...document.querySelectorAll(".playlist-dialog-option")]
      .find((node) => node.textContent.includes("Fixture Playlist"))
      ?.click();
    return true;`);
  const closed = await waitFor(
    page,
    `!document.querySelector(".playlist-dialog-backdrop")`,
  );
  const added = (await requestsSince(page, since)).find(
    (request) =>
      request.method === "POST" &&
      request.path.includes("/v1/me/library/playlists/playlist-1/tracks"),
  );
  check(
    "Add to playlist posts the song to the chosen playlist and closes",
    opened &&
      listed &&
      closed &&
      JSON.stringify(added?.body ?? "").includes("song-a"),
    { opened, dialogShown, listed, closed, added, picker },
  );
}

async function createPlaylist({ page, check }) {
  await fixtureCall(page, "reset");
  const opened = await clickMenuItem(page, "song-b", "add-to-playlist");
  await waitFor(page, `document.querySelector(".playlist-dialog-footer")`);
  await page.evaluate(`
    [...document.querySelectorAll(".playlist-dialog-footer button")]
      .find((node) => node.textContent.includes("New playlist"))
      ?.click();
    return true;`);
  const formShown = await waitFor(
    page,
    `document.querySelector(".playlist-dialog-form input[type='text']")`,
  );
  const typed = await typeInto(
    page,
    ".playlist-dialog-form input[type='text']",
    "E2E Mix",
  );
  const since = (await fixtureCall(page, "snapshot")).requests.length;
  await page.evaluate(
    `document.querySelector(".playlist-dialog-form").requestSubmit(); return true;`,
  );
  const closed = await waitFor(
    page,
    `!document.querySelector(".playlist-dialog-backdrop")`,
  );
  const created = (await requestsSince(page, since)).find(
    (request) =>
      request.method === "POST" &&
      request.path.split("?", 1)[0] === "/v1/me/library/playlists",
  );
  const body = JSON.stringify(created?.body ?? "");
  check(
    "New playlist sends the typed name with the selected song",
    opened &&
      formShown &&
      typed &&
      closed &&
      body.includes("E2E Mix") &&
      body.includes("song-b"),
    { opened, formShown, typed, closed, created },
  );
}

/** Reads an actual clipboard provider through the bounded DevTools transport. */
async function readClipboardProvider(page, provider, timeoutMs = 1000) {
  const expression =
    provider === "tauri"
      ? "try { const text = await window.__TAURI_INTERNALS__.invoke('plugin:clipboard-manager|read_text'); return { ok: true, text: typeof text === 'string' ? text : null }; } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }"
      : "try { if (!navigator.clipboard?.readText) return { ok: false, error: 'browser clipboard read unavailable' }; const text = await navigator.clipboard.readText(); return { ok: true, text: typeof text === 'string' ? text : null }; } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }";
  try {
    return {
      provider,
      ...(await page.evaluate(expression, { timeoutMs })),
    };
  } catch (error) {
    return {
      provider,
      ok: false,
      error: String(error?.message ?? error),
    };
  }
}

function clipboardErrorKind(error) {
  const message = String(error ?? "").toLowerCase();
  if (message.includes("busy") || message.includes("locked")) return "busy";
  if (message.includes("timeout") || message.includes("timed out"))
    return "timeout";
  if (
    message.includes("denied") ||
    message.includes("permission") ||
    message.includes("access")
  ) {
    return "access-denied";
  }
  if (message.includes("unavailable") || message.includes("not a function"))
    return "unavailable";
  return error ? "read-error" : null;
}

async function grantBrowserClipboardPermission(page, permissionState) {
  if (permissionState.granted) return true;
  try {
    const origin = await page.evaluate("return location.origin;");
    if (origin !== "http://tauri.localhost") {
      permissionState.errorKind = "unexpected-origin";
      return false;
    }
    await page.send(
      "Browser.grantPermissions",
      {
        origin,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      },
      { timeoutMs: 2000 },
    );
    permissionState.granted = true;
    permissionState.everGranted = true;
    return true;
  } catch (error) {
    permissionState.errorKind = clipboardErrorKind(error?.message ?? error);
    return false;
  }
}

/** Native clipboard read first; browser fallback stays in this isolated E2E context. */
async function readClipboardText(page, permissionState, timeoutMs = 1000) {
  const native = await readClipboardProvider(page, "tauri", timeoutMs);
  const outcomes = [
    {
      provider: "tauri",
      status:
        native.ok && typeof native.text === "string" ? "read" : "read-error",
      errorKind: clipboardErrorKind(native.error),
    },
  ];
  if (native.ok && typeof native.text === "string") {
    return { ok: true, text: native.text, provider: "tauri", outcomes };
  }

  if (await grantBrowserClipboardPermission(page, permissionState)) {
    const browser = await readClipboardProvider(page, "browser", timeoutMs);
    outcomes.push({
      provider: "browser",
      status:
        browser.ok && typeof browser.text === "string" ? "read" : "read-error",
      errorKind: clipboardErrorKind(browser.error),
    });
    if (browser.ok && typeof browser.text === "string") {
      return { ok: true, text: browser.text, provider: "browser", outcomes };
    }
    return {
      ok: false,
      error: browser.error ?? native.error,
      provider: null,
      outcomes,
    };
  }

  outcomes.push({
    provider: "browser-permission",
    status: "permission-error",
    errorKind: permissionState.errorKind,
  });
  return {
    ok: false,
    error: native.error,
    provider: null,
    outcomes,
  };
}

/** Reads both real providers until the copied report is observed or the deadline expires. */
async function readClipboardReport(page, permissionState, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  const outcomes = [];
  let attempts = 0;
  let last = { ok: false, error: "no read attempted" };
  do {
    attempts += 1;
    const remaining = Math.max(1, deadline - Date.now());
    const native = await readClipboardProvider(
      page,
      "tauri",
      Math.min(1000, remaining),
    );
    last = native;
    outcomes.push({
      provider: "tauri",
      status:
        native.ok && typeof native.text === "string" ? "read" : "read-error",
      errorKind: clipboardErrorKind(native.error),
      matched:
        native.ok && native.text?.startsWith(SUPPORT_REPORT_PREFIX) === true,
    });
    if (
      native.ok &&
      typeof native.text === "string" &&
      native.text.startsWith(SUPPORT_REPORT_PREFIX)
    ) {
      return {
        ...native,
        attempts,
        status: "report",
        outcomes,
      };
    }

    const browserPermission = await grantBrowserClipboardPermission(
      page,
      permissionState,
    );
    if (browserPermission && Date.now() < deadline) {
      const browser = await readClipboardProvider(
        page,
        "browser",
        Math.max(1, Math.min(1000, deadline - Date.now())),
      );
      last = browser;
      outcomes.push({
        provider: "browser",
        status:
          browser.ok && typeof browser.text === "string"
            ? "read"
            : "read-error",
        errorKind: clipboardErrorKind(browser.error),
        matched:
          browser.ok &&
          browser.text?.startsWith(SUPPORT_REPORT_PREFIX) === true,
      });
      if (
        browser.ok &&
        typeof browser.text === "string" &&
        browser.text.startsWith(SUPPORT_REPORT_PREFIX)
      ) {
        return {
          ...browser,
          attempts,
          status: "report",
          outcomes,
        };
      }
    } else if (!browserPermission) {
      outcomes.push({
        provider: "browser-permission",
        status: "permission-error",
        errorKind: permissionState.errorKind,
        matched: false,
      });
    }

    const remainingAfterRead = deadline - Date.now();
    if (remainingAfterRead > 0) {
      await sleep(Math.min(150, remainingAfterRead));
    }
  } while (Date.now() < deadline);

  return {
    ...last,
    attempts,
    status: !last.ok
      ? "read-error"
      : last.text === null || last.text === ""
        ? "empty"
        : "different-text",
    errorKind: clipboardErrorKind(last.error),
    outcomes,
  };
}

async function clickDiagnosticsCopyButton(page) {
  let attempted = false;
  try {
    const box = await page.evaluate(
      "const button = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('Copy diagnostics report')); " +
        "if (!button) return null; button.scrollIntoView({ block: 'center' }); " +
        "const rect = button.getBoundingClientRect(); " +
        "return rect.width > 0 && rect.height > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;",
    );
    if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) {
      return { attempted, dispatched: false, errorKind: null };
    }
    attempted = true;
    await page.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: box.x, y: box.y },
      { timeoutMs: 2000 },
    );
    await page.send(
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
      },
      { timeoutMs: 2000 },
    );
    await page.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
      },
      { timeoutMs: 2000 },
    );
    return { attempted, dispatched: true, errorKind: null };
  } catch (error) {
    return {
      attempted,
      dispatched: false,
      errorKind: clipboardErrorKind(error?.message ?? error),
    };
  }
}

async function resetBrowserClipboardPermission(page, permissionState) {
  if (!permissionState.granted) return "not-granted";
  try {
    await page.send("Browser.resetPermissions", {}, { timeoutMs: 2000 });
    permissionState.granted = false;
    return "reset";
  } catch (error) {
    return (
      "reset-error:" +
      (clipboardErrorKind(error?.message ?? error) ?? "unknown")
    );
  }
}

async function supportReport({ page, check }) {
  const permissionState = {
    granted: false,
    everGranted: false,
    errorKind: null,
  };
  const previousClipboard = await readClipboardText(
    page,
    permissionState,
    1000,
  );
  let shown = false;
  let copyInputAttempted = false;
  let copyInputDispatched = false;
  let copied = false;
  let report = {
    ok: false,
    status: "preservation-read-failed",
    attempts: 0,
    outcomes: previousClipboard.outcomes,
  };
  let clipboardRestore = "not-written";
  let interactionErrorKind = null;
  let browserPermissionReset = true;
  let text = "";
  let toastTexts = [];

  try {
    await page.evaluate("location.hash = '#/settings'; return true;");
    shown = await waitFor(
      page,
      "[...document.querySelectorAll('button')].some((node) => node.textContent.includes('Copy diagnostics report'))",
    );

    // Refuse to overwrite user clipboard data if its text cannot be captured.
    if (
      shown &&
      previousClipboard.ok &&
      typeof previousClipboard.text === "string"
    ) {
      const input = await clickDiagnosticsCopyButton(page);
      copyInputAttempted = input.attempted;
      copyInputDispatched = input.dispatched;
      interactionErrorKind = input.errorKind;
      copied = await waitFor(
        page,
        "[...document.querySelectorAll('button')].some((node) => node.textContent.trim() === 'Copied')",
        6000,
      );
      report = await readClipboardReport(page, permissionState, 5000);
      text = report.ok && typeof report.text === "string" ? report.text : "";
    }
  } catch (error) {
    interactionErrorKind = clipboardErrorKind(error?.message ?? error);
    report = {
      ...report,
      status: "interaction-error",
    };
  } finally {
    if (copyInputAttempted) {
      const expectedReport =
        report.ok &&
        typeof report.text === "string" &&
        report.text.startsWith(SUPPORT_REPORT_PREFIX) &&
        report.text.includes("Arlet " + VERSION)
          ? report.text
          : undefined;
      clipboardRestore = restoreClipboard(
        previousClipboard.text,
        expectedReport,
      );
    }
    const permissionReset = await resetBrowserClipboardPermission(
      page,
      permissionState,
    );
    browserPermissionReset =
      permissionReset === "reset" || permissionReset === "not-granted";
    if (permissionReset !== "reset" && permissionReset !== "not-granted") {
      permissionState.errorKind = permissionReset;
    }
    try {
      toastTexts = await page.evaluate(
        "return [...document.querySelectorAll('.action-toast-message')].map((node) => node.textContent);",
      );
    } catch {
      toastTexts = [];
    }
  }

  const reportStartsWithPrefix = text.startsWith(SUPPORT_REPORT_PREFIX);
  const reportIncludesVersion =
    reportStartsWithPrefix && text.includes("Arlet " + VERSION);
  const reportContainsToken = reportStartsWithPrefix
    ? /eyJ[\w-]{8,}\.[\w-]+/u.test(text)
    : null;
  const clipboardRestored = ["restored", "cleared"].includes(clipboardRestore);
  const clipboardChangedSafely = clipboardRestore === "changed";
  const clipboardDispositionSafe = clipboardRestored || clipboardChangedSafely;
  check(
    "the support report names the version and carries no tokens",
    shown &&
      previousClipboard.ok &&
      copyInputDispatched &&
      copied &&
      reportStartsWithPrefix &&
      reportIncludesVersion &&
      !reportContainsToken &&
      clipboardDispositionSafe &&
      browserPermissionReset,
    {
      shown,
      copyInputAttempted,
      copyInputDispatched,
      copied,
      clipboardBefore: {
        provider: previousClipboard.provider,
        outcomes: previousClipboard.outcomes,
      },
      clipboardRead: {
        status: report.status,
        attempts: report.attempts,
        outcomes: report.outcomes,
        errorKind: report.errorKind ?? clipboardErrorKind(report.error),
      },
      browserPermission: {
        granted: permissionState.everGranted,
        errorKind: permissionState.errorKind,
        reset: browserPermissionReset,
      },
      reportStartsWithPrefix,
      reportIncludesVersion,
      reportContainsToken,
      length: reportStartsWithPrefix ? text.length : null,
      clipboardRestore,
      clipboardRestored,
      clipboardChangedSafely,
      clipboardDispositionSafe,
      interactionErrorKind,
      toasts: toastTexts,
    },
  );
}
/** Reads the app's own log file through the native log-dir command. */
async function readAppLog(page) {
  const dir = await page.evaluate(`
    try {
      return await window.__TAURI_INTERNALS__.invoke("get_log_dir");
    } catch (error) {
      return null;
    }`);
  if (!dir) return "";
  try {
    return fs.readFileSync(path.join(dir, "arlet.log"), "utf8");
  } catch {
    return "";
  }
}

async function errorRecovery({ page, check }) {
  // Load songs first so the list has an "Updated …" line to format.
  await page.evaluate(`location.hash = "#/library/songs"; return true;`);
  await waitFor(page, `document.querySelector(".library-track-row")`);
  await page.evaluate(`location.hash = "#/settings"; return true;`);
  await waitFor(page, `document.querySelector(".settings-section")`);
  // A real render failure in one view. The Library view formats its "Updated"
  // time with a formatter made once at import, so the `format` getter throws
  // only for formatters that predate this injection. Formatters made since
  // (the Titlebar and Home views make theirs per render) still work, so only
  // the Library view fails to render. Both are restored exactly in `finally`.
  await page.evaluate(`
    const proto = Intl.DateTimeFormat.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "format");
    const Original = Intl.DateTimeFormat;
    const created = new WeakSet();
    const Tracked = function DateTimeFormat(locales, options) {
      const formatter = new Original(locales, options);
      created.add(formatter);
      return formatter;
    };
    Tracked.prototype = Original.prototype;
    Tracked.supportedLocalesOf = Original.supportedLocalesOf;
    window.__ARLET_E2E_INTL__ = { descriptor, Original };
    Object.defineProperty(proto, "format", {
      configurable: true,
      get() {
        if (!created.has(this)) throw new Error("e2e-render-marker");
        return descriptor.get.call(this);
      },
    });
    Intl.DateTimeFormat = Tracked;
    location.hash = "#/library/songs";
    return true;`);
  let contained = false;
  let shellKept = false;
  let recovered = false;
  try {
    contained = await waitFor(
      page,
      `[...document.querySelectorAll(".content-area h2")].some((node) => node.textContent.includes("couldn't be shown"))`,
    );
    shellKept = await page.evaluate(
      `return Boolean(document.querySelector(".player-bar") && document.querySelector(".sidebar-link") && document.querySelector('[aria-label="Sleep timer"]'));`,
    );
  } finally {
    await page.evaluate(`
      const saved = window.__ARLET_E2E_INTL__;
      if (saved) {
        Object.defineProperty(Intl.DateTimeFormat.prototype, "format", saved.descriptor);
        Intl.DateTimeFormat = saved.Original;
        delete window.__ARLET_E2E_INTL__;
      }
      return true;`);
  }
  await page.evaluate(`
    [...document.querySelectorAll(".content-area button")]
      .find((node) => node.textContent.trim() === "Try again")
      ?.click();
    return true;`);
  recovered = await waitFor(
    page,
    `document.querySelector(".library-track-row")`,
  );
  check(
    "a page that fails to render is contained, and Try again recovers it",
    contained && shellKept && recovered,
    { contained, shellKept, recovered },
  );

  // Errors nothing catches still reach the log for support reports.
  await page.evaluate(`
    setTimeout(() => {
      throw new Error("e2e-uncaught-marker");
    }, 0);
    Promise.reject(new Error("e2e-rejection-marker"));
    return true;`);
  let log = "";
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    log = await readAppLog(page);
    if (
      log.includes("e2e-uncaught-marker") &&
      log.includes("e2e-rejection-marker")
    ) {
      break;
    }
    await sleep(250);
  }
  check(
    "render failures and uncaught errors are written to arlet.log",
    log.includes("Page failed to render (library): e2e-render-marker") &&
      log.includes("Uncaught error: e2e-uncaught-marker") &&
      log.includes("Unhandled promise rejection: e2e-rejection-marker"),
    {
      render: log.includes("e2e-render-marker"),
      uncaught: log.includes("e2e-uncaught-marker"),
      rejection: log.includes("e2e-rejection-marker"),
    },
  );
}

/** Search, playlist dialogs, and the support report, through the real UI. */
export async function runFlows({ page, check }) {
  for (const scenario of [
    searchAndPlay,
    addToPlaylist,
    createPlaylist,
    supportReport,
    errorRecovery,
  ]) {
    try {
      await page.evaluate(
        'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;',
      );
      await scenario({ page, check });
    } catch (error) {
      check(
        `${scenario.name} completes`,
        false,
        String(error?.message ?? error),
      );
    }
  }
  await page.evaluate(`location.hash = "#/home"; return true;`);
}
