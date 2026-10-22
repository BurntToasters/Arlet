#!/usr/bin/env node

/*
 * Mini player failure modes: the button or Ctrl+Shift+M leaves the shell up or
 * the window never shrinks (3 s); wrong song or dead transport buttons;
 * keep-on-top not flipping or not calling the native command; leaving mini
 * mode not restoring the start size (40 px); Escape or Ctrl+Shift+M not
 * toggling both ways; full screen not left on entering or not restored on
 * leaving; a layout switch pausing playback; the scenario ending in
 * mini mode. Mini geometry is never persisted (window_state.rs owns that).
 * Keys go through CDP Input events so the real window keydown listener runs.
 */

import { fixtureCall, sleep, waitFor as pollFor } from "./e2e-helpers.js";

const ALBUM_ID = "album-1";
const CTRL = 2;
const SHIFT = 8;
const CTRL_SHIFT = CTRL | SHIFT;
const SIZE_TOLERANCE_PX = 40;
const RESIZE_TIMEOUT_MS = 3000;

const KEY = {
  m: { key: "M", code: "KeyM", keyCode: 77 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  f11: { key: "F11", code: "F11", keyCode: 122 },
};
// Window full screen, read from the window size against the screen.
const FULLSCREEN =
  "window.outerWidth >= screen.width - 2 && window.outerHeight >= screen.height - 2";

const MINI = `document.querySelector(".mini-player")`;
const SHELL = `document.querySelector(".app-shell")`;
const MINI_TITLE = `document.querySelector(".mini-player .mini-player-copy strong")?.textContent?.trim()`;
const MINI_PLAY_LABEL = `document.querySelector(".mini-player .mini-player-play")?.getAttribute("aria-label")`;
const MINI_PIN_PRESSED = `document.querySelector(".mini-player [data-mini-pin]")?.getAttribute("aria-pressed")`;
const BAR_PLAY_LABEL = `document.querySelector(".play-button")?.getAttribute("aria-label")`;
const BAR_TITLE = `document.querySelector(".player-bar .player-track-copy strong")?.textContent`;
const PLAYING = `${BAR_PLAY_LABEL} === "Pause"`;
const PAUSED = `${BAR_PLAY_LABEL} === "Play"`;

const waitFor = (page, expression, timeoutMs = 8000) =>
  pollFor(page, expression, timeoutMs, 50);

const snapshot = (page) => fixtureCall(page, "snapshot");
const since = (before, after) =>
  after.transitions.slice(before.transitions.length);

async function press(page, key, modifiers = 0) {
  const base = {
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    modifiers,
  };
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(150);
}

/** Clicks the first element matching the selector; false when absent. */
function clickSelector(page, selector) {
  return page.evaluate(`
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    node.click();
    return true;
  `);
}

function clickButtonByText(page, label) {
  return page.evaluate(`
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === ${JSON.stringify(label)},
    );
    button?.click();
    return Boolean(button);
  `);
}

const windowSize = (page) =>
  page.evaluate(
    `return { width: window.innerWidth, height: window.innerHeight };`,
  );

/** Waits until the window is within the tolerance of the starting size. */
function waitForSizeNear(page, start, timeoutMs = RESIZE_TIMEOUT_MS) {
  return waitFor(
    page,
    `Math.abs(window.innerWidth - ${start.width}) <= ${SIZE_TOLERANCE_PX} && Math.abs(window.innerHeight - ${start.height}) <= ${SIZE_TOLERANCE_PX}`,
    timeoutMs,
  );
}

/**
 * Counts IPC commands the desktop recorder saw. Tauri's invoke is not
 * writable, so wrapping it records nothing; the recorder counts every call.
 */
async function ipcCount(page, command) {
  return page.evaluate(
    `return window.__ARLET_E2E_TAURI_EVENTS__?.count(${JSON.stringify(command)}) ?? 0;`,
  );
}

/** Ends in the normal shell so later scenarios start from a clean window. */
async function leaveMiniIfActive(page) {
  if (await page.evaluate(`return Boolean(${MINI});`)) {
    await clickSelector(page, "[data-mini-expand]");
    await waitFor(page, `Boolean(${SHELL}) && !${MINI}`, RESIZE_TIMEOUT_MS);
  }
}

export async function runMiniPlayer({ page, check }) {
  await fixtureCall(page, "reset");
  await page.evaluate(`
    location.hash = "#/album/${ALBUM_ID}";
    return true;
  `);
  const albumReady = await waitFor(
    page,
    `document.querySelectorAll(".library-track-row").length >= 2 && document.querySelector(".library-detail-hero h1")?.textContent === "Fixture Album"`,
  );
  check("mini player scenario renders the album detail", albumReady);
  if (!albumReady) return;

  try {
    await clickButtonByText(page, "Play all");
    const started = await waitFor(
      page,
      `${BAR_TITLE} === "Album Track A" && ${PLAYING}`,
    );
    await page.evaluate(`document.activeElement?.blur(); return true;`);
    check("Play all starts the album before the mini player opens", started);
    if (!started) return;

    const start = await windowSize(page);
    // Transitions recorded only while a layout switch runs. Transport steps
    // inside the mini player pause on purpose, so they are not in this list.
    const switchTransitions = [];
    const settleSwitch = async (since_) => {
      await sleep(400);
      switchTransitions.push(...since(since_, await snapshot(page)));
    };

    // Enter with the PlayerBar button.
    const beforeInvokes = await ipcCount(page, "set_mini_player");
    const enterMark = await snapshot(page);
    await clickSelector(page, "[data-mini-player-toggle]");
    const entered = await waitFor(page, `Boolean(${MINI}) && !${SHELL}`);
    check(
      "the mini player button swaps the shell for the mini player",
      entered,
    );
    const shrunk = await waitFor(
      page,
      `window.innerWidth <= 400 && window.innerHeight <= 200`,
      RESIZE_TIMEOUT_MS,
    );
    const compact = await windowSize(page);
    check(
      "the mini window shrinks to the compact size within 3 seconds",
      shrunk,
      {
        start,
        compact,
        native: (await ipcCount(page, "set_mini_player")) - beforeInvokes,
      },
    );
    await settleSwitch(enterMark);
    if (!entered) return;

    const titleShown = await waitFor(page, `${MINI_TITLE} === "Album Track A"`);
    check("the mini player shows the playing song", titleShown, {
      title: await page.evaluate(`return ${MINI_TITLE};`),
    });

    // Transport through the compact controls.
    const beforePause = await snapshot(page);
    await clickSelector(page, ".mini-player .mini-player-play");
    const pausedMini = await waitFor(page, `${MINI_PLAY_LABEL} === "Play"`);
    const afterPause = await snapshot(page);
    check(
      "mini Play/Pause pauses the fixture once",
      pausedMini &&
        since(beforePause, afterPause).filter((item) => item.type === "pause")
          .length === 1,
      { transitions: since(beforePause, afterPause) },
    );
    const beforeResume = await snapshot(page);
    await clickSelector(page, ".mini-player .mini-player-play");
    const resumedMini = await waitFor(page, `${MINI_PLAY_LABEL} === "Pause"`);
    const afterResume = await snapshot(page);
    check(
      "mini Play/Pause resumes the fixture once",
      resumedMini &&
        since(beforeResume, afterResume).filter((item) => item.type === "play")
          .length === 1,
      { transitions: since(beforeResume, afterResume) },
    );

    const beforeNext = await snapshot(page);
    await clickSelector(page, '.mini-player button[aria-label="Next track"]');
    const nextShown = await waitFor(page, `${MINI_TITLE} === "Album Track B"`);
    const afterNext = await snapshot(page);
    check(
      "mini Next advances to the next queue item",
      nextShown &&
        since(beforeNext, afterNext).some(
          (item) => item.type === "next" && item.index === 1,
        ),
      { transitions: since(beforeNext, afterNext) },
    );
    const beforePrevious = await snapshot(page);
    await clickSelector(
      page,
      '.mini-player button[aria-label="Previous track"]',
    );
    const previousShown = await waitFor(
      page,
      `${MINI_TITLE} === "Album Track A"`,
    );
    const afterPrevious = await snapshot(page);
    check(
      "mini Previous returns to the previous queue item",
      previousShown &&
        since(beforePrevious, afterPrevious).some(
          (item) => item.type === "previous" && item.index === 0,
        ),
      { transitions: since(beforePrevious, afterPrevious) },
    );

    // Keep on top: aria-pressed flips and the native command is sent.
    const pinStart = await page.evaluate(`return ${MINI_PIN_PRESSED};`);
    const pinBefore = await ipcCount(page, "set_mini_player_on_top");
    await clickSelector(page, ".mini-player [data-mini-pin]");
    const unpinned = await waitFor(page, `${MINI_PIN_PRESSED} === "false"`);
    const pinSent = await waitFor(
      page,
      `(window.__ARLET_E2E_TAURI_EVENTS__?.count("set_mini_player_on_top") ?? 0) > ${pinBefore}`,
    );
    await sleep(200);
    const pinInvokes =
      (await ipcCount(page, "set_mini_player_on_top")) - pinBefore;
    check(
      "keep-on-top starts pressed and toggles off with a native call",
      pinStart === "true" && unpinned && pinSent && pinInvokes === 1,
      {
        pinStart,
        pinInvokes,
        recorder: await page.evaluate(
          `return Boolean(window.__ARLET_E2E_TAURI_EVENTS__);`,
        ),
      },
    );
    await clickSelector(page, ".mini-player [data-mini-pin]");
    await waitFor(page, `${MINI_PIN_PRESSED} === "true"`);

    // Expand button returns to the normal shell at the starting size.
    const expandMark = await snapshot(page);
    await clickSelector(page, "[data-mini-expand]");
    const expanded = await waitFor(page, `Boolean(${SHELL}) && !${MINI}`);
    const expandedSize = await waitForSizeNear(page, start);
    const restored = await windowSize(page);
    await settleSwitch(expandMark);
    check(
      "the expand button returns to the normal shell and starting size",
      expanded && expandedSize,
      { start, restored },
    );

    // Ctrl+Shift+M enters, Escape exits.
    const keyEnterMark = await snapshot(page);
    await press(page, KEY.m, CTRL_SHIFT);
    const enteredByKey = await waitFor(page, `Boolean(${MINI}) && !${SHELL}`);
    await settleSwitch(keyEnterMark);
    const escapeMark = await snapshot(page);
    await press(page, KEY.escape);
    const exitedByEscape = await waitFor(page, `Boolean(${SHELL}) && !${MINI}`);
    await settleSwitch(escapeMark);
    check(
      "Ctrl+Shift+M enters the mini player and Escape exits it",
      enteredByKey && exitedByEscape,
    );

    // Ctrl+Shift+M twice returns to the normal shell.
    const reEnterMark = await snapshot(page);
    await press(page, KEY.m, CTRL_SHIFT);
    const reEntered = await waitFor(page, `Boolean(${MINI})`);
    await settleSwitch(reEnterMark);
    const reExitMark = await snapshot(page);
    await press(page, KEY.m, CTRL_SHIFT);
    const reExited = await waitFor(page, `Boolean(${SHELL}) && !${MINI}`);
    const toggledBack = await waitForSizeNear(page, start);
    await settleSwitch(reExitMark);
    check(
      "Ctrl+Shift+M twice returns to the normal shell and starting size",
      reEntered && reExited && toggledBack,
      { start, final: await windowSize(page) },
    );

    // Entering from full screen leaves it; leaving the mini player returns to it.
    await press(page, KEY.f11);
    const fullBefore = await waitFor(page, FULLSCREEN, 4000);
    const fullEnterMark = await snapshot(page);
    await press(page, KEY.m, CTRL_SHIFT);
    const fullMini = await waitFor(
      page,
      `Boolean(${MINI}) && !(${FULLSCREEN}) && window.innerWidth <= 400`,
      RESIZE_TIMEOUT_MS,
    );
    await settleSwitch(fullEnterMark);
    const fullExitMark = await snapshot(page);
    await press(page, KEY.m, CTRL_SHIFT);
    const fullAgain = await waitFor(
      page,
      `Boolean(${SHELL}) && !${MINI} && ${FULLSCREEN}`,
      4000,
    );
    await settleSwitch(fullExitMark);
    await press(page, KEY.f11);
    const fullLeft = await waitFor(page, `!(${FULLSCREEN})`, 4000);
    const fullRestored = fullLeft && (await waitForSizeNear(page, start));
    check(
      "from full screen, the mini player leaves full screen and returns to it",
      fullBefore && fullMini && fullAgain && fullRestored,
      {
        fullBefore,
        fullMini,
        fullAgain,
        fullRestored,
        final: await windowSize(page),
      },
    );

    check(
      "switching layouts never pauses playback",
      switchTransitions.every((item) => item.type !== "pause") &&
        (await page.evaluate(`return ${PLAYING};`)),
      { transitions: switchTransitions },
    );
  } finally {
    await leaveMiniIfActive(page);
    if (await page.evaluate(`return ${FULLSCREEN};`)) {
      await press(page, KEY.f11);
      await waitFor(page, `!(${FULLSCREEN})`, 4000);
    }
    // Leave playback paused and the window normal, as the other scenarios do.
    if (await page.evaluate(`return ${PLAYING};`)) {
      await clickSelector(page, ".play-button");
      await waitFor(page, PAUSED);
    }
    await fixtureCall(page, "reset");
    await page.evaluate(`location.hash = "#/home"; return true;`);
  }

  const endedNormal = await page.evaluate(
    `return Boolean(${SHELL}) && !${MINI} && ${PAUSED};`,
  );
  check("mini player scenario ends in the normal shell, paused", endedNormal);
}
