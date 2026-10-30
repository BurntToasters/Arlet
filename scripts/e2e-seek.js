#!/usr/bin/env node

/* Failure modes live in docs/TESTING.md ("Seeking"). The player-bar slider is
 * driven with CDP mouse input so Chromium's own range handling decides when
 * `change` fires; the fixture's emitPlaybackTime stands in for MusicKit ticks. */

import { fixtureCall, sleep, waitFor as pollFor } from "./e2e-helpers.js";

const ALBUM_ID = "album-1";
const SLIDER = `.player-bar input[aria-label="Playback position"]`;
const TITLE = `document.querySelector(".player-bar .player-track-copy strong")?.textContent`;
const PLAY_LABEL = `document.querySelector(".play-button")?.getAttribute("aria-label")`;
const VALUE = `document.querySelector(${JSON.stringify(SLIDER)})?.value`;

const waitFor = (page, expression, timeoutMs = 5_000) =>
  pollFor(page, expression, timeoutMs, 50);

function formatTime(seconds) {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

async function snapshot(page) {
  return page.evaluate("return window.__ARLET_E2E_MUSIC__.snapshot();");
}

function seeksSince(before, after) {
  return after.transitions
    .slice(before.transitions.length)
    .filter((item) => item.type === "seekToTime")
    .map((item) => item.seconds);
}

async function slider(page) {
  return page.evaluate(`
    const input = document.querySelector(${JSON.stringify(SLIDER)});
    return {
      value: Number(input?.value),
      label: input?.closest(".player-progress")?.querySelector("span")?.textContent ?? null,
    };`);
}

/** Viewport point at `fraction` of the slider track. */
async function pointAt(page, fraction) {
  return page.evaluate(`
    const rect = document.querySelector(${JSON.stringify(SLIDER)}).getBoundingClientRect();
    const inset = 8;
    return {
      x: rect.left + inset + ${fraction} * (rect.width - inset * 2),
      y: rect.top + rect.height / 2,
    };`);
}

async function mouse(page, type, point) {
  await page.send("Input.dispatchMouseEvent", {
    type,
    x: point.x,
    y: point.y,
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: 1,
  });
}

/** Clicks the slider; returns the value the press put on it. */
async function clickAt(page, fraction) {
  const point = await pointAt(page, fraction);
  await mouse(page, "mousePressed", point);
  const pressed = await slider(page);
  await mouse(page, "mouseReleased", point);
  return pressed.value;
}

async function tick(page, seconds) {
  await fixtureCall(page, "emitPlaybackTime", [seconds, 180]);
}

async function seekedTo(page, before, seconds) {
  return waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().transitions.slice(${before.transitions.length}).some((item) => item.type === "seekToTime" && item.seconds === ${seconds})`,
  );
}

/** Clicks, drags, and seeks against playback ticks and slow seeks. */
export async function runSeek({ page, check }) {
  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.reset();
    location.hash = "#/album/${ALBUM_ID}";
    return true;
  `);
  const albumReady = await waitFor(
    page,
    `document.querySelectorAll(".library-track-row").length >= 2 && [...document.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Play all")`,
    10_000,
  );
  await page.evaluate(`
    [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Play all")?.click();
    return true;
  `);
  const started = await waitFor(
    page,
    `${TITLE} === "Album Track A" && ${PLAY_LABEL} === "Pause"`,
    10_000,
  );
  await page.evaluate(`document.activeElement?.blur(); return true;`);
  await tick(page, 120);
  const ready =
    albumReady &&
    started &&
    (await waitFor(page, `${VALUE} === "120"`)) &&
    (await waitFor(
      page,
      `document.querySelector(${JSON.stringify(SLIDER)}) && !document.querySelector(${JSON.stringify(SLIDER)}).disabled`,
    ));
  check("seek scenario plays an album at 2:00 of 3:00", ready);
  if (!ready) return;

  try {
    // 1. A tick between press and release, on a click behind the playhead.
    let before = await snapshot(page);
    const back = await pointAt(page, 0.25);
    await mouse(page, "mousePressed", back);
    const pressed = await slider(page);
    await tick(page, 121);
    const duringPress = await slider(page);
    await mouse(page, "mouseReleased", back);
    const backSeeked = await seekedTo(page, before, pressed.value);
    check(
      "a click behind the playhead seeks there even when a tick lands mid-press",
      pressed.value < 100 && backSeeked,
      { pressed, seeks: seeksSince(before, await snapshot(page)) },
    );
    check(
      "a tick mid-press leaves the thumb and time label at the pointer",
      duringPress.value === pressed.value &&
        duringPress.label === formatTime(pressed.value),
      { pressed, duringPress },
    );
    await waitFor(page, `${VALUE} === "${pressed.value}"`);

    // 2. A drag with ticks between pointer moves.
    await tick(page, pressed.value + 1);
    before = await snapshot(page);
    const samples = [];
    await mouse(page, "mousePressed", await pointAt(page, 0.2));
    for (const [index, fraction] of [0.35, 0.5, 0.65].entries()) {
      await mouse(page, "mouseMoved", await pointAt(page, fraction));
      const moved = await slider(page);
      await tick(page, pressed.value + 2 + index);
      samples.push({ moved, afterTick: await slider(page) });
    }
    const dragEnd = samples.at(-1).moved.value;
    await mouse(page, "mouseReleased", await pointAt(page, 0.65));
    const dragSeeked = await seekedTo(page, before, dragEnd);
    await sleep(300);
    const dragSeeks = seeksSince(before, await snapshot(page));
    check(
      "a drag follows the pointer through playback ticks",
      samples.every(
        ({ moved, afterTick }) =>
          afterTick.value === moved.value &&
          afterTick.label === formatTime(moved.value),
      ) && new Set(samples.map(({ moved }) => moved.value)).size === 3,
      { samples },
    );
    check(
      "a drag seeks once, to where it was released",
      dragSeeked && JSON.stringify(dragSeeks) === JSON.stringify([dragEnd]),
      { dragEnd, dragSeeks },
    );

    // 3. Stale ticks while seekToTime is in flight.
    await fixtureCall(page, "configure", [{ holdSeek: true }]);
    await tick(page, dragEnd + 1);
    await waitFor(page, `${VALUE} === "${dragEnd + 1}"`);
    before = await snapshot(page);
    const target = await clickAt(page, 0.85);
    const held = await waitFor(
      page,
      `window.__ARLET_E2E_MUSIC__.snapshot().seekHeld === 1`,
    );
    await tick(page, dragEnd + 2);
    await tick(page, dragEnd + 3);
    const whileHeld = await slider(page);
    check(
      "stale ticks during an in-flight seek do not snap the thumb back",
      held &&
        whileHeld.value === target &&
        whileHeld.label === formatTime(target),
      { target, whileHeld, seeks: seeksSince(before, await snapshot(page)) },
    );
    await fixtureCall(page, "releaseSeek");
    await tick(page, target + 1);
    check(
      "once the seek lands, ticks move the thumb again",
      await waitFor(page, `${VALUE} === "${target + 1}"`),
      { target, after: await slider(page) },
    );

    // 4. Two seeks in flight; the older one finishes first.
    before = await snapshot(page);
    const older = await clickAt(page, 0.3);
    const newer = await clickAt(page, 0.6);
    const bothHeld = await waitFor(
      page,
      `window.__ARLET_E2E_MUSIC__.snapshot().seekHeld === 2`,
    );
    await fixtureCall(page, "releaseSeek", [1]);
    await sleep(100);
    const afterOlder = await slider(page);
    await fixtureCall(page, "releaseSeek");
    await sleep(100);
    const afterNewer = await slider(page);
    check(
      "an older seek finishing late does not override a newer one",
      bothHeld &&
        older !== newer &&
        afterOlder.value === newer &&
        afterNewer.value === newer,
      {
        older,
        newer,
        afterOlder,
        afterNewer,
        seeks: seeksSince(before, await snapshot(page)),
      },
    );

    // 5. A seek that never confirms must not freeze the slider.
    await clickAt(page, 0.1);
    await waitFor(page, `window.__ARLET_E2E_MUSIC__.snapshot().seekHeld === 1`);
    await sleep(3_500);
    await tick(page, 77);
    check(
      "a seek that never confirms stops holding the slider",
      await waitFor(page, `${VALUE} === "77"`, 2_000),
      { after: await slider(page) },
    );
  } finally {
    await fixtureCall(page, "configure", [{ holdSeek: false }]);
    await fixtureCall(page, "releaseSeek");
  }
}
