#!/usr/bin/env node
// Audit-fix behaviour against the MusicKit fixture (docs/TESTING.md "Audit
// fixes"): the unattended playback cap and its activity re-arm, a native
// pause event, cancelling a stuck sign-in (and that an abandoned attempt does
// not block expiry), the notice stack, the clipboard fallback, and a parked
// station that cannot be scrubbed, a manual Sign in again that is cancelled or
// rejected, a token MusicKit drops silently, and a parked queue that resumes
// in saved order with shuffle on. Timers are remapped only while a check
// needs them and restored after; the suite ends signed in and healthy.
// Offline auto-reload, the ratings caps and the updater are code-reviewed
// (TESTING.md).

import { restoreClipboard } from "./e2e-clipboard.js";
import { fixtureCall, sleep, waitFor as pollFor } from "./e2e-helpers.js";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const NOW_PLAYING = ".player-bar .player-track-copy strong";
const POSITION = ".player-progress span";
const PLAY_BUTTON = ".play-button";
const STATUS = ".titlebar-status";
const NOTICE = ".session-expired-notice";
const SCRUBBER = 'input[aria-label="Playback position"]';
const SONGS = ["song-a", "song-c"];
const SAVED_SECONDS = 42;
// Must match IDLE_PLAYBACK_LIMIT_MS in src/app/idle-guard.ts.
const IDLE_LIMIT_MS = 14_400_000;
// Must match the 1-min stream handoff delay in src/app/stream-release.ts.
const RELEASE_DELAY_MS = 60_000;
// The idle cap stand-in. The check's timing relies on the two values below.
const IDLE_TEST_MS = 6000;
const RELEASE_FAST_MS = 400;
const IDLE_NOTICE = "Paused after 4 hours without activity.";

const q = (value) => JSON.stringify(value);
const waitFor = (page, expression, timeoutMs = 10_000) =>
  pollFor(page, expression, timeoutMs, 50);
const snapshot = (page) => fixtureCall(page, "snapshot");
const sleepUntil = (at) => sleep(Math.max(0, at - Date.now()));

/** Runs one group; a throw becomes one failed check instead of a lost run. */
async function group(check, name, body) {
  try {
    await body();
  } catch (error) {
    check(`${name} completes`, false, String(error?.message ?? error));
  }
}

async function mark(page) {
  const trace = await snapshot(page);
  return {
    transitions: trace.transitions.length,
    requests: trace.requests.length,
  };
}

/** Transitions recorded since a mark. */
async function since(page, at) {
  const trace = await snapshot(page);
  return { transitions: trace.transitions.slice(at.transitions) };
}

const typesOf = (transitions, type) =>
  transitions.filter((item) => item.type === type);

const waitForTransition = (page, at, type, timeoutMs = 8000) =>
  waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.slice(${at.transitions}).some((item) => item.type === ${q(type)})`,
    timeoutMs,
  );

/**
 * Remaps the two delays this suite shortens. Each override reads the map at
 * call time, so a check can change it; restoreTimers puts the native one back.
 */
function installTimers(page, { idleMs, releaseMs }) {
  return page.evaluate(`
    window.__ARLET_E2E_NATIVE_SET_TIMEOUT__ ??= window.setTimeout;
    const native = window.__ARLET_E2E_NATIVE_SET_TIMEOUT__;
    window.__ARLET_AUDIT_TIMER_MAP__ = {
      ${IDLE_LIMIT_MS}: ${idleMs ?? IDLE_LIMIT_MS},
      ${RELEASE_DELAY_MS}: ${releaseMs ?? RELEASE_DELAY_MS},
    };
    window.setTimeout = (callback, delay, ...rest) =>
      native(callback, window.__ARLET_AUDIT_TIMER_MAP__[delay] ?? delay, ...rest);
    return true;`);
}

function restoreTimers(page) {
  return page.evaluate(`
    if (window.__ARLET_E2E_NATIVE_SET_TIMEOUT__) {
      window.setTimeout = window.__ARLET_E2E_NATIVE_SET_TIMEOUT__;
    }
    delete window.__ARLET_AUDIT_TIMER_MAP__;
    return true;`);
}

const clickPlayButton = (page) =>
  page.evaluate(
    `document.querySelector(${q(PLAY_BUTTON)})?.click(); return true;`,
  );

const buttonIs = (page, label, timeoutMs = 8000) =>
  waitFor(
    page,
    `document.querySelector(${q(PLAY_BUTTON)})?.getAttribute("aria-label") === ${q(label)}`,
    timeoutMs,
  );

const noticeShown = (page, timeoutMs = 10_000) =>
  waitFor(page, `Boolean(document.querySelector(${q(NOTICE)}))`, timeoutMs);
const noticeGone = (page, timeoutMs = 15_000) =>
  waitFor(page, `!document.querySelector(${q(NOTICE)})`, timeoutMs);

const statusText = (page) =>
  page.evaluate(
    `return document.querySelector(${q(STATUS)})?.textContent.trim() ?? null;`,
  );

/** Queues the two fixture songs and plays them. */
async function playSongs(page) {
  await page.evaluate(`
    const music = window.MusicKit.getInstance();
    await music.setQueue({ songs: ${q(SONGS)} });
    await music.play();
    return true;`);
  return buttonIs(page, "Pause");
}

/** Pauses through the player bar, with the stream handoff delay shortened. */
async function pauseWithFastRelease(page) {
  await installTimers(page, { releaseMs: RELEASE_FAST_MS });
  await clickPlayButton(page);
  const paused = await buttonIs(page, "Play");
  // The timer is armed on the state change; it keeps its shortened delay.
  await sleep(150);
  await restoreTimers(page);
  return paused;
}

async function openHash(page, hash, ready, timeoutMs = 10_000) {
  await page.evaluate(`location.hash = ${q(hash)}; return true;`);
  return ready ? waitFor(page, ready, timeoutMs) : true;
}

async function openMenuAndClick(page, id, itemId) {
  await fixtureCall(page, "selectContext", [id]);
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

async function saveScreenshot(page, artifactDir, name) {
  try {
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(
      path.join(artifactDir, name),
      Buffer.from(shot.data, "base64"),
    );
  } catch {
    // The harness still writes its own screenshot at the end of the suite.
  }
}

/** Emits a system-media event the way the Rust side does. */
const emitNative = (page, event, payload) =>
  page.evaluate(
    `return window.__ARLET_E2E_TAURI_EVENTS__.emit(${q(event)}, ${q(payload)}) > 0;`,
  );

/**
 * 4 h of playback with no activity pauses with a notice. Then a keydown during
 * playback re-arms the timer: no pause before the re-armed delay, and one
 * pause after it. Timing: the keydown lands 2 s after Play, so the first timer
 * would fire at 6 s and the re-armed one at 8 s. The check reads at 7 s, one
 * second clear of each.
 */
async function idleCap(page, check, artifactDir) {
  await installTimers(page, { idleMs: IDLE_TEST_MS });
  const started = await playSongs(page);
  const at = await mark(page);
  const paused = await buttonIs(page, "Play", IDLE_TEST_MS + 6000);
  const notice = await waitFor(
    page,
    `document.body.innerText.includes(${q(IDLE_NOTICE)})`,
    5000,
  );
  // Let a second pause, if any, land before counting.
  await sleep(1000);
  const pauses = typesOf((await since(page, at)).transitions, "pause");
  await saveScreenshot(page, artifactDir, "screenshot-audit-fixes-idle.png");
  check(
    "idle cap: playback with no activity pauses once, with the 4-hour notice",
    started && paused && notice && pauses.length === 1,
    { started, paused, notice, pauses: pauses.length },
  );

  // Activity re-arms the timer. The idle pause above left no timer behind.
  const resumeAt = Date.now();
  await clickPlayButton(page);
  const resumed = await buttonIs(page, "Pause", 5000);
  const beforeActivity = await mark(page);
  await sleepUntil(resumeAt + 2000);
  await page.evaluate(
    `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true })); return true;`,
  );
  await sleepUntil(resumeAt + 7000);
  const stillPlaying = await page.evaluate(
    `return document.querySelector(${q(PLAY_BUTTON)})?.getAttribute("aria-label") === "Pause";`,
  );
  const noPauseYet = typesOf(
    (await since(page, beforeActivity)).transitions,
    "pause",
  );
  check(
    "a keydown re-arms the idle timer: no pause in the window after activity",
    resumed && stillPlaying && noPauseYet.length === 0,
    { resumed, stillPlaying, pausesAfterActivity: noPauseYet.length },
  );
  const pausedAfterIdle = await buttonIs(page, "Play", 12_000);
  check("the re-armed idle timer pauses once activity stops", pausedAfterIdle, {
    pausedAfterIdle,
  });
  // Restored before Play, so the next timer uses the real limit.
  await restoreTimers(page);
  await clickPlayButton(page);
  check(
    "Play resumes after the idle pause",
    await buttonIs(page, "Pause", 5000),
    {},
  );
}

/** A native pause event (suspend, output change) pauses playing audio. */
async function nativePause(page, check) {
  const playing = await buttonIs(page, "Pause", 5000);
  const at = await mark(page);
  const emitted = await emitNative(page, "windows-media-control", "pause");
  const paused = await buttonIs(page, "Play", 5000);
  const pauses = typesOf((await since(page, at)).transitions, "pause");
  check(
    "a windows-media-control pause event pauses playback",
    playing && emitted && paused && pauses.length >= 1,
    { playing, emitted, paused, pauses: pauses.length },
  );
  await clickPlayButton(page);
  await buttonIs(page, "Pause", 5000);
}

/**
 * A "connection back" event with MusicKit already initialized must not
 * reload the app (the reload exists only after a failed init).
 */
async function onlineWithoutOutage(page, check) {
  await page.evaluate(`
    window.__ARLET_AUDIT_MARK__ = Date.now();
    window.dispatchEvent(new Event("online"));
    return true;`);
  await sleep(1500);
  const survived = await page.evaluate(
    `return typeof window.__ARLET_AUDIT_MARK__ === "number";`,
  );
  check(
    "a connection return with MusicKit healthy does not reload the app",
    survived,
    {
      survived,
    },
  );
}

/**
 * The diagnostics copy must answer within 6 s: "Copied", or the busy error
 * when the plugin and the browser clipboard both fail. The log names the path.
 */
async function clipboardCopy(page, check, logDir) {
  const shown = await openHash(
    page,
    "#/settings",
    `[...document.querySelectorAll("button")].some((node) => node.textContent.includes("Copy diagnostics report"))`,
    15_000,
  );
  const previous = await page.evaluate(`
    try {
      return (await window.__TAURI_INTERNALS__.invoke("plugin:clipboard-manager|read_text")) ?? null;
    } catch {
      return null;
    }`);
  const clickedAt = Date.now();
  await page.evaluate(`
    [...document.querySelectorAll("button")]
      .find((node) => node.textContent.includes("Copy diagnostics report"))
      ?.click();
    return true;`);
  let outcome = { copied: false, busy: false };
  while (Date.now() - clickedAt < 6000) {
    outcome = await page.evaluate(`
      return {
        copied: [...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Copied"),
        busy: [...document.querySelectorAll(".action-toast-message")].some((node) => node.textContent.includes("clipboard is busy")),
      };`);
    if (outcome.copied || outcome.busy) break;
    await sleep(100);
  }
  const elapsed = Date.now() - clickedAt;
  // Best effort, and kept out of clipboard history (e2e-clipboard.js).
  restoreClipboard(previous);
  // Observed, not asserted: the log names the path that ran, when readable.
  const logFile = path.join(logDir, "arlet.log");
  let paths = [];
  for (let attempt = 0; attempt < 10 && paths.length === 0; attempt += 1) {
    await sleep(300);
    try {
      paths = fs
        .readFileSync(logFile, "utf8")
        .split(/\r?\n/)
        .filter((line) => /[Cc]lipboard/.test(line))
        .slice(-3);
    } catch {
      paths = [];
    }
  }
  check(
    "copy answers within 6 s with Copied or the busy error",
    shown && (outcome.copied || outcome.busy) && elapsed <= 6000,
    { shown, ...outcome, elapsedMs: elapsed, logged: paths },
  );
}

/** An expired sign-in: the notice, the cancel controls, and the handoff. */
async function cancelSignIn(page, check, artifactDir) {
  await fixtureCall(page, "configure", [{ hangAuthorize: true }]);
  await fixtureCall(page, "emitAuthorizationStatus", [false]);
  const shown = await noticeShown(page);
  const cancelButton = `Boolean(document.querySelector('${NOTICE} button[data-action="cancel-sign-in"]'))`;

  // Attempt 1: the window never reports back, so the call stays held.
  await page.evaluate(
    `document.querySelector('${NOTICE} .primary-button')?.click(); return true;`,
  );
  const pending = await waitFor(
    page,
    `document.querySelector('${NOTICE} .primary-button')?.textContent.trim() === "Signing in…" && ${cancelButton}`,
    10_000,
  );
  const held = (await snapshot(page)).authorizeHeld;
  await saveScreenshot(
    page,
    artifactDir,
    "screenshot-audit-fixes-sign-in-pending.png",
  );

  // Every "Signing in…" state carries a Cancel. Titlebar and Settings too.
  await page.evaluate(
    `document.querySelector(${q(STATUS)})?.click(); return true;`,
  );
  const titlebarCancel = await waitFor(
    page,
    `Boolean(document.querySelector('.connection-popover button[role="menuitem"][data-action="cancel-sign-in"]'))`,
    5000,
  );
  await page.evaluate(`
    if (document.querySelector(".connection-popover")) {
      document.querySelector(${q(STATUS)})?.click();
    }
    return true;`);
  await openHash(page, "#/settings");
  const settingsCancel = await waitFor(
    page,
    `Boolean(document.querySelector('.account-card button[data-action="cancel-sign-in"]'))`,
    8000,
  );
  await openHash(page, "#/home");
  check(
    "a sign-in in progress shows Cancel in the notice, titlebar and Settings",
    shown && pending && held === 1 && titlebarCancel && settingsCancel,
    { shown, pending, held, titlebarCancel, settingsCancel },
  );

  await page.evaluate(
    `document.querySelector('${NOTICE} button[data-action="cancel-sign-in"]')?.click(); return true;`,
  );
  const cleared = await waitFor(
    page,
    `document.querySelector('${NOTICE} .primary-button')?.textContent.trim() === "Sign in again" && !document.querySelector('${NOTICE} .primary-button').disabled && !${cancelButton}`,
    5000,
  );
  check(
    "Cancel clears the pending state; the sign-in buttons work again",
    cleared &&
      (await noticeShown(page, 1000)) &&
      (await snapshot(page)).authorizeHeld === 1,
    { cleared, held: (await snapshot(page)).authorizeHeld },
  );

  // Attempt 2 starts fresh while attempt 1 is still held.
  await page.evaluate(
    `document.querySelector('${NOTICE} .primary-button')?.click(); return true;`,
  );
  const second = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().authorizeHeld === 2`,
    5000,
  );
  await page.evaluate(
    `document.querySelector('${NOTICE} button[data-action="cancel-sign-in"]')?.click(); return true;`,
  );
  const clearedAgain = await waitFor(page, `!${cancelButton}`, 5000);
  check(
    "a new sign-in during an abandoned attempt starts a fresh attempt",
    second && clearedAgain,
    { second, clearedAgain, held: (await snapshot(page)).authorizeHeld },
  );

  // The abandoned calls finish later: the user did sign in, so the session
  // becomes healthy and the notice clears.
  await fixtureCall(page, "configure", [{ hangAuthorize: false }]);
  const released = await fixtureCall(page, "releaseAuthorize");
  const healed = await noticeGone(page, 15_000);
  const healthy = (await statusText(page))?.includes("Connected") === true;
  check(
    "an abandoned sign-in that completes later still signs in",
    released === 2 &&
      healed &&
      healthy &&
      (await snapshot(page)).authorized === true,
    { released, healed, healthy },
  );

  // A later expiry is still detected: the abandoned attempts block nothing.
  await fixtureCall(page, "emitAuthorizationStatus", [false]);
  const expiredAgain = await noticeShown(page);
  const stack = await page.evaluate(`
    const stack = document.querySelector(".notice-stack");
    const notice = document.querySelector(${q(NOTICE)});
    const rect = notice?.getBoundingClientRect();
    return {
      inStack: Boolean(stack && notice && stack.contains(notice)),
      column: stack ? getComputedStyle(stack).flexDirection === "column" : false,
      onScreen: Boolean(rect && rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight),
      stackHeight: stack?.getBoundingClientRect().height ?? null,
    };`);
  check("a session expiry after the cancels is still detected", expiredAgain, {
    expiredAgain,
  });
  // Token-expiry notice is not forced (see TESTING.md): only the container.
  check(
    "the notice stack holds the expired-sign-in notice in a column on screen",
    stack.inStack && stack.column && stack.onScreen,
    stack,
  );
  await saveScreenshot(page, artifactDir, "screenshot-audit-fixes-expired.png");

  // Sign in again to finish. The stack takes no space once the notice clears.
  await page.evaluate(
    `document.querySelector('${NOTICE} .primary-button')?.click(); return true;`,
  );
  const restored = await noticeGone(page, 15_000);
  const emptyStack = await page.evaluate(
    `return document.querySelector(".notice-stack")?.getBoundingClientRect().height ?? 0;`,
  );
  check(
    "after the sign-in completes the notice stack takes no space",
    restored && emptyStack === 0,
    { restored, emptyStack },
  );
}

/** A parked station: the scrubber is disabled and seek does not move it. */
async function parkedStation(page, check) {
  await openHash(page, "#/home");
  const startAt = await mark(page);
  const clicked = await openMenuAndClick(page, "nav-multi", "start-station");
  const queued = await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.slice(${startAt.transitions}).some((item) => item.type === "setQueue" && item.options?.url)`,
  );
  // The fixture queues no songs for a station URL; a playing song stands in.
  await fixtureCall(page, "setCurrentTrack", ["song-e"]);
  await waitFor(
    page,
    `document.querySelector(${q(NOW_PLAYING)})?.textContent === "Track E"`,
  );
  await fixtureCall(page, "emitPlaybackTime", [SAVED_SECONDS]);
  await waitFor(
    page,
    `document.querySelector(${q(POSITION)})?.textContent === "0:42"`,
  );
  const pauseAt = await mark(page);
  const paused = await pauseWithFastRelease(page);
  const stopped = await waitForTransition(page, pauseAt, "stop");
  await sleep(300);

  const before = await page.evaluate(`return {
    position: document.querySelector(${q(POSITION)})?.textContent ?? null,
    disabled: document.querySelector(${q(SCRUBBER)})?.disabled ?? null,
  };`);
  const seekAt = await mark(page);
  // Disabled controls swallow user clicks, so the change event is dispatched
  // directly: the handler must still drop the seek.
  await page.evaluate(`
    const input = document.querySelector(${q(SCRUBBER)});
    if (input) {
      input.value = "5";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;`);
  await sleep(600);
  const after = await page.evaluate(`return {
    position: document.querySelector(${q(POSITION)})?.textContent ?? null,
  };`);
  const seeks = typesOf((await since(page, seekAt)).transitions, "seekToTime");
  check(
    "a parked station cannot be scrubbed and a seek does not move the position",
    clicked &&
      queued &&
      paused &&
      stopped &&
      before.position === "0:42" &&
      before.disabled === true &&
      after.position === "0:42" &&
      seeks.length === 0,
    {
      clicked,
      queued,
      paused,
      stopped,
      before,
      after,
      seeks: seeks.length,
    },
  );

  // Play resumes the station. The parked seek was dropped, so it is not replayed.
  const resumeAt = await mark(page);
  await clickPlayButton(page);
  const resumed = await waitForTransition(page, resumeAt, "play");
  const playing = await buttonIs(page, "Pause", 5000);
  const resumeSeeks = typesOf(
    (await since(page, resumeAt)).transitions,
    "seekToTime",
  );
  check(
    "Play after a parked station resumes without a seek",
    resumed && playing && resumeSeeks.length === 0,
    { resumed, playing, resumeSeeks: resumeSeeks.length },
  );
}

/**
 * Signs in through Settings when the app is not connected (a previous suite
 * can leave it signed out). Returns whether the titlebar reads Connected.
 */
async function ensureSignedIn(page) {
  const connected = () =>
    page.evaluate(
      `return document.querySelector(${q(STATUS)})?.textContent.includes("Connected") === true;`,
    );
  if (await connected()) return true;
  await openHash(
    page,
    "#/settings",
    `[...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Sign in" || node.textContent.trim() === "Sign out")`,
    15_000,
  );
  await page.evaluate(`
    const button = [...document.querySelectorAll("button")]
      .find((node) => node.textContent.trim() === "Sign in");
    button?.click();
    return true;`);
  await waitFor(
    page,
    `[...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Sign out")`,
    15_000,
  );
  await openHash(page, "#/home");
  return waitFor(
    page,
    `document.querySelector(${q(STATUS)})?.textContent.includes("Connected") === true`,
    15_000,
  );
}

const CANCEL_LINE = "Apple Music sign-in expired: sign-in cancelled";
const REAUTH_LINE =
  "Apple Music sign-in expired: re-auth did not finish with a user token";
const TOKEN_LINE =
  "Apple Music sign-in expired: MusicKit no longer holds a user token";
const PARKED_ALBUM = "album-1";
const PARKED_QUEUE = ["album-a", "album-b", "album-c", "album-d"];
const PARKED_START = 1;

/** Lines of arlet.log containing text in this E2E run's explicit log directory. */
function logCount(logDir, text) {
  const logFile = path.join(logDir, "arlet.log");
  try {
    return fs.readFileSync(logFile, "utf8").split(text).length - 1;
  } catch {
    return 0;
  }
}

/** Waits until arlet.log holds more copies of text than before. */
async function logGrew(logDir, text, before) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (logCount(logDir, text) > before) return true;
    await sleep(250);
  }
  return false;
}

const clickSettingsSignIn = (page) =>
  page.evaluate(`
    [...document.querySelectorAll(".account-card button")]
      .find((node) => node.textContent.trim() === "Sign in again")?.click();
    return true;`);

const clickSettingsCancel = (page) =>
  page.evaluate(
    `document.querySelector('.account-card button[data-action="cancel-sign-in"]')?.click(); return true;`,
  );

const clickNoticeSignIn = (page) =>
  page.evaluate(
    `document.querySelector('${NOTICE} .primary-button')?.click(); return true;`,
  );

const noticeNow = (page) =>
  page.evaluate(`return Boolean(document.querySelector(${q(NOTICE)}));`);

/** Sends one Play-bar transport button (Previous track or Next track). */
const clickTransport = (page, label) =>
  page.evaluate(
    `document.querySelector('button[aria-label="${label}"]')?.click(); return true;`,
  );

/** setQueue calls recorded since a mark, with their song IDs and start index. */
async function queuedSince(page, at) {
  const trace = await snapshot(page);
  return trace.transitions
    .slice(at.transitions)
    .filter((item) => item.type === "setQueue")
    .map((item) => ({
      ids: item.ids,
      index: item.index,
      shuffle: item.shuffle,
    }));
}

/**
 * A manual "Sign in again" on a healthy session (Settings). A cancel expires
 * it unless MusicKit still holds a token; a failed attempt expires it and the
 * notice signs in again. An abandoned attempt that completes clears it.
 */
async function reauthFailures(page, check, logDir) {
  await ensureSignedIn(page);
  await openHash(
    page,
    "#/settings",
    `[...document.querySelectorAll(".account-card button")].some((node) => node.textContent.trim() === "Sign in again")`,
    15_000,
  );

  // A cancel while MusicKit is unauthorized expires the session.
  const cancelBefore = logCount(logDir, CANCEL_LINE);
  await fixtureCall(page, "configure", [{ hangAuthorize: true }]);
  await clickSettingsSignIn(page);
  const pending = await waitFor(
    page,
    `Boolean(document.querySelector('.account-card button[data-action="cancel-sign-in"]'))`,
    8000,
  );
  const held = (await snapshot(page)).authorizeHeld;
  await clickSettingsCancel(page);
  const expired = await noticeShown(page, 8000);
  const logged = await logGrew(logDir, CANCEL_LINE, cancelBefore);
  const unauthorized = (await snapshot(page)).authorized === false;
  check(
    "a cancelled Sign in again on a healthy session shows the expired notice",
    pending && held === 1 && expired && logged && unauthorized,
    { pending, held, expired, logged, unauthorized },
  );
  await fixtureCall(page, "configure", [{ hangAuthorize: false }]);
  const released = await fixtureCall(page, "releaseAuthorize");
  const healed = await noticeGone(page, 15_000);
  check(
    "the abandoned attempt that completes later clears the expired notice",
    released === 1 && healed,
    { released, healed },
  );

  // A cancel while MusicKit still holds a token (regained during the wait) does not expire.
  await openHash(page, "#/settings");
  await fixtureCall(page, "configure", [{ hangAuthorize: true }]);
  await clickSettingsSignIn(page);
  const pendingAgain = await waitFor(
    page,
    `Boolean(document.querySelector('.account-card button[data-action="cancel-sign-in"]'))`,
    8000,
  );
  await fixtureCall(page, "emitAuthorizationStatus", [true]);
  await clickSettingsCancel(page);
  await sleep(1500);
  const expiredWhileAuthorized = await noticeNow(page);
  const stillAuthorized = (await snapshot(page)).authorized === true;
  const connected = (await statusText(page))?.includes("Connected") === true;
  check(
    "a cancel while MusicKit still holds a token does not expire the session",
    pendingAgain && !expiredWhileAuthorized && stillAuthorized && connected,
    { pendingAgain, expiredWhileAuthorized, stillAuthorized, connected },
  );
  await fixtureCall(page, "configure", [{ hangAuthorize: false }]);
  await fixtureCall(page, "releaseAuthorize");
  await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().authorizeHeld === 0`,
  );

  // A rejected or closed sign-in expires the session; the notice signs in again.
  const rejectBefore = logCount(logDir, REAUTH_LINE);
  await fixtureCall(page, "configure", [{ rejectAuthorize: true }]);
  await clickSettingsSignIn(page);
  const rejected = await noticeShown(page, 10_000);
  const rejectLogged = await logGrew(logDir, REAUTH_LINE, rejectBefore);
  check(
    "a rejected Sign in again shows the expired notice and logs the reason",
    rejected && rejectLogged,
    { rejected, rejectLogged },
  );
  await fixtureCall(page, "configure", [{ rejectAuthorize: false }]);
  await clickNoticeSignIn(page);
  const restored = await noticeGone(page, 15_000);
  check(
    "Sign in again from the notice restores the session after a failed attempt",
    restored && (await snapshot(page)).authorized === true,
    { restored },
  );
}

/**
 * MusicKit drops its token without an event. The next suspect error must
 * expire the session from MusicKit's state, with no /v1/me/storefront probe.
 */
async function lostToken(page, check, logDir) {
  await openHash(page, "#/home");
  // The sign-in that ended the previous check may still run its follow-up
  // probe; let it finish so it is not counted against this check.
  await sleep(1000);
  await waitFor(
    page,
    `${FIXTURE}.snapshot().requests.every((request) => String(request.path).split("?", 1)[0] !== "/v1/me/storefront" || request.completedAt || request.error)`,
    10_000,
  );
  const at = await mark(page);
  const logBefore = logCount(logDir, TOKEN_LINE);
  await fixtureCall(page, "configure", [{ rejectMeStatus: 403 }]);
  await page.evaluate(
    `window.MusicKit.getInstance().isAuthorized = false; return true;`,
  );
  await page.evaluate(
    `document.querySelector(${q(STATUS)})?.click(); return true;`,
  );
  await waitFor(page, `Boolean(document.querySelector(".connection-popover"))`);
  await page.evaluate(`
    [...document.querySelectorAll(".connection-popover [role=menuitem]")]
      .find((node) => node.textContent.trim() === "Refresh current view")?.click();
    return true;`);
  const expired = await noticeShown(page, 10_000);
  const logged = await logGrew(logDir, TOKEN_LINE, logBefore);
  const probes = (await snapshot(page)).requests
    .slice(at.requests)
    .filter(
      (request) =>
        String(request.path).split("?", 1)[0] === "/v1/me/storefront",
    ).length;
  check(
    "a lost MusicKit token expires the session without a /v1/me/storefront probe",
    expired && logged && probes === 0,
    { expired, logged, probes },
  );
  await fixtureCall(page, "configure", [{ rejectMeStatus: 0 }]);
  await clickNoticeSignIn(page);
  await noticeGone(page, 15_000);
}

// Must match readableRefusal and SESSION_EXPIRED_MESSAGE in src/musickit/catalog.ts.
const READABLE_REFUSAL =
  "Apple Music didn't accept your sign-in. Sign in again from Settings.";
const EXPIRED_TEXT =
  "Your Apple Music sign-in expired. Sign in again to load your library.";

/** Clicks a Settings button by its exact text. */
async function clickSettingsButton(page, text) {
  return page.evaluate(`
    const button = [...document.querySelectorAll("button")]
      .find((node) => node.textContent.trim() === ${q(text)});
    if (!button) return { found: false, disabled: null, clicked: false };
    const disabled = button.disabled || button.getAttribute("aria-disabled") === "true";
    if (disabled) return { found: true, disabled: true, clicked: false };
    button.click();
    return { found: true, disabled: false, clicked: true };`);
}

/** True when some element's own text is exactly the bare status code. */
function bareStatusShown(page, status) {
  return page.evaluate(`
    return [...document.querySelectorAll("body *")].some((node) =>
      node.children.length === 0 && node.textContent.trim() === ${q(String(status))});`);
}

/**
 * Signing out and back in without a restart: MusicKit replaces its API object
 * (the fixture does too), so library requests must use the new one. Before the
 * fix they kept the old object and its dead token, and every /v1/me request
 * failed with a bare "403" while the titlebar said Connected. Then a refused
 * library request must show readable text, never the bare status.
 * Failure modes also include clicking a visible-but-disabled Sign in button
 * while sign-out's async persisted-data clears are still finishing.
 */
async function signOutThenIn(page, check) {
  await openHash(
    page,
    "#/settings",
    `[...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Sign out")`,
    15_000,
  );
  const generationBefore = (await snapshot(page)).apiGeneration;
  const signOutClick = await clickSettingsButton(page, "Sign out");
  const signInVisible = await waitFor(
    page,
    `[...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Sign in")`,
    15_000,
  );
  const signInInitialState = await page.evaluate(`
    const button = [...document.querySelectorAll("button")]
      .find((node) => node.textContent.trim() === "Sign in");
    return {
      found: Boolean(button),
      disabled: button ? button.disabled : null,
      ariaDisabled: button?.getAttribute("aria-disabled") ?? null,
      status: document.querySelector(${q(STATUS)})?.textContent.trim() ?? null,
    };`);
  const signInReady =
    signInVisible &&
    (await waitFor(
      page,
      `[...document.querySelectorAll("button")].some((node) =>
      node.textContent.trim() === "Sign in" &&
      !node.disabled && node.getAttribute("aria-disabled") !== "true")`,
      15_000,
    ));
  const signInButtonState = await page.evaluate(`
    const button = [...document.querySelectorAll("button")]
      .find((node) => node.textContent.trim() === "Sign in");
    return {
      found: Boolean(button),
      disabled: button ? button.disabled : null,
      ariaDisabled: button?.getAttribute("aria-disabled") ?? null,
      status: document.querySelector(${q(STATUS)})?.textContent.trim() ?? null,
    };`);
  check(
    "sign-out cleanup enables Settings Sign in before the test clicks it",
    signOutClick.clicked &&
      signInVisible &&
      signInReady &&
      signInButtonState.found &&
      !signInButtonState.disabled &&
      signInButtonState.ariaDisabled !== "true",
    {
      signOutClick,
      signInVisible,
      signInInitialState,
      signInReady,
      signInButtonState,
    },
  );
  const signInClick = signInReady
    ? await clickSettingsButton(page, "Sign in")
    : {
        found: signInButtonState.found,
        disabled: signInButtonState.disabled,
        clicked: false,
      };
  const signedOut = signOutClick.clicked && signInVisible;
  const signedIn =
    signInClick.clicked &&
    (await waitFor(
      page,
      `[...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Sign out")`,
      15_000,
    ));
  await openHash(page, "#/home");
  const at = await mark(page);
  await page.evaluate(
    `document.querySelector(${q(STATUS)})?.click(); return true;`,
  );
  await waitFor(page, `Boolean(document.querySelector(".connection-popover"))`);
  await page.evaluate(`
    [...document.querySelectorAll(".connection-popover [role=menuitem]")]
      .find((node) => node.textContent.trim() === "Refresh current view")?.click();
    return true;`);
  const loaded = await waitFor(
    page,
    `${FIXTURE}.snapshot().requests.slice(${at.requests}).some((request) => String(request.path).startsWith("/v1/me") && request.completedAt)`,
    15_000,
  );
  await sleep(500);
  const trace = await snapshot(page);
  const meRequests = trace.requests
    .slice(at.requests)
    .filter((request) => String(request.path).startsWith("/v1/me"));
  const stale = meRequests.filter((request) => request.staleApi).length;
  const failed = meRequests.filter((request) => request.error).length;
  const bare = await bareStatusShown(page, 403);
  const banner = await page.evaluate(
    `return Boolean(document.querySelector(${q(NOTICE)}));`,
  );
  check(
    "after Sign out and Sign in without a restart, library requests use the new sign-in",
    signedOut &&
      signInReady &&
      signInClick.clicked &&
      signedIn &&
      loaded &&
      trace.apiGeneration > generationBefore &&
      stale === 0 &&
      failed === 0 &&
      !bare &&
      !banner,
    {
      signedOut,
      signOutClick,
      signInVisible,
      signInInitialState,
      signInReady,
      signInButtonState,
      signInClick,
      signedIn,
      loaded,
      generationBefore,
      generationAfter: trace.apiGeneration,
      meRequests: meRequests.length,
      stale,
      failed,
      bare,
      banner,
    },
  );

  // A refused library request shows readable text, not the bare "403".
  await fixtureCall(page, "configure", [{ rejectMeStatus: 403 }]);
  await page.evaluate(
    `document.querySelector(${q(STATUS)})?.click(); return true;`,
  );
  await waitFor(page, `Boolean(document.querySelector(".connection-popover"))`);
  await page.evaluate(`
    [...document.querySelectorAll(".connection-popover [role=menuitem]")]
      .find((node) => node.textContent.trim() === "Refresh current view")?.click();
    return true;`);
  // The banner depends on the probe cooldown; the readable card text does not.
  const readable = await waitFor(
    page,
    `document.body.innerText.includes(${q(READABLE_REFUSAL)}) || document.body.innerText.includes(${q(EXPIRED_TEXT)})`,
    10_000,
  );
  const bareAfter = await bareStatusShown(page, 403);
  check(
    "a refused library request shows readable text, never a bare 403",
    readable && !bareAfter,
    { readable, bareAfter },
  );
  await fixtureCall(page, "configure", [{ rejectMeStatus: 0 }]);
  if (await noticeShown(page, 1000)) {
    await clickNoticeSignIn(page);
    await noticeGone(page, 15_000);
  }
}

/**
 * A parked queue keeps its saved order when resumed: Next, Previous and Play
 * each queue only the songs from the target index on, with shuffle on. The
 * queue starts from the app's own row Play on the album, with shuffle on, so
 * the app (not the test) builds the queue and parks it.
 */
async function parkedQueueOrder(page, check) {
  await openHash(
    page,
    `#/album/${PARKED_ALBUM}`,
    `document.querySelectorAll(".library-track-row").length >= 4 && document.querySelector(".library-detail-hero h1")?.textContent === "Fixture Album"`,
    15_000,
  );
  const shuffled = await page.evaluate(`
    const button = document.querySelector('button[aria-label="Toggle shuffle"]');
    if (button && button.getAttribute("aria-pressed") !== "true") button.click();
    return true;`);
  const shuffleOn = await waitFor(
    page,
    `document.querySelector('button[aria-label="Toggle shuffle"]')?.getAttribute("aria-pressed") === "true"`,
  );
  const at = await mark(page);
  // The app's Play from the second row: a fresh queue, so nothing parked remains.
  await page.evaluate(`
    document.querySelectorAll(".library-track-row")[${PARKED_START}]?.click();
    return true;`);
  const playing = await buttonIs(page, "Pause", 8000);
  const first = (await queuedSince(page, at))[0];
  check(
    "the parked queue starts shuffled from Album Track B, with the whole album",
    shuffled &&
      shuffleOn &&
      playing &&
      first?.shuffle === true &&
      sameIds(first.ids, PARKED_QUEUE) &&
      first.index === PARKED_START,
    { shuffled, shuffleOn, playing, first },
  );

  // Park on Album Track B, then Next: songs after it only, in saved order.
  let pauseAt = await mark(page);
  await fixtureCall(page, "emitPlaybackTime", [SAVED_SECONDS]);
  await waitFor(
    page,
    `document.querySelector(${q(POSITION)})?.textContent === "0:42"`,
  );
  await pauseWithFastRelease(page);
  await waitForTransition(page, pauseAt, "stop");
  await sleep(300);
  const nextAt = await mark(page);
  await clickTransport(page, "Next track");
  await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().transitions.slice(${nextAt.transitions}).some((item) => item.type === "setQueue")`,
  );
  const nextQueue = await queuedSince(page, nextAt);
  await buttonIs(page, "Pause", 5000);
  check(
    "Next on a parked queue queues only the songs after the current one, in order",
    nextQueue.length === 1 &&
      sameIds(nextQueue[0].ids, ["album-c", "album-d"]) &&
      nextQueue[0].index === 0,
    { nextQueue },
  );

  // Park on Album Track C (index 2); Previous steps back to Track B (index 1).
  pauseAt = await mark(page);
  await pauseWithFastRelease(page);
  await waitForTransition(page, pauseAt, "stop");
  await sleep(300);
  const previousAt = await mark(page);
  await clickTransport(page, "Previous track");
  await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().transitions.slice(${previousAt.transitions}).some((item) => item.type === "setQueue")`,
  );
  const previousQueue = await queuedSince(page, previousAt);
  await buttonIs(page, "Pause", 5000);
  check(
    "Previous on a parked queue queues from the song it steps back to, never earlier songs",
    previousQueue.length === 1 &&
      sameIds(previousQueue[0].ids, ["album-b", "album-c", "album-d"]) &&
      previousQueue[0].index === 0,
    { previousQueue },
  );

  // Park on Album Track B with a saved position; Play resumes there in saved order.
  await fixtureCall(page, "emitPlaybackTime", [SAVED_SECONDS]);
  await waitFor(
    page,
    `document.querySelector(${q(POSITION)})?.textContent === "0:42"`,
  );
  pauseAt = await mark(page);
  await pauseWithFastRelease(page);
  await waitForTransition(page, pauseAt, "stop");
  await sleep(300);
  const playAt = await mark(page);
  await clickPlayButton(page);
  await waitForTransition(page, playAt, "play");
  await buttonIs(page, "Pause", 5000);
  const resumeTrace = await since(page, playAt);
  const resumeQueues = resumeTrace.transitions.filter(
    (item) => item.type === "setQueue",
  );
  const seeks = resumeTrace.transitions.filter(
    (item) => item.type === "seekToTime",
  );
  check(
    "Play after a handoff queues Album Track B onward in saved order, then seeks to the saved position",
    resumeQueues.length === 1 &&
      sameIds(resumeQueues[0].ids, ["album-b", "album-c", "album-d"]) &&
      resumeQueues[0].index === 0 &&
      seeks.some((item) => item.seconds === SAVED_SECONDS),
    {
      queues: resumeQueues.map((item) => item.ids),
      seeks: seeks.map((item) => item.seconds),
    },
  );
}

const sameIds = (actual, expected) =>
  JSON.stringify(actual ?? []) === JSON.stringify(expected);

/** Leaves the app signed in and healthy for the next suite. */
async function restoreHealthy(page, check) {
  await fixtureCall(page, "configure", [{ hangAuthorize: false }]);
  await fixtureCall(page, "releaseAuthorize");
  if (
    await page.evaluate(`return Boolean(document.querySelector(${q(NOTICE)}));`)
  ) {
    await page.evaluate(
      `document.querySelector('${NOTICE} .primary-button')?.click(); return true;`,
    );
    await noticeGone(page, 15_000);
  }
  await ensureSignedIn(page);
  const trace = await snapshot(page);
  const connected = (await statusText(page))?.includes("Connected") === true;
  check(
    "audit fixes end signed in and healthy for the next suite",
    trace.authorized === true && connected && trace.authorizeHeld === 0,
    { authorized: trace.authorized, connected, held: trace.authorizeHeld },
  );
}

/** Audit-fix checks (see the header and docs/TESTING.md "Audit fixes"). */
export async function runAuditFixes({ page, check, logDir, artifactDir }) {
  try {
    await group(check, "audit fixes setup", async () => {
      await fixtureCall(page, "reset");
      await openHash(page, "#/home");
      const ready = await ensureSignedIn(page);
      check("audit fixes start from a signed-in fixture", ready, { ready });
    });
    await group(check, "idle cap", () => idleCap(page, check, artifactDir));
    await group(check, "native pause", () => nativePause(page, check));
    await group(check, "online without outage", () =>
      onlineWithoutOutage(page, check),
    );
    await group(check, "clipboard copy", () =>
      clipboardCopy(page, check, logDir),
    );
    await group(check, "cancel sign-in", () =>
      cancelSignIn(page, check, artifactDir),
    );
    await group(check, "re-auth failures", () =>
      reauthFailures(page, check, logDir),
    );
    await group(check, "lost token", () => lostToken(page, check, logDir));
    await group(check, "sign out then in", () => signOutThenIn(page, check));
    await group(check, "parked queue order", () =>
      parkedQueueOrder(page, check),
    );
    await group(check, "parked station", () => parkedStation(page, check));
  } finally {
    await restoreTimers(page);
    await group(check, "audit fixes cleanup", () =>
      restoreHealthy(page, check),
    );
  }
}
