#!/usr/bin/env node

/*
 * Shortcut overlay (Ctrl+/ and `?`). Failure modes guarded:
 *  - Ctrl+/ or `?` does nothing, or opens while the search field has focus.
 *  - Overlay rows differ from SHORTCUT_HELP / Settings (count or labels).
 *  - Groups missing or out of order; Escape or a backdrop click does not close.
 *  - Focus not moved in on open, Tab escapes the dialog, or focus not restored.
 *  - Space leaks through the open dialog to playback.
 *  - Playback dead after close (dialog state stuck), or the scenario ends dirty.
 * Keys go through CDP Input events so real keydown listeners and focus rules run.
 */

import { fixtureCall, sleep, waitFor as pollFor } from "./e2e-helpers.js";

const CTRL = 2;
const SHIFT = 8;

const KEY = {
  slash: { key: "/", code: "Slash", keyCode: 191, text: "/" },
  question: { key: "?", code: "Slash", keyCode: 191, text: "?" },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  k: { key: "k", code: "KeyK", keyCode: 75 },
};

// Key and label pairs, the same set SHORTCUT_HELP holds (shortcuts.ts).
const EXPECTED_SHORTCUTS = [
  ["Space", "Play or pause"],
  ["Ctrl+→", "Next song"],
  ["Ctrl+←", "Previous song"],
  ["Ctrl+↑", "Volume up"],
  ["Ctrl+↓", "Volume down"],
  ["Shift+→", "Skip forward 10 seconds"],
  ["Shift+←", "Skip back 10 seconds"],
  ["M", "Mute or unmute"],
  ["Esc", "Close Now Playing"],
  ["F11", "Toggle full screen"],
  ["Ctrl+K", "Search Apple Music"],
  ["Ctrl+R", "Refresh current data"],
  ["Alt+←", "Back"],
  ["Alt+→", "Forward"],
  ["Ctrl+/", "Show keyboard shortcuts"],
  ["Ctrl+Shift+M", "Mini player"],
  ["Ctrl+Click / Shift+Click", "Select songs"],
  ["Ctrl+A", "Select all songs in list"],
  ["Esc", "Clear selection"],
];
const GROUP_HEADINGS = ["Playback", "Navigation", "Window"];

const OVERLAY = `document.querySelector("section.shortcut-overlay[role='dialog'][aria-modal='true']")`;
const OVERLAY_OPEN = `Boolean(${OVERLAY})`;
const ACTIVE_INSIDE = `Boolean(${OVERLAY}?.contains(document.activeElement))`;
const PLAY_BUTTON_FOCUSED = `document.activeElement === document.querySelector(".play-button")`;
const OVERLAY_ROWS = `[...document.querySelectorAll(".shortcut-overlay .shortcut-overlay-row")].map((row) => [row.querySelector("dt kbd")?.textContent.trim() ?? null, row.querySelector("dd")?.textContent.trim() ?? null])`;
const OVERLAY_GROUPS = `[...document.querySelectorAll(".shortcut-overlay-group h3")].map((node) => node.textContent.trim())`;
const SETTINGS_ROWS = `[...document.querySelectorAll(".shortcut-list .shortcut-row")].map((row) => [row.querySelector("dt kbd")?.textContent.trim() ?? null, row.querySelector("dd")?.textContent.trim() ?? null])`;
const SEARCH_VALUE = `document.querySelector(".search-form input")?.value ?? null`;
const PLAYBACK_TYPES = ["play", "pause"];

const waitFor = (page, expression, timeoutMs = 3000) =>
  pollFor(page, expression, timeoutMs, 50);

const pairKey = (rows) => rows.map((row) => row.join("\t")).sort();

/** Sends one key through CDP. Ctrl suppresses text, as the browser does. */
async function press(page, key, modifiers = 0) {
  const base = {
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    modifiers,
  };
  const text = modifiers & CTRL ? undefined : key.text;
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...base,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(150);
}

/** Clicks the centre of an element; mousedown moves focus like a real click. */
async function clickCenterOf(page, element) {
  const point = await page.evaluate(`
    const node = ${element};
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  `);
  if (!point) return false;
  await clickAt(page, point.x, point.y);
  return true;
}

async function clickAt(page, x, y) {
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await sleep(150);
}

const snapshot = (page) =>
  fixtureCall(page, "snapshot").then((snap) => snap.transitions);

const playbackSince = (transitions, mark) =>
  transitions.slice(mark).filter((item) => PLAYBACK_TYPES.includes(item.type));

export async function runShortcuts({ page, check }) {
  await fixtureCall(page, "reset");
  await page.evaluate(`location.hash = "#/home"; return true;`);
  const shellReady = await waitFor(
    page,
    `document.querySelector(".player-bar")`,
    12_000,
  );
  await fixtureCall(page, "setCurrentTrack", ["song-a"]);
  const transportReady = await waitFor(
    page,
    `document.querySelector(".play-button")`,
  );
  check(
    "shortcut scenario has a ready transport",
    shellReady && transportReady,
    {
      shellReady,
      transportReady,
    },
  );
  if (!shellReady || !transportReady) return;

  // The play button is the control focus must return to.
  await page.evaluate(
    `document.querySelector(".play-button").focus(); return true;`,
  );

  // 1. Ctrl+/ opens the overlay and moves focus into it.
  await press(page, KEY.slash, CTRL);
  const slashOpened = await waitFor(page, OVERLAY_OPEN);
  const focusInside = await page.evaluate(`return ${ACTIVE_INSIDE};`);
  check(
    "Ctrl+/ opens the keyboard shortcut overlay with focus inside",
    slashOpened && focusInside,
    {
      slashOpened,
      focusInside,
    },
  );
  if (!slashOpened) return;

  // 2. Groups and rows match SHORTCUT_HELP (the same pairs Settings shows).
  const groups = await page.evaluate(`return ${OVERLAY_GROUPS};`);
  check(
    "overlay groups entries under Playback, Navigation and Window",
    JSON.stringify(groups) === JSON.stringify(GROUP_HEADINGS),
    { groups },
  );
  const overlayRows = await page.evaluate(`return ${OVERLAY_ROWS};`);
  check(
    "overlay lists every keyboard shortcut, including Ctrl+/",
    JSON.stringify(pairKey(overlayRows)) ===
      JSON.stringify(pairKey(EXPECTED_SHORTCUTS)),
    {
      count: overlayRows.length,
      expected: EXPECTED_SHORTCUTS.length,
      overlayRows,
    },
  );

  // 3. Tab and Shift+Tab stay inside the dialog.
  for (let i = 0; i < 3; i += 1) await press(page, KEY.tab);
  const trappedForward = await page.evaluate(`return ${ACTIVE_INSIDE};`);
  await press(page, KEY.tab, SHIFT);
  const trappedBack = await page.evaluate(`return ${ACTIVE_INSIDE};`);
  check(
    "Tab and Shift+Tab stay inside the overlay",
    trappedForward && trappedBack,
    {
      trappedForward,
      trappedBack,
    },
  );

  // 4. A click on dialog text keeps focus in the dialog, so Space cannot
  //    reach the transport while the overlay is open.
  const clicked = await clickCenterOf(
    page,
    `document.querySelector(".shortcut-overlay-note")`,
  );
  const focusOnSection = await page.evaluate(
    `return document.activeElement === ${OVERLAY};`,
  );
  const beforeSpace = await snapshot(page);
  await press(page, KEY.space);
  const stillOpenAfterSpace = await page.evaluate(`return ${OVERLAY_OPEN};`);
  const afterSpace = await snapshot(page);
  check(
    "Space inside the open overlay does not toggle playback",
    clicked &&
      focusOnSection &&
      stillOpenAfterSpace &&
      playbackSince(afterSpace, beforeSpace.length).length === 0,
    { clicked, focusOnSection, stillOpenAfterSpace },
  );

  // 5. Escape closes the overlay and returns focus to the play button.
  await press(page, KEY.escape);
  const escapeClosed = await waitFor(page, `!${OVERLAY_OPEN}`);
  const escapeRestored = await page.evaluate(`return ${PLAY_BUTTON_FOCUSED};`);
  check(
    "Escape closes the overlay and restores focus to the previous control",
    escapeClosed && escapeRestored,
    { escapeClosed, escapeRestored },
  );

  // 6. `?` opens it; a click on the backdrop closes it and restores focus.
  await press(page, KEY.question, SHIFT);
  const questionOpened = await waitFor(page, OVERLAY_OPEN);
  check("? opens the keyboard shortcut overlay", questionOpened, {
    questionOpened,
  });
  const cornerOutside = await page.evaluate(`
    const rect = ${OVERLAY}?.getBoundingClientRect();
    return Boolean(rect) && rect.left > 4 && rect.top > 4;
  `);
  await clickAt(page, 4, 4);
  const backdropClosed = await waitFor(page, `!${OVERLAY_OPEN}`);
  const backdropRestored = await page.evaluate(
    `return ${PLAY_BUTTON_FOCUSED};`,
  );
  check(
    "a click on the backdrop closes the overlay and restores focus",
    cornerOutside && backdropClosed && backdropRestored,
    { cornerOutside, backdropClosed, backdropRestored },
  );

  // 7. Neither key opens it while the search field has focus.
  await page.evaluate(`document.activeElement?.blur(); return true;`);
  await press(page, KEY.k, CTRL);
  const searchFocused = await waitFor(
    page,
    `document.activeElement === document.querySelector(".search-form input")`,
  );
  await press(page, KEY.question, SHIFT);
  const typedValue = await page.evaluate(`return ${SEARCH_VALUE};`);
  const questionInSearch = await page.evaluate(`return ${OVERLAY_OPEN};`);
  await press(page, KEY.slash, CTRL);
  const slashInSearch = await page.evaluate(`return ${OVERLAY_OPEN};`);
  check(
    "? and Ctrl+/ do not open the overlay while the search field has focus",
    searchFocused && typedValue === "?" && !questionInSearch && !slashInSearch,
    { searchFocused, typedValue, questionInSearch, slashInSearch },
  );

  // 8. Settings lists the same shortcuts the overlay shows.
  await page.evaluate(`location.hash = "#/settings"; return true;`);
  const settingsReady = await waitFor(
    page,
    `document.querySelector(".shortcut-list")`,
    8000,
  );
  const settingsRows = settingsReady
    ? await page.evaluate(`return ${SETTINGS_ROWS};`)
    : [];
  await page.evaluate(`document.activeElement?.blur(); return true;`);
  await press(page, KEY.slash, CTRL);
  const settingsOverlay = await waitFor(page, OVERLAY_OPEN);
  const fromSettings = settingsOverlay
    ? await page.evaluate(`return ${OVERLAY_ROWS};`)
    : [];
  await press(page, KEY.escape);
  await waitFor(page, `!${OVERLAY_OPEN}`);
  check(
    "overlay rows match the Settings shortcut list",
    settingsReady &&
      settingsOverlay &&
      fromSettings.length === EXPECTED_SHORTCUTS.length &&
      JSON.stringify(pairKey(fromSettings)) ===
        JSON.stringify(pairKey(settingsRows)),
    {
      settingsReady,
      count: fromSettings.length,
      settingsCount: settingsRows.length,
    },
  );

  // 9. Playback works again once the overlay is closed.
  await page.evaluate(`location.hash = "#/home"; return true;`);
  await waitFor(page, `document.querySelector(".play-button")`);
  await page.evaluate(`document.activeElement?.blur(); return true;`);
  const beforeToggle = await snapshot(page);
  await press(page, KEY.space);
  const toggled = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().transitions.slice(${beforeToggle.length}).some((item) => ${JSON.stringify(PLAYBACK_TYPES)}.includes(item.type))`,
    4000,
  );
  check("Space toggles playback after the overlay closes", toggled, {
    toggled,
  });

  // 10. Leave with the overlay closed and focus on the page body.
  const cleanState = await page.evaluate(`
    if (${OVERLAY_OPEN}) return false;
    document.activeElement?.blur();
    return document.activeElement === document.body;
  `);
  check(
    "shortcut scenario ends with the overlay closed and focus on body",
    cleanState,
    {
      cleanState,
    },
  );
}
