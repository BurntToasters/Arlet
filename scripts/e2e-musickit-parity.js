#!/usr/bin/env node

/* MusicKit parity checks against the injected fixture. Failure modes and the
 * check names live in docs/TESTING.md ("MusicKit parity"); this module holds
 * the Repeat and Shuffle model groups. Expectations read the page's own
 * `window.MusicKit.PlayerRepeatMode` enum (none 0, one 1, all 2) as well as
 * the fixture's recorded modes, so a drifted enum shows up as a failed check.
 * The groups drive the real Repeat, Shuffle, Next, Previous, and Playing Next
 * controls, plus the Selection and stations group (Playing Next selection,
 * station mode buttons, and Play Next during a station) and the Autoplay
 * group (autoplay songs in Playing Next, Play Later order, Clear, Repeat, the
 * autoplay toggle, the saved paths, the playlist refill, and a refused
 * station). The run ends with repeat off, shuffle off, a fixture reset, and no
 * menu open. */

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureCall, sleep, waitFor } from "./e2e-helpers.js";

const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const PLAYLIST_ID = "playlist-1";
const PLAYLIST_FIRST_TITLE = "Track A";
const PLAYLIST_SIZE = 6;
const REPEAT_SELECTOR = '.player-bar button[aria-label^="Repeat "]';
const NEXT_SELECTOR = 'button[aria-label="Next track"]';
const PREVIOUS_SELECTOR = 'button[aria-label="Previous track"]';
const PLAYING_NEXT_SELECTOR = 'button[aria-label="Toggle Playing Next"]';
const TITLE = `(document.querySelector(".player-bar .player-track-copy strong")?.textContent ?? null)`;
const PLAY_LABEL = `(document.querySelector(".play-button")?.getAttribute("aria-label") ?? null)`;
const REPEAT_LABEL = `(document.querySelector(${JSON.stringify(REPEAT_SELECTOR)})?.getAttribute("aria-label") ?? null)`;
const SHUFFLE_SELECTOR = 'button[aria-label="Toggle shuffle"]';
const SHUFFLE_PRESSED = `(document.querySelector(${JSON.stringify(SHUFFLE_SELECTOR)})?.getAttribute("aria-pressed") ?? null)`;
const PLAY_BUTTON_SELECTOR = ".play-button";
const DRAWER_ROWS = ".queue-drawer .queue-list > li:not([aria-hidden])";
// Shuffle model: the playlist row picked for the Play check, and the album a
// parked queue plays from (the same album scripts/e2e-audit-fixes.js parks).
const CHOSEN_INDEX = 2;
const CHOSEN_TITLE = "Track C";
const CHOSEN_ID = "song-c";
const ALBUM_ID = "album-1";
const ALBUM_TITLE = "Fixture Album";
const ALBUM_QUEUE = ["album-a", "album-b", "album-c", "album-d"];
const ALBUM_START = 1;
// Must match the 1-min stream handoff delay in src/app/stream-release.ts.
const RELEASE_DELAY_MS = 60_000;
const RELEASE_FAST_MS = 400;

// Check names copied verbatim from docs/TESTING.md ("MusicKit parity", Repeat).
const REPEAT_CHECKS = {
  writes: "Repeat All writes MusicKit repeat mode 2 and Repeat One writes 1",
  replays: "with Repeat One, a song that ends plays again",
  next: "with Repeat One, Next plays the next song and keeps Repeat One",
  previous:
    "with Repeat One, Previous in the first 3 seconds plays the previous song",
  wraps: "with Repeat All, the last song ends into the first song",
};

// Check names copied verbatim from docs/TESTING.md ("MusicKit parity", Shuffle model).
const SHUFFLE_CHECKS = {
  onKeepsSong: "shuffle on puts the playing song first and keeps playing it",
  playStarts:
    "a Play with shuffle on starts the chosen song even though MusicKit reshuffles the queue",
  parkedResume:
    "a parked queue resumed with shuffle on keeps its saved order and still shows shuffle on",
  offKeeps: "turning shuffle off after a kept-order resume does not reshuffle",
  rebuildKeeps: "a queue rebuild with shuffle on keeps the edited order",
  selectionKeeps:
    "choosing a Playing Next song while the shuffled order is held plays that song and keeps the order",
};

// Check names copied verbatim from docs/TESTING.md ("MusicKit parity", Selection and stations).
const SELECTION_CHECKS = {
  selection:
    "choosing a song in Playing Next never clears the player or the Windows media controls",
  modes: "during a station, shuffle and repeat are hidden",
  playNext:
    "Play Next during a station explains it is unavailable instead of showing MusicKit's error",
};
const STATION_TOAST =
  "Play Next and Play Later aren't available while a station is playing.";
// Radio's Pop genre station (ra.genre-pop-1). radio-artist only starts
// ra.song-one and ra.artist-two, so its song-to-station cache is untouched.
const RADIO_GENRE_CHIP = "Pop";
const RADIO_STATION_CARD = "Pop Station One";
// A plain playlist song whose track menu has Play Next, and no station lookup.
const PLAY_NEXT_CONTEXT_ID = "song-c";
const PLAYER_SHUFFLE_SELECTOR =
  '.player-bar button[aria-label="Toggle shuffle"]';

const q = (value) => JSON.stringify(value);
const readPage = (page, expression) => page.evaluate(`return ${expression};`);
const snapshot = (page) => fixtureCall(page, "snapshot");
const transitionCount = async (page) =>
  (await snapshot(page)).transitions.length;
const transitionsSince = async (page, at) =>
  (await snapshot(page)).transitions.slice(at);
const clickSelector = (page, selector) =>
  page.evaluate(
    `document.querySelector(${q(selector)})?.click(); return true;`,
  );

/** Runs one group; a throw becomes one failed check instead of a lost run. */
async function group(check, name, body) {
  try {
    await body();
  } catch (error) {
    check(`${name} completes`, false, String(error?.message ?? error));
  }
}

/** The player bar's current song as the page and the fixture each report it. */
async function nowPlaying(page) {
  const trace = await snapshot(page);
  return {
    index: trace.queue.index,
    activeId: trace.queue.activeId,
    title: await readPage(page, TITLE),
    queueTitle: trace.queue.items[trace.queue.index]?.title ?? null,
    playing: (await readPage(page, PLAY_LABEL)) === "Pause",
    repeat: trace.modes.repeat,
  };
}

/** Opens the fixture playlist from its detail page and plays its first row. */
async function startPlaylist(page) {
  await page.evaluate(
    `location.hash = ${q(`#/playlist/${PLAYLIST_ID}`)}; return true;`,
  );
  const rowsReady = await waitFor(
    page,
    `document.querySelectorAll(".library-track-row").length >= 4`,
  );
  if (!rowsReady) return false;
  await page.evaluate(
    `document.querySelector(".library-track-row")?.click(); return true;`,
  );
  return waitFor(
    page,
    `${FIXTURE}.snapshot().queue.items.length === ${PLAYLIST_SIZE} && ${TITLE} === ${q(PLAYLIST_FIRST_TITLE)} && ${PLAY_LABEL} === "Pause"`,
  );
}

/** Presses the Repeat button once and waits for its label to change. */
async function stepRepeat(page) {
  const before = await readPage(page, REPEAT_LABEL);
  await clickSelector(page, REPEAT_SELECTOR);
  await waitFor(page, `${REPEAT_LABEL} !== ${q(before)}`);
  return readPage(page, REPEAT_LABEL);
}

/** Presses Repeat until its label reads `label`; Repeat cycles in three steps. */
async function cycleRepeatTo(page, label) {
  for (let step = 0; step < 3; step += 1) {
    if ((await readPage(page, REPEAT_LABEL)) === label) return true;
    await stepRepeat(page);
  }
  return (await readPage(page, REPEAT_LABEL)) === label;
}

async function checkRepeatWrites(page, check, modesEnum) {
  await cycleRepeatTo(page, "Repeat off");
  const steps = [
    ["Repeat all", modesEnum.all],
    ["Repeat one", modesEnum.one],
    ["Repeat off", modesEnum.none],
  ];
  const labels = [];
  const modes = [];
  for (const [, value] of steps) {
    labels.push(await stepRepeat(page));
    await waitFor(page, `${FIXTURE}.snapshot().modes.repeat === ${value}`);
    modes.push((await snapshot(page)).modes.repeat);
  }
  const expectedLabels = steps.map(([label]) => label);
  const expectedModes = steps.map(([, value]) => value);
  check(
    REPEAT_CHECKS.writes,
    modesEnum.all === 2 &&
      modesEnum.one === 1 &&
      modesEnum.none === 0 &&
      JSON.stringify(labels) === JSON.stringify(expectedLabels) &&
      JSON.stringify(modes) === JSON.stringify(expectedModes),
    { enum: modesEnum, labels, modes },
  );
}

async function checkRepeatOneReplays(page, check, modesEnum) {
  await cycleRepeatTo(page, "Repeat one");
  const before = await nowPlaying(page);
  const at = await transitionCount(page);
  await fixtureCall(page, "finishCurrentTrack");
  const replayed = await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.slice(${at}).some((item) => item.type === "finishRepeatOne")`,
  );
  const after = await nowPlaying(page);
  check(
    REPEAT_CHECKS.replays,
    replayed &&
      after.index === before.index &&
      after.activeId === before.activeId &&
      after.title === before.title &&
      after.playing &&
      after.repeat === modesEnum.one,
    {
      before,
      after,
      transitions: await transitionsSince(page, at),
    },
  );
}

async function checkRepeatOneNext(page, check, modesEnum) {
  await cycleRepeatTo(page, "Repeat one");
  const before = await nowPlaying(page);
  const at = await transitionCount(page);
  const expectedIndex = before.index + 1;
  await clickSelector(page, NEXT_SELECTOR);
  const advanced = await waitFor(
    page,
    `${FIXTURE}.snapshot().queue.index === ${expectedIndex}`,
  );
  const after = await nowPlaying(page);
  check(
    REPEAT_CHECKS.next,
    advanced &&
      after.index === expectedIndex &&
      after.title === after.queueTitle &&
      after.repeat === modesEnum.one,
    {
      before,
      after,
      transitions: await transitionsSince(page, at),
    },
  );
}

async function checkRepeatOnePrevious(page, check, modesEnum) {
  await cycleRepeatTo(page, "Repeat one");
  // Position 0 sits inside Previous's first-3-seconds window.
  await fixtureCall(page, "emitPlaybackTime", [0]);
  const before = await nowPlaying(page);
  const at = await transitionCount(page);
  const expectedIndex = before.index - 1;
  await clickSelector(page, PREVIOUS_SELECTOR);
  const stepped = await waitFor(
    page,
    `${FIXTURE}.snapshot().queue.index === ${expectedIndex}`,
  );
  const after = await nowPlaying(page);
  check(
    REPEAT_CHECKS.previous,
    before.index >= 1 &&
      stepped &&
      after.index === expectedIndex &&
      after.title === after.queueTitle &&
      after.repeat === modesEnum.one,
    {
      position: 0,
      before,
      after,
      transitions: await transitionsSince(page, at),
    },
  );
}

async function checkRepeatAllWraps(page, check, modesEnum) {
  await cycleRepeatTo(page, "Repeat all");
  // Choose the last song from the Playing Next drawer, as a listener would.
  await clickSelector(page, PLAYING_NEXT_SELECTOR);
  const drawerReady = await waitFor(
    page,
    `document.querySelectorAll(".queue-drawer .queue-list li").length >= ${PLAYLIST_SIZE}`,
  );
  await page.evaluate(
    `document.querySelector(".queue-drawer .queue-list li:nth-child(${PLAYLIST_SIZE}) .queue-row")?.click(); return true;`,
  );
  const lastSelected = await waitFor(page, `${TITLE} === "Track F"`);
  await clickSelector(page, PLAYING_NEXT_SELECTOR);
  const before = await nowPlaying(page);
  const at = await transitionCount(page);
  await fixtureCall(page, "finishCurrentTrack");
  const finished = await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.slice(${at}).some((item) => ["finishWrap", "finishNext", "finishEnd"].includes(item.type))`,
  );
  const after = await nowPlaying(page);
  const transitions = await transitionsSince(page, at);
  check(
    REPEAT_CHECKS.wraps,
    drawerReady &&
      lastSelected &&
      before.index === PLAYLIST_SIZE - 1 &&
      finished &&
      transitions.some((item) => item.type === "finishWrap") &&
      after.index === 0 &&
      after.activeId === "song-a" &&
      after.repeat === modesEnum.all,
    { before, after, transitions },
  );
}

/** Runs one check; a throw becomes that check's failure instead of a lost group. */
async function guarded(check, name, body) {
  try {
    await body();
  } catch (error) {
    check(name, false, String(error?.message ?? error));
  }
}

const sameList = (actual, expected) =>
  JSON.stringify(actual ?? []) === JSON.stringify(expected);
const idsOf = (trace) => trace.queue.items.map((item) => item.id);
const titlesOf = (trace) => trace.queue.items.map((item) => item.title);
const shufflePressed = (page) => readPage(page, SHUFFLE_PRESSED);
const typeSince = (page, from, type, timeoutMs = 8000) =>
  waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.slice(${from}).some((item) => item.type === ${q(type)})`,
    timeoutMs,
  );

/** Presses Shuffle only when the button disagrees, then waits for button and MusicKit. */
async function setShuffleTo(page, on) {
  const want = on ? "true" : "false";
  if ((await shufflePressed(page)) !== want) {
    await clickSelector(page, SHUFFLE_SELECTOR);
  }
  const pressed = await waitFor(page, `${SHUFFLE_PRESSED} === ${q(want)}`);
  const provider = await waitFor(
    page,
    `${FIXTURE}.snapshot().modes.shuffle === ${on}`,
  );
  return pressed && provider;
}

/** Plays the playlist row at `index`; true once MusicKit has queued and is playing. */
async function openPlaylistRow(page, index) {
  await page.evaluate(
    `location.hash = ${q(`#/playlist/${PLAYLIST_ID}`)}; return true;`,
  );
  const rowsReady = await waitFor(
    page,
    `document.querySelectorAll(".library-track-row").length >= 4`,
  );
  if (!rowsReady) return false;
  const at = await transitionCount(page);
  await page.evaluate(
    `document.querySelectorAll(".library-track-row")[${index}]?.click(); return true;`,
  );
  const queued = await typeSince(page, at, "setQueue");
  const playing = await waitFor(page, `${PLAY_LABEL} === "Pause"`);
  return queued && playing;
}

async function openAlbum(page) {
  await page.evaluate(
    `location.hash = ${q(`#/album/${ALBUM_ID}`)}; return true;`,
  );
  return waitFor(
    page,
    `document.querySelectorAll(".library-track-row").length >= ${ALBUM_QUEUE.length} && document.querySelector(".library-detail-hero h1")?.textContent === ${q(ALBUM_TITLE)}`,
    15_000,
  );
}

/** Points the 1-minute stream release timer at the shortened delay; restoreTimers undoes it. */
function installFastRelease(page) {
  return page.evaluate(`
    window.__ARLET_E2E_NATIVE_SET_TIMEOUT__ ??= window.setTimeout;
    const native = window.__ARLET_E2E_NATIVE_SET_TIMEOUT__;
    window.__ARLET_PARITY_TIMER_MAP__ = { ${RELEASE_DELAY_MS}: ${RELEASE_FAST_MS} };
    window.setTimeout = (callback, delay, ...rest) =>
      native(callback, window.__ARLET_PARITY_TIMER_MAP__[delay] ?? delay, ...rest);
    return true;`);
}

function restoreTimers(page) {
  return page.evaluate(`
    if (window.__ARLET_E2E_NATIVE_SET_TIMEOUT__) {
      window.setTimeout = window.__ARLET_E2E_NATIVE_SET_TIMEOUT__;
    }
    delete window.__ARLET_PARITY_TIMER_MAP__;
    return true;`);
}

/** Parks the playing queue through a stream handoff, as parkedQueueOrder does. */
async function parkThroughHandoff(page) {
  const at = await transitionCount(page);
  await installFastRelease(page);
  try {
    await clickSelector(page, PLAY_BUTTON_SELECTOR);
    await waitFor(page, `${PLAY_LABEL} === "Play"`);
    // The release timer is armed on the state change; it keeps its shortened delay.
    await sleep(150);
  } finally {
    await restoreTimers(page);
  }
  const stopped = await typeSince(page, at, "stop");
  await sleep(300);
  return stopped;
}

/**
 * Opens Playing Next and waits until it is fully open with `rows` song rows.
 * A drawer still sliding out stays mounted for SLIDE_MS, so the toggle is
 * pressed only after it unmounts; pressing it then would close nothing.
 */
async function openDrawer(page, rows = PLAYLIST_SIZE) {
  await page.evaluate(`
    if (!document.querySelector(".queue-drawer")) {
      document.querySelector(${q(PLAYING_NEXT_SELECTOR)})?.click();
    }
    return true;`);
  return waitFor(
    page,
    `document.querySelectorAll(${q(DRAWER_ROWS)}).length === ${rows}`,
  );
}

/**
 * Waits until Playing Next is fully open with `rows` song rows. A drawer still
 * sliding out (data-state closing) stays mounted for SLIDE_MS, so it is waited
 * out first: an open call would otherwise see it and press nothing.
 */
async function openDrawerIdle(page, rows) {
  const settled = await waitFor(
    page,
    `document.querySelector(".queue-drawer")?.getAttribute("data-state") !== "closing"`,
  );
  if (!settled) return false;
  const ready = await openDrawer(page, rows);
  return (
    ready &&
    waitFor(
      page,
      `document.querySelector(".queue-drawer")?.getAttribute("data-state") === "open"`,
    )
  );
}

/** The drawer's mount and phase, and its visible rows, for failure details. */
const drawerState = (page) =>
  readPage(
    page,
    `(() => {
      const drawer = document.querySelector(".queue-drawer");
      const rows = [...document.querySelectorAll(${q(DRAWER_ROWS)})];
      return {
        mounted: Boolean(drawer),
        phase: drawer?.getAttribute("data-state") ?? null,
        rows: rows.length,
        titles: rows.map((row) => row.querySelector(".queue-copy strong")?.textContent ?? null),
      };
    })()`,
  );

async function closeDrawer(page) {
  await page.evaluate(`
    if (document.querySelector(".queue-drawer")) {
      document.querySelector(${q(PLAYING_NEXT_SELECTOR)})?.click();
    }
    return true;`);
}

/** Shuffle on puts the playing song first and keeps it playing. */
async function checkShuffleOnKeepsSong(page, check) {
  await setShuffleTo(page, false);
  const started = await openPlaylistRow(page, 0);
  const before = await nowPlaying(page);
  const at = await transitionCount(page);
  const turned = await setShuffleTo(page, true);
  await waitFor(page, `${FIXTURE}.snapshot().queue.index === 0`);
  const after = await nowPlaying(page);
  const trace = await snapshot(page);
  check(
    SHUFFLE_CHECKS.onKeepsSong,
    started &&
      turned &&
      before.title === PLAYLIST_FIRST_TITLE &&
      after.title === before.title &&
      after.activeId === before.activeId &&
      after.playing &&
      after.index === 0 &&
      trace.queue.items[0]?.id === after.activeId &&
      trace.modes.shuffle === true,
    {
      before,
      after,
      shuffle: trace.modes.shuffle,
      transitions: await transitionsSince(page, at),
    },
  );
}

/** A Play with shuffle on starts the clicked row, though MusicKit reshuffles. */
async function checkShuffledPlay(page, check) {
  await setShuffleTo(page, true);
  const at = await transitionCount(page);
  const started = await openPlaylistRow(page, CHOSEN_INDEX);
  const after = await nowPlaying(page);
  const trace = await snapshot(page);
  const setQueues = (await transitionsSince(page, at)).filter(
    (item) => item.type === "setQueue",
  );
  const request = setQueues[0];
  const start = request?.options?.startWith;
  const pointsAtChosen =
    request !== undefined &&
    (start === CHOSEN_ID ||
      (Number.isInteger(start) && request.ids[start] === CHOSEN_ID));
  const requestIds = request?.ids ?? [];
  const providerIds = idsOf(trace);
  check(
    SHUFFLE_CHECKS.playStarts,
    started &&
      pointsAtChosen &&
      after.title === CHOSEN_TITLE &&
      after.playing &&
      trace.modes.shuffle === true &&
      (!sameList(providerIds, requestIds) || after.activeId === CHOSEN_ID),
    {
      startWith: start,
      requestIds,
      providerIds,
      playing: after.title,
      setQueues: setQueues.length,
    },
  );
}

/** A parked queue resumed with shuffle on keeps its saved order and the UI state. */
async function checkParkedResume(page, check) {
  const shuffleOn = await setShuffleTo(page, true);
  const opened = await openAlbum(page);
  const at = await transitionCount(page);
  await page.evaluate(
    `document.querySelectorAll(".library-track-row")[${ALBUM_START}]?.click(); return true;`,
  );
  const queued = await typeSince(page, at, "setQueue");
  const playing = await waitFor(page, `${PLAY_LABEL} === "Pause"`);
  // The provider order as it stands before parking, from the playing song on.
  const parked = await snapshot(page);
  const savedIds = idsOf(parked);
  const expectedIds = savedIds.slice(parked.queue.index);
  const parkedOk = await parkThroughHandoff(page);
  const playAt = await transitionCount(page);
  await clickSelector(page, PLAY_BUTTON_SELECTOR);
  const resumed = await typeSince(page, playAt, "setQueue");
  const playedAgain = await waitFor(page, `${PLAY_LABEL} === "Pause"`);
  const resume = (await transitionsSince(page, playAt)).filter(
    (item) => item.type === "setQueue",
  );
  const pressed = await shufflePressed(page);
  check(
    SHUFFLE_CHECKS.parkedResume,
    opened &&
      shuffleOn &&
      queued &&
      playing &&
      parkedOk &&
      resumed &&
      playedAgain &&
      resume.length === 1 &&
      sameList(resume[0].ids, expectedIds) &&
      resume[0].index === 0 &&
      resume[0].shuffle === false &&
      pressed === "true",
    {
      savedIds,
      savedIndex: parked.queue.index,
      expectedIds,
      resume: resume.map((item) => ({
        ids: item.ids,
        index: item.index,
        shuffle: item.shuffle,
      })),
      pressed,
    },
  );
}

/** Turning shuffle off after the kept-order resume leaves the provider order alone. */
async function checkShuffleOffKeepsOrder(page, check) {
  const before = await snapshot(page);
  const beforeTitle = await readPage(page, TITLE);
  const at = await transitionCount(page);
  const turnedOff = await setShuffleTo(page, false);
  const after = await snapshot(page);
  const afterTitle = await readPage(page, TITLE);
  const pressed = await shufflePressed(page);
  check(
    SHUFFLE_CHECKS.offKeeps,
    turnedOff &&
      sameList(idsOf(after), idsOf(before)) &&
      after.queue.index === before.queue.index &&
      after.queue.activeId === before.queue.activeId &&
      afterTitle === beforeTitle &&
      pressed === "false",
    {
      beforeIds: idsOf(before),
      afterIds: idsOf(after),
      beforeTitle,
      afterTitle,
      modes: { before: before.modes, after: after.modes },
      transitions: await transitionsSince(page, at),
    },
  );
}

/** A rebuild with shuffle on keeps the edited order minus the removed row. */
async function checkRebuildKeepsEditedOrder(page, check) {
  await setShuffleTo(page, false);
  const started = await openPlaylistRow(page, 0);
  const startedTitle = await readPage(page, TITLE);
  const shuffleOn = await setShuffleTo(page, true);
  // Forces the rebuild tier: the edit writes the whole queue through setQueue.
  await fixtureCall(page, "configure", [{ nativeQueueEdit: false }]);
  try {
    const drawerReady = await openDrawer(page);
    const displayed = await page.evaluate(
      `return [...document.querySelectorAll(${q(DRAWER_ROWS)})].map((row) => row.querySelector(".queue-copy strong")?.textContent ?? null);`,
    );
    const removeAt = displayed.indexOf(CHOSEN_TITLE);
    const mark = await transitionCount(page);
    const removed = await page.evaluate(`
      const row = [...document.querySelectorAll(${q(DRAWER_ROWS)})].find(
        (item) => item.querySelector(".queue-copy strong")?.textContent === ${q(CHOSEN_TITLE)},
      );
      const control = row?.querySelector('[data-queue-action="remove"]');
      if (!control || control.disabled) return false;
      control.click();
      return true;`);
    const settled = await typeSince(page, mark, "play");
    const after = await snapshot(page);
    const expected = displayed.filter((_, index) => index !== removeAt);
    const pressed = await shufflePressed(page);
    check(
      SHUFFLE_CHECKS.rebuildKeeps,
      started &&
        startedTitle === PLAYLIST_FIRST_TITLE &&
        shuffleOn &&
        drawerReady &&
        removeAt >= 0 &&
        removed &&
        settled &&
        sameList(titlesOf(after), expected) &&
        pressed === "true",
      {
        displayed,
        expected,
        provider: titlesOf(after),
        pressed,
        transitions: await transitionsSince(page, mark),
      },
    );
  } finally {
    await fixtureCall(page, "configure", [{ nativeQueueEdit: false }]);
    await closeDrawer(page);
  }
}

/**
 * After the rebuild above, Arlet holds MusicKit's shuffle off and shows shuffle
 * on. Choosing a later row must select it in that held order: writing shuffle
 * on first would make MusicKit reshuffle, and the old index would name another
 * song.
 */
async function checkSelectionKeepsHeldOrder(page, check) {
  const before = await snapshot(page);
  const held =
    before.modes.shuffle === false && (await shufflePressed(page)) === "true";
  const drawerReady = await openDrawer(page, before.queue.items.length);
  try {
    const mark = await transitionCount(page);
    const chosen = await page.evaluate(`
      const rows = [...document.querySelectorAll(${q(DRAWER_ROWS)})];
      const active = rows.findIndex((row) => row.querySelector('button.queue-row[aria-current="true"]'));
      const row = active < 0 ? undefined : rows[active + 2];
      const button = row?.querySelector("button.queue-row");
      if (!button) return null;
      const title = button.querySelector(".queue-copy strong")?.textContent ?? null;
      button.click();
      return title;`);
    const playing =
      chosen !== null && (await waitFor(page, `${TITLE} === ${q(chosen)}`));
    const after = await snapshot(page);
    const pressed = await shufflePressed(page);
    check(
      SHUFFLE_CHECKS.selectionKeeps,
      held &&
        drawerReady &&
        playing &&
        sameList(titlesOf(after), titlesOf(before)) &&
        after.modes.shuffle === false &&
        pressed === "true",
      {
        held,
        drawerReady,
        chosen,
        nowPlaying: await readPage(page, TITLE),
        before: titlesOf(before),
        after: titlesOf(after),
        providerShuffle: after.modes.shuffle,
        pressed,
        transitions: await transitionsSince(page, mark),
      },
    );
  } finally {
    await closeDrawer(page);
  }
}

async function saveScreenshot(page, file) {
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  await writeFile(file, Buffer.from(shot.data, "base64"));
}

/**
 * Records the player bar title, the Play label, and every Windows media
 * session call Arlet makes (its Tauri IPC commands) until stopSampler runs.
 * Samples are taken on DOM mutations, each animation frame, and each IPC call,
 * and only when the tuple changes.
 */
function installSampler(page) {
  return page.evaluate(`
    const bar = document.querySelector(".player-bar");
    const tauri = window.__TAURI_INTERNALS__;
    const state = {
      samples: [],
      calls: [],
      media: null,
      last: null,
      frame: 0,
      active: true,
      native: tauri?.invoke,
    };
    window.__ARLET_PARITY_SAMPLER__ = state;
    const sample = (source) => {
      const title =
        document.querySelector(".player-bar .player-track-copy strong")
          ?.textContent ?? null;
      const label =
        document.querySelector(".play-button")?.getAttribute("aria-label") ??
        null;
      const key = JSON.stringify([title, label, state.media]);
      if (key === state.last) return;
      state.last = key;
      state.samples.push({
        at: Math.round(performance.now()),
        source,
        title,
        label,
        media: state.media,
      });
    };
    if (tauri && typeof tauri.invoke === "function") {
      tauri.invoke = function (command, args, options) {
        if (
          command === "update_windows_media_session" ||
          command === "clear_windows_media_session"
        ) {
          const payload = args?.payload ?? {};
          const call =
            command === "clear_windows_media_session"
              ? { command, status: "cleared", title: null }
              : {
                  command,
                  status: payload.playbackStatus ?? null,
                  title: payload.title ?? null,
                };
          state.media = { status: call.status, title: call.title };
          if (state.calls.length < 200) state.calls.push(call);
          sample("ipc");
        }
        return state.native.apply(tauri, [command, args, options]);
      };
    }
    state.observer = new MutationObserver(() => sample("mutation"));
    if (bar) {
      state.observer.observe(bar, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    }
    const frame = () => {
      if (!state.active) return;
      sample("frame");
      state.frame = requestAnimationFrame(frame);
    };
    frame();
    return true;`);
}

/** Stops the sampler, restores the IPC function, and returns what it recorded. */
function stopSampler(page) {
  return page.evaluate(`
    const state = window.__ARLET_PARITY_SAMPLER__;
    if (!state) return { samples: [], calls: [] };
    state.active = false;
    cancelAnimationFrame(state.frame);
    state.observer?.disconnect();
    if (window.__TAURI_INTERNALS__ && state.native) {
      window.__TAURI_INTERNALS__.invoke = state.native;
    }
    delete window.__ARLET_PARITY_SAMPLER__;
    return { samples: state.samples, calls: state.calls };`);
}

/** Collects toast messages that appear after this call; toasts already shown are skipped. */
function startToastRecorder(page) {
  return page.evaluate(`
    const baseline = new Set(document.querySelectorAll(".action-toast-message"));
    const seen = (window.__ARLET_PARITY_TOASTS__ = new Set());
    const record = () =>
      document.querySelectorAll(".action-toast-message").forEach((node) => {
        if (!baseline.has(node)) seen.add(node.textContent.trim());
      });
    window.__ARLET_PARITY_TOAST_OBSERVER__?.disconnect();
    window.__ARLET_PARITY_TOAST_OBSERVER__ = new MutationObserver(record);
    window.__ARLET_PARITY_TOAST_OBSERVER__.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return true;`);
}

function stopToastRecorder(page) {
  return page.evaluate(`
    window.__ARLET_PARITY_TOAST_OBSERVER__?.disconnect();
    delete window.__ARLET_PARITY_TOAST_OBSERVER__;
    const messages = [...(window.__ARLET_PARITY_TOASTS__ ?? [])];
    delete window.__ARLET_PARITY_TOASTS__;
    return messages;`);
}

/** Starts Radio's Pop Station One from the Radio page, as a listener would. */
async function startStation(page) {
  await page.evaluate(`location.hash = "#/radio"; return true;`);
  const chipsReady = await waitFor(
    page,
    `document.querySelectorAll('[role="group"][aria-labelledby="radio-genres-heading"] .browse-chip').length >= 2`,
    15_000,
  );
  if (!chipsReady) return false;
  const chipClicked = await page.evaluate(`
    const chip = [...document.querySelectorAll(".browse-chip")].find((node) => node.textContent.trim() === ${q(RADIO_GENRE_CHIP)});
    if (!chip) return false;
    chip.click();
    return true;`);
  const cardReady = await waitFor(
    page,
    `[...document.querySelectorAll(".home-discovery-card")].some((node) => node.textContent.includes(${q(RADIO_STATION_CARD)}))`,
  );
  if (!chipClicked || !cardReady) return false;
  await page.evaluate(`
    const card = [...document.querySelectorAll(".home-discovery-card")].find((node) => node.textContent.includes(${q(RADIO_STATION_CARD)}));
    if (!card || card.disabled) return false;
    card.click();
    return true;`);
  return waitFor(
    page,
    `${FIXTURE}.snapshot().queue.isStation === true && ${PLAY_LABEL} === "Pause"`,
    15_000,
  );
}

/**
 * Picks an upcoming Playing Next row with shuffle off, so the drawer order is
 * the playlist order. Samples the player and media controls across the switch.
 */
async function checkSelectionKeepsPlayer(page, check) {
  // The Repeat group ends on Repeat All; a repeat pass must not affect this group.
  const repeatOff = await cycleRepeatTo(page, "Repeat off");
  const shuffleOff = await setShuffleTo(page, false);
  const started = await openPlaylistRow(page, 0);
  const providerBefore = await snapshot(page);
  const drawerReady = await openDrawerIdle(
    page,
    providerBefore.queue.items.length,
  );
  const drawerBefore = await drawerState(page);
  const at = await transitionCount(page);
  let samples = [];
  let calls = [];
  let clickedRow = null;
  let clicked = false;
  let selectStopped = false;
  let playing = false;
  let toasts = [];
  try {
    await installSampler(page);
    await startToastRecorder(page);
    // Picked by song ID, not row position: duplicates of other songs exist.
    clickedRow = await page.evaluate(`
      const row = [...document.querySelectorAll(${q(DRAWER_ROWS)})].find(
        (item) => item.querySelector(".queue-row-shell")?.getAttribute("data-context-id") === ${q(CHOSEN_ID)},
      );
      const control = row?.querySelector(".queue-row");
      if (!control) return null;
      const title = row.querySelector(".queue-copy strong")?.textContent ?? null;
      control.click();
      return { title, label: control.getAttribute("aria-label") };`);
    clicked = clickedRow !== null;
    selectStopped = await typeSince(page, at, "selectStop");
    playing = await waitFor(
      page,
      `${TITLE} === ${q(CHOSEN_TITLE)} && ${PLAY_LABEL} === "Pause"`,
    );
  } finally {
    ({ samples, calls } = await stopSampler(page));
    toasts = await stopToastRecorder(page);
    await closeDrawer(page);
  }
  const after = await nowPlaying(page);
  const emptyTitle = samples.some((item) => !item.title?.trim());
  const mediaLost =
    samples.some(
      (item) =>
        item.media?.status === "stopped" || item.media?.status === "cleared",
    ) ||
    calls.some(
      (item) =>
        item.status === "stopped" ||
        item.command === "clear_windows_media_session",
    );
  check(
    SELECTION_CHECKS.selection,
    repeatOff &&
      shuffleOff &&
      started &&
      drawerReady &&
      clicked &&
      selectStopped &&
      playing &&
      !emptyTitle &&
      !mediaLost &&
      after.title === CHOSEN_TITLE &&
      after.index === CHOSEN_INDEX &&
      after.playing,
    {
      repeatOff,
      shuffleOff,
      started,
      drawerReady,
      drawerBefore,
      providerBefore: {
        ids: idsOf(providerBefore),
        index: providerBefore.queue.index,
        modes: providerBefore.modes,
      },
      clicked,
      clickedRow,
      selectStopped,
      playing,
      toasts,
      samples,
      mediaCalls: calls,
      transitions: await transitionsSince(page, at),
      after,
    },
  );
}

/** A station hides the Shuffle and Repeat buttons, and the queue reports it. */
async function checkStationHidesModes(page, check) {
  const started = await startStation(page);
  const hidden = await waitFor(
    page,
    `!document.querySelector(${q(PLAYER_SHUFFLE_SELECTOR)}) && !document.querySelector(${q(REPEAT_SELECTOR)})`,
    3000,
  );
  const trace = await snapshot(page);
  const controls = await page.evaluate(`
    return {
      shuffle: Boolean(document.querySelector(${q(PLAYER_SHUFFLE_SELECTOR)})),
      repeat: document.querySelector(${q(REPEAT_SELECTOR)})?.getAttribute("aria-label") ?? null,
    };`);
  check(
    SELECTION_CHECKS.modes,
    started && hidden && trace.queue.isStation === true,
    {
      started,
      isStation: trace.queue.isStation,
      controls,
      modes: trace.modes,
      title: await readPage(page, TITLE),
    },
  );
}

/** Play Next during a station explains the refusal and never reaches MusicKit. */
async function checkStationPlayNext(page, check) {
  await fixtureCall(page, "selectContext", [PLAY_NEXT_CONTEXT_ID]);
  const menuReady = await waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item="play-next"]:not(:disabled)')`,
  );
  const at = await transitionCount(page);
  let toasts = [];
  let explained = false;
  await startToastRecorder(page);
  try {
    await page.evaluate(
      `document.querySelector('.context-menu [data-menu-item="play-next"]')?.click(); return true;`,
    );
    explained = await waitFor(
      page,
      `[...(window.__ARLET_PARITY_TOASTS__ ?? [])].some((text) => text.includes(${q(STATION_TOAST)}))`,
    );
  } finally {
    toasts = await stopToastRecorder(page);
  }
  const transitions = await transitionsSince(page, at);
  check(
    SELECTION_CHECKS.playNext,
    menuReady &&
      explained &&
      !toasts.some((text) => text.includes("UNSUPPORTED_ERROR")) &&
      !transitions.some((item) => item.type === "playNext"),
    { menuReady, toasts, transitions },
  );
}

// Check names copied verbatim from docs/TESTING.md ("MusicKit parity", Autoplay).
const AUTOPLAY_CHECKS = {
  shows: "autoplay songs show under an Autoplay heading after the queue",
  playLater: "Play Later adds songs before the autoplay songs",
  clear: "Clear removes queued songs and keeps the autoplay songs",
  repeat: "Repeat on removes autoplay songs and Repeat off brings them back",
  toggle:
    "the Playing Next autoplay toggle turns autoplay off, removes its songs, saves the setting, and stays to turn it back on",
  modes: "shuffle and repeat are disabled while an autoplay song plays",
  saved:
    "the saved session, stream handoff, and Save as playlist leave out upcoming autoplay songs",
  refill:
    "the playlist refill ignores autoplay songs when counting what is left",
  refused:
    "an autoplay station Apple refuses is logged once and shows no Autoplay heading",
};
const AUTOPLAY_SECTION = ".queue-drawer section.queue-autoplay";
const AUTOPLAY_TOGGLE_SELECTOR = 'button[aria-label="Autoplay"]';
const CLEAR_UP_NEXT_SELECTOR = 'button[aria-label="Clear up next"]';
const SETTINGS_SELECTOR = 'button[aria-label="Settings"]';
const STATION_PATH = "/v1/me/stations/continuous";
// The line controller.ts logs 10 s after a Play when Apple refuses the station.
const AUTOPLAY_UNAVAILABLE_LINE =
  "Autoplay station unavailable for this account; Autoplay songs are off for this queue.";
const AUTOPLAY_LOG_WAIT_MS = 11_000;
const BIG_PLAYLIST_ID = "playlist-big";
// Autoplay songs are fixture IDs `autoplay-N` titled "Autoplay Song N".
const AUTOPLAY_PREFIX = "autoplay-";
const AUTOPLAY_TITLE_PREFIX = "Autoplay Song ";
const AUTOPLAY_MAX = 10;
// The refill fires once fewer than 50 user songs follow the playing one
// (QUEUE_REFILL_THRESHOLD). Counting the 10 autoplay songs too would move the
// refill 10 songs early, to 39 user songs left; the window below catches that.
const REFILL_THRESHOLD = 50;
const REFILL_WINDOW_LOW = 40;
const CURRENT_IS_AUTOPLAY = `(() => { const s = window.__ARLET_E2E_MUSIC__.snapshot(); return String(s.queue.items[s.queue.index]?.id ?? "").startsWith(${q(AUTOPLAY_PREFIX)}); })()`;
const USER_UPCOMING_AT_LEAST = (count) =>
  `(() => { const s = window.__ARLET_E2E_MUSIC__.snapshot(); return s.queue.items.slice(s.queue.index + 1).filter((item) => !String(item.id).startsWith(${q(AUTOPLAY_PREFIX)})).length >= ${count}; })()`;

const isAutoplayId = (id) => String(id ?? "").startsWith(AUTOPLAY_PREFIX);
const autoplayIdsOf = (trace) => trace.queue.autoplay?.ids ?? [];
const autoplayItems = (trace) =>
  trace.queue.items.filter((item) => isAutoplayId(item.id));
const autoplayItemIds = (trace) => autoplayItems(trace).map((item) => item.id);
const userItems = (trace, from = 0) =>
  trace.queue.items.slice(from).filter((item) => !isAutoplayId(item.id));
const userIdsOf = (trace, from = 0) =>
  userItems(trace, from).map((item) => item.id);
const userRemaining = (trace) => userItems(trace, trace.queue.index + 1).length;
const currentId = (trace) => trace.queue.items[trace.queue.index]?.id ?? null;

/**
 * Starts the fixture playlist with autoplay on, as a Play from its row does.
 * Live MusicKit asks for an autoplay station only with repeat off, and the
 * Repeat group leaves Repeat All on, so repeat goes off first.
 */
/** Repeat off on the instance itself, then the button label has to agree. */
async function repeatOffOnInstance(page) {
  await page.evaluate(
    `const music = window.MusicKit?.getInstance?.(); if (music) music.repeatMode = window.MusicKit.PlayerRepeatMode.none; return true;`,
  );
  return cycleRepeatTo(page, "Repeat off");
}

async function startAutoplayPlaylist(page) {
  const repeatBefore = await readPage(page, REPEAT_LABEL);
  const cycled = await repeatOffOnInstance(page);
  const repeatAfter = await readPage(page, REPEAT_LABEL);
  const modesAfterCycle = (await snapshot(page)).modes;
  await fixtureCall(page, "configure", [{ autoplayStation: "ok" }]);
  const mark = (await snapshot(page)).requests.length;
  const at = await transitionCount(page);
  const started = await openPlaylistRow(page, 0);
  const after = await snapshot(page);
  lastAutoplayStart = {
    repeatBefore,
    cycled,
    repeatAfter,
    modesAfterCycle,
    autoplayEnabled: await readPage(
      page,
      "window.MusicKit?.getInstance?.()?.autoplayEnabled ?? null",
    ),
    stationPosts: after.requests
      .slice(mark)
      .filter((item) => String(item.path).startsWith("/v1/me/stations"))
      .map((item) => `${item.method} ${item.path} ${item.status ?? ""}`),
    transitionTypes: after.transitions.slice(at).map((item) => item.type),
  };
  return started;
}
/** Diagnostic: what the last autoplay start did, carried into check details. */
let lastAutoplayStart = null;

/** The drawer's Autoplay section and the user rows, which sit outside it. */
function readDrawerAutoplay(page) {
  return page.evaluate(`
    const section = document.querySelector(${q(AUTOPLAY_SECTION)});
    const list = document.querySelector(".queue-drawer .queue-list");
    const toggle = document.querySelector(${q(AUTOPLAY_TOGGLE_SELECTOR)});
    const titleOf = (row) => row.querySelector(".queue-copy strong")?.textContent?.trim() ?? null;
    return {
      present: Boolean(section),
      heading: Boolean(section) && section.textContent.trim().startsWith("Autoplay"),
      rowTitles: section ? [...section.querySelectorAll("li")].map(titleOf) : [],
      rowControls: section
        ? section.querySelectorAll("[data-queue-action], .queue-row-action").length
        : 0,
      afterUserRows:
        Boolean(section && list) &&
        Boolean(list.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING),
      toggle: toggle
        ? { pressed: toggle.getAttribute("aria-pressed"), disabled: toggle.disabled === true }
        : null,
      userTitles: [...document.querySelectorAll(${q(DRAWER_ROWS)})]
        .filter((row) => !row.closest(".queue-autoplay"))
        .map(titleOf),
    };`);
}

/** Shuffle and Repeat in the player bar, with their disabled state. */
function readPlayerModes(page) {
  return page.evaluate(`
    const shuffle = document.querySelector(${q(PLAYER_SHUFFLE_SELECTOR)});
    const repeat = document.querySelector(${q(REPEAT_SELECTOR)});
    return {
      shuffle: shuffle
        ? { present: true, disabled: shuffle.disabled === true }
        : { present: false, disabled: null },
      repeat: repeat
        ? { present: true, disabled: repeat.disabled === true, label: repeat.getAttribute("aria-label") }
        : { present: false, disabled: null, label: null },
    };`);
}

const savedAutoplay = (page) =>
  page.evaluate(
    'return JSON.parse(await window.__TAURI_INTERNALS__.invoke("load_settings")).autoplay;',
  );

/** Saves are asynchronous; poll the settings file until the value reads as expected. */
async function waitForSavedAutoplay(page, value, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await savedAutoplay(page)) === value) return true;
    await sleep(100);
  }
  return false;
}

/** Sets the Autoplay checkbox on the Settings page, then waits for the save. */
async function setAutoplaySetting(page, on) {
  await page.evaluate(
    `document.querySelector(${q(SETTINGS_SELECTOR)})?.click(); return true;`,
  );
  const opened = await waitFor(
    page,
    `document.querySelector(".settings-layout")`,
    5000,
  );
  if (!opened) return false;
  const found = await page.evaluate(`
    const input = [...document.querySelectorAll("label")]
      .find((node) => node.textContent.includes("Autoplay"))
      ?.querySelector("input[type=checkbox]");
    if (input && input.checked !== ${on}) input.click();
    return Boolean(input);`);
  if (!found) return false;
  return waitForSavedAutoplay(page, on);
}

const readSession = (page) =>
  page.evaluate(`
    const raw = await window.__TAURI_INTERNALS__.invoke("load_playback_session");
    const session = raw ? JSON.parse(raw) : null;
    return session
      ? { savedAt: session.savedAt ?? 0, ids: (session.items ?? []).map((item) => item.id) }
      : null;`);

/** The saved session written at or after `since` (the page clock), once it has songs. */
async function savedSessionSince(page, since, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let session = null;
  while (Date.now() < deadline) {
    session = await readSession(page);
    if (session && session.savedAt >= since && session.ids.length > 0) {
      return session;
    }
    await sleep(150);
  }
  return session;
}

function typeInto(page, selector, value) {
  return page.evaluate(`
    const field = document.querySelector(${q(selector)});
    if (!field) return false;
    field.focus();
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(field),
      "value",
    ).set;
    setter.call(field, ${q(value)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;`);
}

/** Save as playlist from the drawer: names the playlist and submits the dialog. */
async function saveAsPlaylist(page, name, count) {
  await page.evaluate(`
    [...document.querySelectorAll(".queue-toolbar button")]
      .find((node) => node.textContent.trim() === "Save as playlist")?.click();
    return true;`);
  const offered = await waitFor(
    page,
    `document.querySelector(".playlist-dialog")?.textContent.includes(${q(`${count} selected songs`)})`,
    10_000,
  );
  const typed = await typeInto(
    page,
    ".playlist-dialog-form input[type='text']",
    name,
  );
  await page.evaluate(
    `document.querySelector(".playlist-dialog-form")?.requestSubmit(); return true;`,
  );
  const closed = await waitFor(
    page,
    `!document.querySelector(".playlist-dialog-backdrop")`,
    15_000,
  );
  return { offered, typed, closed };
}

/** Autoplay songs sit under their heading after the user rows, with no row controls. */
async function checkAutoplayShows(page, check) {
  const started = await startAutoplayPlaylist(page);
  const drawer = await openDrawer(page);
  const shown = await waitFor(
    page,
    `document.querySelector(${q(AUTOPLAY_SECTION)}) !== null`,
  );
  const trace = await snapshot(page);
  const ui = await readDrawerAutoplay(page);
  const songs = autoplayItems(trace);
  check(
    AUTOPLAY_CHECKS.shows,
    started &&
      drawer &&
      shown &&
      ui.present &&
      ui.heading &&
      songs.length > 0 &&
      songs.length <= AUTOPLAY_MAX &&
      sameList(autoplayItemIds(trace), autoplayIdsOf(trace)) &&
      songs.every((item) =>
        String(item.title).startsWith(AUTOPLAY_TITLE_PREFIX),
      ) &&
      sameList(
        ui.rowTitles,
        songs.map((item) => item.title),
      ) &&
      ui.rowControls === 0 &&
      ui.afterUserRows &&
      sameList(
        ui.userTitles,
        userItems(trace).map((item) => item.title),
      ) &&
      ui.toggle?.pressed === "true",
    {
      started,
      drawer,
      ui,
      autoplayIds: autoplayIdsOf(trace),
      queueIds: idsOf(trace),
      start: lastAutoplayStart,
    },
  );
}

/** Upcoming user songs get Play Later; the new song must land before the autoplay songs. */
async function checkPlayLaterOrder(page, check) {
  const started = await startAutoplayPlaylist(page);
  const drawer = await openDrawer(page);
  const before = await snapshot(page);
  const appendAt = before.queue.items.findIndex((item) =>
    isAutoplayId(item.id),
  );
  const at = await transitionCount(page);
  await fixtureCall(page, "selectContext", [PLAY_NEXT_CONTEXT_ID]);
  const menuReady = await waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item="play-later"]:not(:disabled)')`,
  );
  await page.evaluate(
    `document.querySelector('.context-menu [data-menu-item="play-later"]')?.click(); return true;`,
  );
  const queued = await typeSince(page, at, "playLater");
  const rowsReady = await waitFor(
    page,
    `document.querySelectorAll(${q(DRAWER_ROWS)}).length === ${PLAYLIST_SIZE + 1}`,
  );
  const after = await snapshot(page);
  const ui = await readDrawerAutoplay(page);
  check(
    AUTOPLAY_CHECKS.playLater,
    started &&
      drawer &&
      menuReady &&
      queued &&
      rowsReady &&
      appendAt === PLAYLIST_SIZE &&
      before.queue.autoplay?.appendTargetIndex === appendAt &&
      after.queue.items[appendAt]?.id === PLAY_NEXT_CONTEXT_ID &&
      after.queue.items
        .slice(appendAt + 1)
        .every((item) => isAutoplayId(item.id)) &&
      sameList(autoplayItemIds(after), autoplayItemIds(before)) &&
      ui.userTitles[appendAt] === CHOSEN_TITLE &&
      ui.afterUserRows,
    {
      appendAt,
      appendTargetIndex: before.queue.autoplay?.appendTargetIndex ?? null,
      start: lastAutoplayStart,
      inserted: after.queue.items[appendAt]?.id ?? null,
      userTitles: ui.userTitles,
      afterUserRows: ui.afterUserRows,
      transitions: await transitionsSince(page, at),
    },
  );
}

/** Clear drops the upcoming user songs and leaves the autoplay songs queued. */
async function checkClearKeepsAutoplay(page, check) {
  const started = await startAutoplayPlaylist(page);
  const drawer = await openDrawer(page);
  const before = await snapshot(page);
  const at = await transitionCount(page);
  const clearReady = await waitFor(
    page,
    `(() => { const button = document.querySelector(${q(CLEAR_UP_NEXT_SELECTOR)}); return Boolean(button) && !button.disabled; })()`,
  );
  const clicked = await clickSelector(page, CLEAR_UP_NEXT_SELECTOR);
  const settled = await waitFor(
    page,
    `${FIXTURE}.snapshot().queue.items.filter((item) => !String(item.id).startsWith(${q(AUTOPLAY_PREFIX)})).length === ${before.queue.index + 1}`,
  );
  const after = await snapshot(page);
  const ui = await readDrawerAutoplay(page);
  check(
    AUTOPLAY_CHECKS.clear,
    started &&
      drawer &&
      clearReady &&
      clicked &&
      settled &&
      sameList(userIdsOf(after), [currentId(before)]) &&
      autoplayItems(before).length > 0 &&
      // Live Clear splices the upcoming songs too, and the top-up then refills
      // the autoplay songs with new ones (the brief's "come back"), so the count
      // is kept and the IDs may change.
      autoplayItemIds(after).length === autoplayItemIds(before).length &&
      autoplayIdsOf(after).length === autoplayIdsOf(before).length &&
      ui.present &&
      ui.rowTitles.length === autoplayIdsOf(after).length,
    {
      before: { user: userIdsOf(before), autoplay: autoplayItemIds(before) },
      after: { user: userIdsOf(after), autoplay: autoplayItemIds(after) },
      ui,
      start: lastAutoplayStart,
      transitions: await transitionsSince(page, at),
    },
  );
}

/** Repeat All removes the autoplay songs; Repeat Off tops them up again. */
async function checkRepeatRemovesAutoplay(page, check, modesEnum) {
  const started = await startAutoplayPlaylist(page);
  await cycleRepeatTo(page, "Repeat off");
  const before = await snapshot(page);
  const atOn = await transitionCount(page);
  const on = await cycleRepeatTo(page, "Repeat all");
  const removed = await typeSince(page, atOn, "autoplayRemoved");
  const afterOn = await snapshot(page);
  const atOff = await transitionCount(page);
  const off = await cycleRepeatTo(page, "Repeat off");
  const topped = await typeSince(page, atOff, "autoplayTopUp");
  const afterOff = await snapshot(page);
  check(
    AUTOPLAY_CHECKS.repeat,
    started &&
      autoplayIdsOf(before).length > 0 &&
      on &&
      removed &&
      autoplayIdsOf(afterOn).length === 0 &&
      autoplayItems(afterOn).length === 0 &&
      userItems(afterOn).length === PLAYLIST_SIZE &&
      afterOn.modes.repeat === modesEnum.all &&
      off &&
      topped &&
      autoplayIdsOf(afterOff).length > 0 &&
      autoplayItems(afterOff).length > 0 &&
      afterOff.modes.repeat === modesEnum.none,
    {
      before: { autoplay: autoplayIdsOf(before) },
      start: lastAutoplayStart,
      afterOn: { autoplay: autoplayIdsOf(afterOn), modes: afterOn.modes },
      afterOff: { autoplay: autoplayIdsOf(afterOff), modes: afterOff.modes },
      transitions: await transitionsSince(page, atOn),
    },
  );
}

/** The Playing Next toggle turns autoplay off, removes its songs, and saves it. */
async function checkAutoplayToggle(page, check) {
  const started = await startAutoplayPlaylist(page);
  const drawer = await openDrawer(page);
  const before = await readDrawerAutoplay(page);
  const at = await transitionCount(page);
  let clicked = false;
  let removed = false;
  let emptied = false;
  let saved = false;
  let after = null;
  let shownAfter = null;
  let reenabled = false;
  let restored = false;
  try {
    clicked = await clickSelector(page, AUTOPLAY_TOGGLE_SELECTOR);
    removed = await typeSince(page, at, "autoplayRemoved");
    emptied = await waitFor(
      page,
      `${FIXTURE}.snapshot().queue.autoplay.ids.length === 0`,
    );
    saved = await waitForSavedAutoplay(page, false);
    after = await snapshot(page);
    shownAfter = await readDrawerAutoplay(page);
    // The toggle stays in the drawer with Autoplay off and turns it back on.
    if (shownAfter?.toggle?.pressed === "false") {
      reenabled =
        (await clickSelector(page, AUTOPLAY_TOGGLE_SELECTOR)) &&
        (await waitForSavedAutoplay(page, true));
    }
  } finally {
    // Safety net: later checks need Autoplay on.
    restored = await setAutoplaySetting(page, true);
  }
  check(
    AUTOPLAY_CHECKS.toggle,
    started &&
      drawer &&
      before.toggle?.pressed === "true" &&
      before.toggle.disabled === false &&
      clicked &&
      removed &&
      emptied &&
      saved &&
      after !== null &&
      autoplayItems(after).length === 0 &&
      userItems(after).length === PLAYLIST_SIZE &&
      shownAfter?.toggle?.disabled === false &&
      reenabled,
    {
      before: before.toggle,
      shownAfter,
      saved,
      reenabled,
      restored,
      userSongs: after ? userItems(after).length : null,
      transitions: await transitionsSince(page, at),
    },
  );
}

/** While an autoplay song plays, Shuffle and Repeat stay in the bar but are disabled. */
async function checkModesDisabledOnAutoplay(page, check) {
  const started = await startAutoplayPlaylist(page);
  const shuffleOff = await setShuffleTo(page, false);
  const repeatOff = await cycleRepeatTo(page, "Repeat off");
  for (let step = 0; step <= PLAYLIST_SIZE; step += 1) {
    const trace = await snapshot(page);
    if (isAutoplayId(currentId(trace))) break;
    await fixtureCall(page, "finishCurrentTrack");
    await waitFor(
      page,
      `${FIXTURE}.snapshot().queue.index !== ${trace.queue.index}`,
    );
  }
  const playingAutoplay = await waitFor(page, CURRENT_IS_AUTOPLAY);
  const before = await snapshot(page);
  const controls = await readPlayerModes(page);
  await clickSelector(page, PLAYER_SHUFFLE_SELECTOR);
  await clickSelector(page, REPEAT_SELECTOR);
  await sleep(300);
  const after = await snapshot(page);
  check(
    AUTOPLAY_CHECKS.modes,
    started &&
      shuffleOff &&
      repeatOff &&
      playingAutoplay &&
      controls.shuffle.present &&
      controls.shuffle.disabled &&
      controls.repeat.present &&
      controls.repeat.disabled &&
      JSON.stringify(after.modes) === JSON.stringify(before.modes) &&
      after.queue.index === before.queue.index,
    {
      controls,
      currentId: currentId(after),
      modes: { before: before.modes, after: after.modes },
    },
  );
}

/** The saved session, a stream handoff, and Save as playlist all hold only the user songs. */
async function checkSavedPaths(page, check) {
  const startedAt = await readPage(page, "Date.now()");
  const started = await startAutoplayPlaylist(page);
  const session = await savedSessionSince(page, startedAt);
  const sessionIds = session?.ids ?? [];
  const userIds = userIdsOf(await snapshot(page));
  const parkBefore = await snapshot(page);
  const parkedUserIds = userIdsOf(parkBefore, parkBefore.queue.index);
  const stopped = await parkThroughHandoff(page);
  const playAt = await transitionCount(page);
  await clickSelector(page, PLAY_BUTTON_SELECTOR);
  const resumed = await typeSince(page, playAt, "setQueue");
  const playedAgain = await waitFor(page, `${PLAY_LABEL} === "Pause"`);
  const resume = (await transitionsSince(page, playAt)).filter(
    (item) => item.type === "setQueue",
  );
  const resumeIds = resume[0]?.ids ?? [];
  await openDrawer(page);
  const createsBefore = (await snapshot(page)).playlistMutations.creates.length;
  const save = await saveAsPlaylist(page, "Autoplay Leftovers", userIds.length);
  const created = await waitFor(
    page,
    `${FIXTURE}.snapshot().playlistMutations.creates.length > ${createsBefore}`,
    15_000,
  );
  const creates = (await snapshot(page)).playlistMutations.creates.slice(
    createsBefore,
  );
  const savedIds = creates[0]?.trackIds ?? [];
  check(
    AUTOPLAY_CHECKS.saved,
    started &&
      session !== null &&
      sessionIds.length > 0 &&
      sameList(sessionIds, userIds) &&
      stopped &&
      resumed &&
      playedAgain &&
      sameList(resumeIds, parkedUserIds) &&
      save.offered &&
      save.closed &&
      created &&
      creates.length === 1 &&
      sameList(savedIds, userIds),
    {
      session: { savedAt: session?.savedAt ?? null, ids: sessionIds },
      userIds,
      handoff: { stopped, resumeIds, parkedUserIds },
      save,
      savedIds,
    },
  );
}

/**
 * A large playlist refills while only autoplay songs follow the user songs.
 * Walks the queue one song at a time and records how many user songs were left
 * at the refill (the playLater that appends the next window).
 */
async function checkRefillCountsUserSongs(page, check) {
  await fixtureCall(page, "configure", [{ autoplayStation: "ok" }]);
  const shuffleOff = await setShuffleTo(page, false);
  const repeatOff = await cycleRepeatTo(page, "Repeat off");
  await page.evaluate(
    `location.hash = ${q(`#/playlist/${BIG_PLAYLIST_ID}`)}; return true;`,
  );
  const rowsReady = await waitFor(
    page,
    `document.querySelectorAll(".library-track-row").length >= 3`,
    15_000,
  );
  const at = await transitionCount(page);
  await page.evaluate(
    `document.querySelectorAll(".library-track-row")[0]?.click(); return true;`,
  );
  const queued = await typeSince(page, at, "setQueue");
  const playing = await waitFor(page, `${PLAY_LABEL} === "Pause"`);
  // The first window's refill must land before the walk, so it starts long.
  const primed = await waitFor(
    page,
    USER_UPCOMING_AT_LEAST(REFILL_THRESHOLD),
    15_000,
  );
  let refillAt = null;
  let refillIds = [];
  let steps = 0;
  for (let step = 0; step < 300; step += 1) {
    const trace = await snapshot(page);
    const next = userRemaining(trace) - 1;
    const mark = await transitionCount(page);
    await fixtureCall(page, "finishCurrentTrack");
    await waitFor(
      page,
      `${FIXTURE}.snapshot().queue.index !== ${trace.queue.index}`,
    );
    steps += 1;
    if (next < REFILL_THRESHOLD) {
      if (await typeSince(page, mark, "playLater", 2000)) {
        refillAt = next;
        refillIds = (await transitionsSince(page, mark))
          .filter((item) => item.type === "playLater")
          .flatMap((item) => item.ids);
        break;
      }
      if (next < REFILL_WINDOW_LOW - 5) break;
    }
  }
  const after = await snapshot(page);
  check(
    AUTOPLAY_CHECKS.refill,
    shuffleOff &&
      repeatOff &&
      rowsReady &&
      queued &&
      playing &&
      primed &&
      refillAt !== null &&
      refillAt >= REFILL_WINDOW_LOW &&
      refillAt < REFILL_THRESHOLD &&
      refillIds.length > 0 &&
      refillIds.every((id) => String(id).startsWith("big-")) &&
      autoplayIdsOf(after).length > 0 &&
      sameList(autoplayItemIds(after), autoplayIdsOf(after)) &&
      isAutoplayId(after.queue.items.at(-1)?.id),
    {
      steps,
      refillAt,
      refilledSongs: refillIds.length,
      autoplay: autoplayIdsOf(after),
      queueLength: after.queue.items.length,
    },
  );
}

/** Lines of arlet.log containing text in this E2E run's log directory. */
function logCount(logDir, text) {
  try {
    return (
      readFileSync(join(logDir, "arlet.log"), "utf8").split(text).length - 1
    );
  } catch {
    return 0;
  }
}

/** Waits until arlet.log holds more copies of text than `before`. */
async function logGrew(logDir, text, before) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (logCount(logDir, text) > before) return true;
    await sleep(250);
  }
  return false;
}

/**
 * A refused autoplay station is logged once per Play, 10 s after it, and shows
 * no Autoplay heading. Song ends after the Play arm no further check.
 */
async function checkRefusedStation(page, check, logDir) {
  await repeatOffOnInstance(page);
  await fixtureCall(page, "configure", [{ autoplayStation: "refused" }]);
  const mark = (await snapshot(page)).requests.length;
  const logBefore = logCount(logDir, AUTOPLAY_UNAVAILABLE_LINE);
  const started = await openPlaylistRow(page, 0);
  // The check arms 10 s after the Play; wait past it before reading the log.
  await sleep(AUTOPLAY_LOG_WAIT_MS);
  const logged = await logGrew(logDir, AUTOPLAY_UNAVAILABLE_LINE, logBefore);
  const afterPlay = logCount(logDir, AUTOPLAY_UNAVAILABLE_LINE);
  for (let song = 0; song < PLAYLIST_SIZE; song += 1) {
    await fixtureCall(page, "finishCurrentTrack");
    await sleep(250);
  }
  // A check armed by a song end would fire within 10 s of it; wait past that.
  await sleep(AUTOPLAY_LOG_WAIT_MS);
  const afterSongEnds = logCount(logDir, AUTOPLAY_UNAVAILABLE_LINE);
  const trace = await snapshot(page);
  const station = trace.requests
    .slice(mark)
    .filter(
      (item) =>
        item.method === "POST" &&
        String(item.path).split("?", 1)[0] === STATION_PATH,
    );
  const drawer = await openDrawer(page);
  const ui = await readDrawerAutoplay(page);
  check(
    AUTOPLAY_CHECKS.refused,
    started &&
      logged &&
      afterPlay - logBefore === 1 &&
      afterSongEnds === afterPlay &&
      drawer &&
      !ui.present &&
      ui.toggle === null &&
      ui.userTitles.length === PLAYLIST_SIZE &&
      autoplayItems(trace).length === 0,
    {
      logLines: { before: logBefore, afterPlay, afterSongEnds },
      stationPosts: station.map((item) => ({
        path: item.path,
        status: item.status,
      })),
      drawer,
      ui,
      autoplayIds: autoplayIdsOf(trace),
    },
  );
}

// Check names copied verbatim from docs/TESTING.md ("Shuffle across the collection").
const COLLECTION_CHECKS = {
  onMidAlbum:
    "shuffle on mid-album includes the songs before the one you started from",
  offAlbum: "shuffle off returns to album order after the playing song",
  offDuplicate:
    "shuffle off in a playlist with a song twice continues after the playing occurrence",
  bigList:
    "shuffle on for a list over 500 songs still includes the songs before the start",
};
// The fixture album album-long: six songs, started from its third.
const LONG_ALBUM_ID = "album-long";
const LONG_ALBUM_TITLE = "Long Album";
const LONG_ALBUM_IDS = [
  "long-1",
  "long-2",
  "long-3",
  "long-4",
  "long-5",
  "long-6",
];
const LONG_ALBUM_START = 2;
const LONG_START_ID = "long-3";
const LONG_START_TITLE = "Long Track 3";
const LONG_AFTER_START_IDS = ["long-4", "long-5", "long-6"];
const LONG_AFTER_START_TITLES = [
  "Long Track 4",
  "Long Track 5",
  "Long Track 6",
];
// The fixture playlist with "Duplicate Occurrence" at rows 2 and 4.
const PLAYLIST_ORDER = [
  "song-a",
  "song-duplicate",
  "song-c",
  "song-duplicate",
  "song-e",
  "song-f",
];
const DUPLICATE_OCCURRENCE_INDEX = 3;
const DUPLICATE_TITLE = "Duplicate Occurrence";
// Row 301 of playlist-big (1200 songs) is index 300; ids big-0000 to big-0299
// come before it.
const BIG_START_INDEX = 300;
const BIG_START_TITLE = "Big Track 300";
const BIG_ROW_NUMBER = String(BIG_START_INDEX + 1);
const BIG_ID_PATTERN = /^big-(\d{4})$/u;
// Shuffle walk bound: finished songs to step through while waiting for a refill.
const BIG_WALK_STEPS = 60;

const isEarlyBigId = (id) => {
  const match = BIG_ID_PATTERN.exec(String(id ?? ""));
  return match !== null && Number(match[1]) < BIG_START_INDEX;
};
const upcomingIdsOf = (trace) =>
  trace.queue.items.slice(trace.queue.index + 1).map((item) => item.id);
const bigRowExpression = `[...document.querySelectorAll(".library-track-row")].find((row) => row.querySelector(".library-row-number")?.textContent.trim() === ${q(BIG_ROW_NUMBER)})`;
// Scrolls the song list until the row is rendered; true once it is.
const revealBigRow = `(() => {
  if (${bigRowExpression}) return true;
  const scroller = document.querySelector(".content-scroll");
  const list = document.querySelector(".library-track-list");
  if (!scroller || !list) return false;
  const height =
    list.querySelector(".library-track-row")?.closest("li")?.getBoundingClientRect().height || 65;
  const top =
    list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTop = top + ${BIG_START_INDEX} * height;
  return false;
})()`;

/** Waits until the provider queue's upcoming IDs are exactly `expected`. */
const waitForUpcoming = (page, expected) =>
  waitFor(
    page,
    `(() => { const s = ${FIXTURE}.snapshot(); return JSON.stringify(s.queue.items.slice(s.queue.index + 1).map((item) => item.id)) === JSON.stringify(${q(expected)}); })()`,
  );

/** Waits until the drawer's row titles, in order, are exactly `titles`. */
const drawerTitlesMatch = (titles) =>
  `[...document.querySelectorAll(${q(DRAWER_ROWS)})].map((row) => row.querySelector(".queue-copy strong")?.textContent?.trim() ?? null).join("|") === ${q(titles.join("|"))}`;

/** Opens the Playing Next drawer and waits until it lists `count` rows. */
async function openDrawerRows(page, count) {
  await page.evaluate(`
    if (!document.querySelector(".queue-drawer")) {
      document.querySelector(${q(PLAYING_NEXT_SELECTOR)})?.click();
    }
    return true;`);
  return waitFor(
    page,
    `document.querySelectorAll(${q(DRAWER_ROWS)}).length === ${count}`,
  );
}

/** The drawer's row titles in order, and the index of the row marked current. */
function readDrawerRows(page) {
  return page.evaluate(`
    const list = document.querySelector(".queue-drawer .queue-list");
    const rows = [...document.querySelectorAll(${q(DRAWER_ROWS)})];
    const current = list?.querySelector('[aria-current="true"]')?.closest("li");
    return {
      titles: rows.map((row) => row.querySelector(".queue-copy strong")?.textContent?.trim() ?? null),
      activeIndex: current ? rows.indexOf(current) : -1,
    };`);
}

/** Opens the fixture album from its detail page. */
async function openLongAlbum(page) {
  await page.evaluate(
    `location.hash = ${q(`#/album/${LONG_ALBUM_ID}`)}; return true;`,
  );
  return waitFor(
    page,
    `document.querySelectorAll(".library-track-row").length >= ${LONG_ALBUM_IDS.length} && document.querySelector(".library-detail-hero h1")?.textContent === ${q(LONG_ALBUM_TITLE)}`,
    15_000,
  );
}

/**
 * Album played in order from its third song, then Shuffle on: the songs
 * before the start join the queue, and the start song stays first and playing.
 */
async function checkShuffleOnMidAlbum(page, check) {
  const shuffleOff = await setShuffleTo(page, false);
  const opened = await openLongAlbum(page);
  const at = await transitionCount(page);
  await page.evaluate(
    `document.querySelectorAll(".library-track-row")[${LONG_ALBUM_START}]?.click(); return true;`,
  );
  const queued = await typeSince(page, at, "setQueue");
  const playing = await waitFor(
    page,
    `${PLAY_LABEL} === "Pause" && ${TITLE} === ${q(LONG_START_TITLE)}`,
  );
  const before = await snapshot(page);
  const turned = await setShuffleTo(page, true);
  const allQueued = await waitFor(
    page,
    `(() => { const ids = ${FIXTURE}.snapshot().queue.items.map((item) => item.id); return ${q(LONG_ALBUM_IDS)}.every((id) => ids.includes(id)); })()`,
  );
  const after = await nowPlaying(page);
  const trace = await snapshot(page);
  const ids = idsOf(trace);
  const pressed = await shufflePressed(page);
  check(
    COLLECTION_CHECKS.onMidAlbum,
    shuffleOff &&
      opened &&
      queued &&
      playing &&
      turned &&
      allQueued &&
      LONG_ALBUM_IDS.every((id) => ids.includes(id)) &&
      after.title === LONG_START_TITLE &&
      after.playing &&
      trace.queue.index === 0 &&
      trace.queue.items[0]?.id === LONG_START_ID &&
      trace.queue.activeId === LONG_START_ID &&
      trace.modes.shuffle === true &&
      pressed === "true",
    {
      albumIds: LONG_ALBUM_IDS,
      beforeIds: idsOf(before),
      beforeIndex: before.queue.index,
      queueIds: ids,
      after,
      shuffle: trace.modes.shuffle,
      pressed,
      transitions: await transitionsSince(page, at),
    },
  );
}

/**
 * Shuffle off after the mid-album shuffle: the songs after the playing one
 * are in album order, and the drawer lists the same queue.
 */
async function checkShuffleOffAlbumOrder(page, check) {
  const at = await transitionCount(page);
  const turnedOff = await setShuffleTo(page, false);
  const settled = await waitForUpcoming(page, LONG_AFTER_START_IDS);
  const after = await snapshot(page);
  const now = await nowPlaying(page);
  const pressed = await shufflePressed(page);
  const drawerOpened = await openDrawerRows(page, after.queue.items.length);
  const drawerMatches = await waitFor(page, drawerTitlesMatch(titlesOf(after)));
  const drawer = await readDrawerRows(page);
  await closeDrawer(page);
  check(
    COLLECTION_CHECKS.offAlbum,
    turnedOff &&
      settled &&
      now.title === LONG_START_TITLE &&
      now.playing &&
      after.queue.activeId === LONG_START_ID &&
      sameList(upcomingIdsOf(after), LONG_AFTER_START_IDS) &&
      pressed === "false" &&
      drawerOpened &&
      drawerMatches &&
      drawer.activeIndex === after.queue.index &&
      sameList(
        drawer.titles.slice(drawer.activeIndex + 1),
        LONG_AFTER_START_TITLES,
      ),
    {
      upcomingIds: upcomingIdsOf(after),
      queueIds: idsOf(after),
      index: after.queue.index,
      now,
      pressed,
      drawer,
      transitions: await transitionsSince(page, at),
    },
  );
}

/**
 * A playlist with a song twice, played from the second occurrence: shuffle on
 * and then off keeps every copy, and the songs after the playing occurrence
 * follow the playlist order.
 */
async function checkShuffleOffDuplicate(page, check) {
  const at = await transitionCount(page);
  const shuffleOff = await setShuffleTo(page, false);
  const started = await openPlaylistRow(page, DUPLICATE_OCCURRENCE_INDEX);
  const playing = await nowPlaying(page);
  const turned = await setShuffleTo(page, true);
  const shuffledPlaying = await nowPlaying(page);
  const turnedOff = await setShuffleTo(page, false);
  const expected = PLAYLIST_ORDER.slice(DUPLICATE_OCCURRENCE_INDEX + 1);
  const settled = await waitForUpcoming(page, expected);
  const after = await snapshot(page);
  const now = await nowPlaying(page);
  const pressed = await shufflePressed(page);
  check(
    COLLECTION_CHECKS.offDuplicate,
    shuffleOff &&
      started &&
      playing.title === DUPLICATE_TITLE &&
      turned &&
      shuffledPlaying.title === DUPLICATE_TITLE &&
      turnedOff &&
      settled &&
      sameList(upcomingIdsOf(after), expected) &&
      after.queue.index === DUPLICATE_OCCURRENCE_INDEX &&
      after.queue.activeId === "song-duplicate" &&
      after.queue.items.length === PLAYLIST_ORDER.length &&
      now.title === DUPLICATE_TITLE &&
      now.playing &&
      pressed === "false",
    {
      expectedUpcoming: expected,
      upcomingIds: upcomingIdsOf(after),
      queueIds: idsOf(after),
      index: after.queue.index,
      playing,
      shuffledPlaying,
      now,
      pressed,
      transitions: await transitionsSince(page, at),
    },
  );
}

/**
 * Shuffle on from row 301 of a 1200-song playlist: a song from before the
 * start must be queued, or arrive in a later refill. Walks finished songs with
 * a fixed bound until one does.
 */
async function checkShuffleOnBigList(page, check) {
  const shuffleOff = await setShuffleTo(page, false);
  const repeatOff = await cycleRepeatTo(page, "Repeat off");
  await page.evaluate(
    `location.hash = ${q(`#/playlist/${BIG_PLAYLIST_ID}`)}; return true;`,
  );
  const rowsReady = await waitFor(
    page,
    `document.querySelectorAll(".library-track-row").length >= 3`,
    15_000,
  );
  const revealed = rowsReady && (await waitFor(page, revealBigRow, 20_000));
  const at = await transitionCount(page);
  const clicked =
    revealed &&
    (await page.evaluate(
      `const row = ${bigRowExpression}; row?.click(); return Boolean(row);`,
    ));
  const queued = await typeSince(page, at, "setQueue");
  const playing = await waitFor(
    page,
    `${PLAY_LABEL} === "Pause" && ${TITLE} === ${q(BIG_START_TITLE)}`,
  );
  const shuffleAt = await transitionCount(page);
  const turned = await setShuffleTo(page, true);
  const kept = await nowPlaying(page);
  let queueEarly = [];
  let refilledEarly = [];
  let walked = 0;
  for (let step = 0; step <= BIG_WALK_STEPS; step += 1) {
    const trace = await snapshot(page);
    queueEarly = idsOf(trace).filter(isEarlyBigId);
    refilledEarly = (await transitionsSince(page, shuffleAt))
      .filter((item) => item.type === "playLater")
      .flatMap((item) => item.ids)
      .filter(isEarlyBigId);
    if (queueEarly.length > 0 || refilledEarly.length > 0) break;
    if (step === BIG_WALK_STEPS) break;
    const from = trace.queue.index;
    await fixtureCall(page, "finishCurrentTrack");
    walked += 1;
    await waitFor(page, `${FIXTURE}.snapshot().queue.index !== ${from}`, 2000);
  }
  const reachable = queueEarly.length > 0 || refilledEarly.length > 0;
  const trace = await snapshot(page);
  check(
    COLLECTION_CHECKS.bigList,
    shuffleOff &&
      repeatOff &&
      rowsReady &&
      revealed &&
      clicked &&
      queued &&
      playing &&
      turned &&
      kept.title === BIG_START_TITLE &&
      kept.playing &&
      trace.modes.shuffle === true &&
      reachable,
    {
      rowNumber: BIG_ROW_NUMBER,
      kept,
      walked,
      walkBound: BIG_WALK_STEPS,
      queueEarly: queueEarly.slice(0, 5),
      refilledEarly: refilledEarly.slice(0, 5),
      queueLength: trace.queue.items.length,
      transitionTypes: (await transitionsSince(page, shuffleAt)).map(
        (item) => item.type,
      ),
    },
  );
}

// Check names copied verbatim from docs/TESTING.md ("Audio quality").
const AUDIO_CHECKS = {
  writes:
    "Audio quality High and Standard write MusicKit bitrate 256 and 64 and are saved",
  automatic:
    "Audio quality Automatic leaves MusicKit's bitrate as MusicKit chose it",
  readout: "a MusicKit bitrate change shows in Settings",
};
// Check names copied verbatim from docs/TESTING.md ("Previews only").
const PREVIEW_CHECKS = {
  notice:
    "without a subscription, Arlet shows Previews only with a Subscribe button",
  subscribed: "with a subscription, no Previews only notice shows",
  steady:
    "a subscription recheck keeps Previews only shown while the answer is pending",
  refused: "open_subscribe_link refuses non-Apple and non-https links",
};
const BITRATE_HIGH = 256;
const BITRATE_STANDARD = 64;
const QUALITY_BITRATE = { high: BITRATE_HIGH, standard: BITRATE_STANDARD };
const SUBSCRIPTION_DELAY_MS = 1500;
// Every URL here must be refused. None may reach the browser, so the list holds
// no URL that open_subscribe_link would accept.
const REFUSED_SUBSCRIBE_URLS = [
  "http://finance-app.itunes.apple.com/x",
  "https://apple.com.evil.test/",
  "https://evilapple.com/",
  "https://user:pass@finance-app.itunes.apple.com/",
  "https://finance-app.itunes.apple.com:8443/",
  "https://finance-app.itunes.apple.com/?p=".padEnd(2100, "x"),
  "not a url",
];
const AUDIO_QUALITY_SELECT = `(() => {
  const label = [...document.querySelectorAll("label")].find((node) => node.textContent.includes("Audio quality"));
  return document.querySelector('select[aria-label="Audio quality"]') ?? label?.control ?? label?.querySelector("select") ?? null;
})()`;
const NOTICE_SHOWN = `(() => {
  const notice = document.querySelector(".preview-notice");
  return Boolean(notice?.textContent.includes("Previews only")) && [...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Subscribe");
})()`;
const TITLEBAR_CONNECTED = `document.querySelector(".titlebar-status")?.textContent.includes("Connected") === true`;

const savedSetting = (page, key) =>
  page.evaluate(
    `return JSON.parse(await window.__TAURI_INTERNALS__.invoke("load_settings"))[${q(key)}];`,
  );

/** Saves are asynchronous; poll the settings file until the key reads as expected. */
async function waitForSavedSetting(page, key, value, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await savedSetting(page, key)) === value) return true;
    await sleep(100);
  }
  return false;
}

const bitrateState = async (page) => (await snapshot(page)).bitrate;
const bitrateWritesSince = async (page, at) =>
  (await transitionsSince(page, at))
    .filter((item) => item.type === "bitrate")
    .map((item) => item.value);
const readoutShows = (page, kbps) =>
  waitFor(
    page,
    `document.body.textContent.includes(${q(`Streaming at ${kbps} kbps`)})`,
  );
const readStreamingKbps = (page) =>
  page.evaluate(`
    const match = /Streaming at (\\d+) kbps/u.exec(document.body.textContent ?? "");
    return match ? Number(match[1]) : null;`);

/** Opens Settings and waits for the Audio quality select to render. */
async function openSettingsForAudio(page) {
  await page.evaluate(`location.hash = "#/settings"; return true;`);
  return waitFor(page, `Boolean(${AUDIO_QUALITY_SELECT})`, 8000);
}

/** Picks an Audio quality option the way a user does: set the value, fire change. */
function selectAudioQuality(page, value) {
  return page.evaluate(`
    const select = ${AUDIO_QUALITY_SELECT};
    if (!select) return false;
    select.value = ${q(value)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return select.value === ${q(value)};`);
}

/**
 * Counts hasMusicSubscription() calls on the instance. The app calls it on
 * every subscription re-check, and the fixture does not record those calls.
 */
function installSubscriptionCounter(page) {
  return page.evaluate(`
    const instance = window.MusicKit.getInstance();
    const original = instance.hasMusicSubscription;
    const state = { calls: 0, original };
    window.__ARLET_PARITY_SUBCHECK__ = state;
    instance.hasMusicSubscription = function (...args) {
      state.calls += 1;
      return original.apply(this, args);
    };
    return true;`);
}

/** Restores the instance's hasMusicSubscription and removes the counter. */
function stopSubscriptionCounter(page) {
  return page.evaluate(`
    const state = window.__ARLET_PARITY_SUBCHECK__;
    if (!state) return true;
    window.MusicKit.getInstance().hasMusicSubscription = state.original;
    delete window.__ARLET_PARITY_SUBCHECK__;
    return true;`);
}

const subscriptionCalls = (page) =>
  readPage(page, "window.__ARLET_PARITY_SUBCHECK__?.calls ?? 0");

/**
 * Makes the app re-check the subscription with an authorized
 * authorizationStatusDidChange. No sign-out is involved. Resolves true once a
 * new hasMusicSubscription() call has started.
 */
async function recheckSubscription(page) {
  const before = await subscriptionCalls(page);
  await fixtureCall(page, "emitAuthorizationStatus", [true]);
  return waitFor(
    page,
    `(window.__ARLET_PARITY_SUBCHECK__?.calls ?? 0) > ${before}`,
    4000,
  );
}

/** Signs in through Settings only when the titlebar is not Connected (a safety net for the finally blocks). */
async function ensureSignedInSafetyNet(page) {
  if (await readPage(page, TITLEBAR_CONNECTED)) return true;
  await page.evaluate(`location.hash = "#/settings"; return true;`);
  await waitFor(
    page,
    `[...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Sign in" && !node.disabled)`,
    10_000,
  );
  await page.evaluate(`
    [...document.querySelectorAll("button")]
      .find((node) => node.textContent.trim() === "Sign in")
      ?.click();
    return true;`);
  return waitFor(page, TITLEBAR_CONNECTED, 15_000);
}

/** Counts every sample in which a .preview-notice exists, from mutations and a 20 ms poll. */
function startNoticeWatch(page, { absent = false } = {}) {
  return page.evaluate(`
    const state = { seen: 0, observer: null, timer: 0 };
    const look = () => {
      if (Boolean(document.querySelector(".preview-notice")) !== ${absent}) state.seen += 1;
    };
    state.observer = new MutationObserver(look);
    state.observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    state.timer = setInterval(look, 20);
    window.__ARLET_PARITY_NOTICE__ = state;
    return true;`);
}

/** Stops the notice watch and returns how many samples matched (seen, or missing with `absent`). */
function stopNoticeWatch(page) {
  return page.evaluate(`
    const state = window.__ARLET_PARITY_NOTICE__;
    if (!state) return { seen: -1 };
    state.observer.disconnect();
    clearInterval(state.timer);
    delete window.__ARLET_PARITY_NOTICE__;
    return { seen: state.seen };`);
}

/** High, then Standard, each written to MusicKit and saved. High is left selected. */
async function checkAudioQualityWrites(page, check) {
  await openSettingsForAudio(page);
  const at = await transitionCount(page);
  const steps = {};
  for (const quality of ["standard", "high"]) {
    const selected = await selectAudioQuality(page, quality);
    const written = await waitFor(
      page,
      `${FIXTURE}.snapshot().bitrate.current === ${QUALITY_BITRATE[quality]}`,
    );
    const saved = await waitForSavedSetting(page, "audioQuality", quality);
    steps[quality] = { selected, written, saved };
  }
  const writes = await bitrateWritesSince(page, at);
  check(
    AUDIO_CHECKS.writes,
    Object.values(steps).every(
      (step) => step.selected && step.written && step.saved,
    ) &&
      writes.includes(BITRATE_STANDARD) &&
      writes.includes(BITRATE_HIGH),
    { steps, writes, current: (await bitrateState(page)).current },
  );
}

/**
 * Automatic restores the bitrate MusicKit started with (appStartup), exactly
 * once, and a later MusicKit change then stays as MusicKit set it.
 */
async function checkAutomaticBitrate(page, check, appStartup) {
  // Start from the other value, so Automatic is a real write back to appStartup.
  const pick = appStartup === BITRATE_HIGH ? "standard" : "high";
  const picked = await selectAudioQuality(page, pick);
  await waitFor(
    page,
    `${FIXTURE}.snapshot().bitrate.current === ${QUALITY_BITRATE[pick]}`,
  );
  const at = await transitionCount(page);
  const selected = await selectAudioQuality(page, "automatic");
  const restored = await waitFor(
    page,
    `${FIXTURE}.snapshot().bitrate.current === ${appStartup}`,
  );
  await sleep(500);
  const automaticWrites = await bitrateWritesSince(page, at);
  const saved = await waitForSavedSetting(page, "audioQuality", "automatic");
  // MusicKit changes the bitrate itself. Arlet must not write over it.
  const own = appStartup === BITRATE_STANDARD ? BITRATE_HIGH : BITRATE_STANDARD;
  const later = await transitionCount(page);
  await fixtureCall(page, "emitBitrateChange", [own]);
  await sleep(800);
  const after = await bitrateState(page);
  const strayWrites = (await bitrateWritesSince(page, later)).filter(
    (value) => value !== own,
  );
  check(
    AUDIO_CHECKS.automatic,
    picked &&
      selected &&
      restored &&
      saved &&
      automaticWrites.length === 1 &&
      automaticWrites[0] === appStartup &&
      after.current === own &&
      strayWrites.length === 0,
    { appStartup, pick, automaticWrites, own, after, strayWrites, saved },
  );
}

/** A bitrate MusicKit reports on its own shows in the Streaming readout. */
async function checkReadoutFollowsMusicKit(page, check) {
  const current = (await bitrateState(page)).current;
  const target = current === BITRATE_HIGH ? BITRATE_STANDARD : BITRATE_HIGH;
  await fixtureCall(page, "emitBitrateChange", [target]);
  const shown = await readoutShows(page, target);
  const kbps = await readStreamingKbps(page);
  check(AUDIO_CHECKS.readout, shown && kbps === target, { target, kbps });
}

// A URL the Rust validator refuses (not apple.com). The Subscribe click in the
// check uses it, so the real command can never open a browser from this check.
const SAFE_REFUSED_SUBSCRIBE_URL = "https://example.invalid/";
const ACTION_ERROR_EVENT_NAME = "arlet:action-error";

/**
 * Points the instance's subscribeURL at a URL the validator refuses. The app
 * reads subscribeURL at click time, and the controller's instance is the
 * object window.MusicKit.configure returned (src/musickit/bootstrap.ts), which
 * is the fixture's getInstance() object. Returns the URL the instance now reads.
 */
function overrideSubscribeURL(page) {
  return page.evaluate(`
    const instance = window.MusicKit.getInstance();
    const original = Object.getOwnPropertyDescriptor(instance, "subscribeURL");
    window.__ARLET_PARITY_URL__ = { instance, original };
    Object.defineProperty(instance, "subscribeURL", {
      configurable: true,
      get: () => ${q(SAFE_REFUSED_SUBSCRIBE_URL)},
    });
    return instance.subscribeURL;`);
}

/** Puts back the subscribeURL descriptor that overrideSubscribeURL replaced. */
function restoreSubscribeURL(page) {
  return page.evaluate(`
    const saved = window.__ARLET_PARITY_URL__;
    if (!saved) return true;
    if (saved.original) {
      Object.defineProperty(saved.instance, "subscribeURL", saved.original);
    } else {
      delete saved.instance.subscribeURL;
    }
    delete window.__ARLET_PARITY_URL__;
    return true;`);
}

/** Records each arlet:action-error the app reports until stopActionErrorWatch. */
function startActionErrorWatch(page) {
  return page.evaluate(`
    const messages = [];
    const listener = (event) => messages.push(event.detail);
    window.addEventListener(${q(ACTION_ERROR_EVENT_NAME)}, listener);
    window.__ARLET_PARITY_ERRORS__ = { messages, listener };
    return true;`);
}

/** Stops recording action errors and returns the messages the app reported. */
function stopActionErrorWatch(page) {
  return page.evaluate(`
    const watch = window.__ARLET_PARITY_ERRORS__;
    if (!watch) return [];
    window.removeEventListener(${q(ACTION_ERROR_EVENT_NAME)}, watch.listener);
    delete window.__ARLET_PARITY_ERRORS__;
    return watch.messages;`);
}

/**
 * Without a subscription the notice shows. Subscribe is clicked only while the
 * instance reads a refused URL, and the app's refusal message proves the click
 * reached open_subscribe_link. The real subscribe link is never opened.
 */
async function checkUnsubscribedNotice(page, check) {
  await fixtureCall(page, "configure", [
    { subscription: false, subscriptionDelayMs: 0 },
  ]);
  const rechecked = await recheckSubscription(page);
  const shown = await waitFor(page, NOTICE_SHOWN, 8000);
  const state = {
    urlNow: null,
    overridden: false,
    buttons: 0,
    reported: false,
  };
  let messages = [];
  try {
    state.urlNow = await overrideSubscribeURL(page);
    state.overridden = state.urlNow === SAFE_REFUSED_SUBSCRIBE_URL;
    // The click happens only when the override is confirmed in place.
    if (state.overridden && shown) {
      await startActionErrorWatch(page);
      state.buttons = await page.evaluate(`
        const buttons = [...document.querySelectorAll(".preview-notice button")]
          .filter((node) => node.textContent.trim() === "Subscribe");
        buttons[0]?.click();
        return buttons.length;`);
      state.reported = await waitFor(
        page,
        `(window.__ARLET_PARITY_ERRORS__?.messages.length ?? 0) > 0`,
        6000,
      );
    }
  } finally {
    messages = await stopActionErrorWatch(page);
    await restoreSubscribeURL(page);
  }
  const refusal =
    messages.find((message) => /^Subscribe link must /u.test(message)) ?? null;
  const subscription = (await snapshot(page)).subscription;
  check(
    PREVIEW_CHECKS.notice,
    rechecked &&
      shown &&
      subscription?.previewOnly === true &&
      state.overridden &&
      state.buttons > 0 &&
      state.reported &&
      refusal !== null,
    { rechecked, shown, subscription, state, messages, refusal },
  );
}

/**
 * Without a subscription, a recheck (each SUBSCRIPTION_REQUIRED error starts
 * one) keeps the notice up while it is pending instead of hiding it.
 */
async function checkRecheckKeepsNotice(page, check) {
  await fixtureCall(page, "configure", [
    { subscription: false, subscriptionDelayMs: SUBSCRIPTION_DELAY_MS },
  ]);
  const shownBefore = await waitFor(page, NOTICE_SHOWN, 4000);
  let watch = { seen: -1 };
  let rechecked = false;
  await startNoticeWatch(page, { absent: true });
  try {
    rechecked = await recheckSubscription(page);
    await sleep(SUBSCRIPTION_DELAY_MS + 800);
  } finally {
    watch = await stopNoticeWatch(page);
  }
  const shownAfter = await readPage(page, NOTICE_SHOWN);
  check(
    PREVIEW_CHECKS.steady,
    shownBefore && rechecked && watch.seen === 0 && shownAfter === true,
    { shownBefore, rechecked, missingSamples: watch.seen, shownAfter },
  );
}

/** With a subscription, the notice never appears, not even while the check is pending. */
async function checkSubscribedNoNotice(page, check) {
  await fixtureCall(page, "configure", [
    { subscription: true, subscriptionDelayMs: SUBSCRIPTION_DELAY_MS },
  ]);
  let watch = { seen: -1 };
  let rechecked = false;
  // The watch starts before the re-check, so the pending window is covered.
  await startNoticeWatch(page);
  try {
    rechecked = await recheckSubscription(page);
    await sleep(SUBSCRIPTION_DELAY_MS + 800);
  } finally {
    watch = await stopNoticeWatch(page);
  }
  const hidden = await readPage(
    page,
    `!document.querySelector(".preview-notice")`,
  );
  const subscription = (await snapshot(page)).subscription;
  check(
    PREVIEW_CHECKS.subscribed,
    rechecked &&
      watch.seen === 0 &&
      hidden &&
      subscription?.has === true &&
      subscription?.previewOnly === false,
    { rechecked, watch, hidden, subscription },
  );
}

/** Each refused URL must reject through the real open_subscribe_link command. */
async function checkSubscribeLinkRefused(page, check) {
  const results = await page.evaluate(`
    const urls = ${q(REFUSED_SUBSCRIBE_URLS)};
    const out = [];
    for (const url of urls) {
      try {
        await window.__TAURI_INTERNALS__.invoke("open_subscribe_link", { url });
        out.push({ url, accepted: true, error: null });
      } catch (error) {
        out.push({ url, accepted: false, error: String(error?.message ?? error) });
      }
    }
    return out;`);
  check(
    PREVIEW_CHECKS.refused,
    results.length === REFUSED_SUBSCRIBE_URLS.length &&
      results.every((item) => item.accepted === false && Boolean(item.error)),
    { results },
  );
}

/** Runs the MusicKit parity scenarios and writes their trace and screenshot. */
export async function runMusicKitParity({ page, check, logDir, artifactDir }) {
  const modesEnum =
    (await readPage(page, "window.MusicKit?.PlayerRepeatMode")) ?? {};
  const traces = {};
  await fixtureCall(page, "reset");

  await group(check, "Repeat", async () => {
    const at = await transitionCount(page);
    try {
      const started = await startPlaylist(page);
      if (!started) {
        for (const name of Object.values(REPEAT_CHECKS)) {
          check(name, false, { started });
        }
        return;
      }
      await checkRepeatWrites(page, check, modesEnum);
      await checkRepeatOneReplays(page, check, modesEnum);
      await checkRepeatOneNext(page, check, modesEnum);
      await checkRepeatOnePrevious(page, check, modesEnum);
      await checkRepeatAllWraps(page, check, modesEnum);
    } finally {
      traces.repeat = await transitionsSince(page, at);
      await saveScreenshot(
        page,
        join(artifactDir, "screenshot-musickit-parity-repeat.png"),
      );
    }
  });

  await group(check, "Shuffle model", async () => {
    const at = await transitionCount(page);
    try {
      await guarded(check, SHUFFLE_CHECKS.onKeepsSong, () =>
        checkShuffleOnKeepsSong(page, check),
      );
      await guarded(check, SHUFFLE_CHECKS.playStarts, () =>
        checkShuffledPlay(page, check),
      );
      await guarded(check, SHUFFLE_CHECKS.parkedResume, () =>
        checkParkedResume(page, check),
      );
      await guarded(check, SHUFFLE_CHECKS.offKeeps, () =>
        checkShuffleOffKeepsOrder(page, check),
      );
      await guarded(check, SHUFFLE_CHECKS.rebuildKeeps, () =>
        checkRebuildKeepsEditedOrder(page, check),
      );
      await guarded(check, SHUFFLE_CHECKS.selectionKeeps, () =>
        checkSelectionKeepsHeldOrder(page, check),
      );
    } finally {
      traces.shuffleModel = await transitionsSince(page, at);
      await saveScreenshot(
        page,
        join(artifactDir, "screenshot-musickit-parity-shuffle.png"),
      );
    }
  });

  await group(check, "Selection and stations", async () => {
    const at = await transitionCount(page);
    try {
      await guarded(check, SELECTION_CHECKS.selection, () =>
        checkSelectionKeepsPlayer(page, check),
      );
      await guarded(check, SELECTION_CHECKS.modes, () =>
        checkStationHidesModes(page, check),
      );
      await guarded(check, SELECTION_CHECKS.playNext, () =>
        checkStationPlayNext(page, check),
      );
    } finally {
      traces.selectionStation = await transitionsSince(page, at);
      await saveScreenshot(
        page,
        join(artifactDir, "screenshot-musickit-parity-station.png"),
      );
      // Leave a playlist queue behind so the next groups and cleanup work.
      await openPlaylistRow(page, 0);
    }
  });

  await group(check, "Autoplay", async () => {
    const at = await transitionCount(page);
    try {
      await guarded(check, AUTOPLAY_CHECKS.shows, () =>
        checkAutoplayShows(page, check),
      );
      await guarded(check, AUTOPLAY_CHECKS.playLater, () =>
        checkPlayLaterOrder(page, check),
      );
      await guarded(check, AUTOPLAY_CHECKS.clear, () =>
        checkClearKeepsAutoplay(page, check),
      );
      await guarded(check, AUTOPLAY_CHECKS.repeat, () =>
        checkRepeatRemovesAutoplay(page, check, modesEnum),
      );
      await guarded(check, AUTOPLAY_CHECKS.toggle, () =>
        checkAutoplayToggle(page, check),
      );
      await guarded(check, AUTOPLAY_CHECKS.modes, () =>
        checkModesDisabledOnAutoplay(page, check),
      );
      await guarded(check, AUTOPLAY_CHECKS.saved, () =>
        checkSavedPaths(page, check),
      );
      await guarded(check, AUTOPLAY_CHECKS.refill, () =>
        checkRefillCountsUserSongs(page, check),
      );
      await guarded(check, AUTOPLAY_CHECKS.refused, () =>
        checkRefusedStation(page, check, logDir),
      );
    } finally {
      traces.autoplay = await transitionsSince(page, at);
      await saveScreenshot(
        page,
        join(artifactDir, "screenshot-musickit-parity-autoplay.png"),
      );
      await closeDrawer(page);
      // Autoplay back on through Settings if the toggle check left it off.
      if ((await savedAutoplay(page)) !== true) {
        await setAutoplaySetting(page, true);
      }
      await cycleRepeatTo(page, "Repeat off");
      await fixtureCall(page, "reset");
      await fixtureCall(page, "configure", [{ autoplayStation: "refused" }]);
    }
  });

  await group(check, "Shuffle across the collection", async () => {
    const at = await transitionCount(page);
    try {
      await guarded(check, COLLECTION_CHECKS.onMidAlbum, () =>
        checkShuffleOnMidAlbum(page, check),
      );
      await guarded(check, COLLECTION_CHECKS.offAlbum, () =>
        checkShuffleOffAlbumOrder(page, check),
      );
      await guarded(check, COLLECTION_CHECKS.offDuplicate, () =>
        checkShuffleOffDuplicate(page, check),
      );
      await guarded(check, COLLECTION_CHECKS.bigList, () =>
        checkShuffleOnBigList(page, check),
      );
    } finally {
      traces.shuffleCollection = await transitionsSince(page, at);
      await saveScreenshot(
        page,
        join(artifactDir, "screenshot-musickit-parity-collection.png"),
      );
      await closeDrawer(page);
      await cycleRepeatTo(page, "Repeat off");
      await setShuffleTo(page, false);
    }
  });

  await group(check, "Audio quality", async () => {
    const at = await transitionCount(page);
    // Read before Arlet writes anything: the bitrate Automatic must restore.
    const appStartup = (await bitrateState(page)).current;
    try {
      await guarded(check, AUDIO_CHECKS.writes, () =>
        checkAudioQualityWrites(page, check),
      );
      await guarded(check, AUDIO_CHECKS.automatic, () =>
        checkAutomaticBitrate(page, check, appStartup),
      );
      await guarded(check, AUDIO_CHECKS.readout, () =>
        checkReadoutFollowsMusicKit(page, check),
      );
    } finally {
      traces.audioQuality = await transitionsSince(page, at);
      // Leave High selected, as the group found the app's startup default.
      await openSettingsForAudio(page);
      await selectAudioQuality(page, "high");
      await waitFor(
        page,
        `${FIXTURE}.snapshot().bitrate.current === ${BITRATE_HIGH}`,
      );
      await waitForSavedSetting(page, "audioQuality", "high");
    }
  });

  await group(check, "Previews only", async () => {
    const at = await transitionCount(page);
    await installSubscriptionCounter(page);
    try {
      // First, while the account is still a subscriber: a recheck keeps the
      // known status, so the notice must never appear.
      await guarded(check, PREVIEW_CHECKS.subscribed, () =>
        checkSubscribedNoNotice(page, check),
      );
      await guarded(check, PREVIEW_CHECKS.notice, () =>
        checkUnsubscribedNotice(page, check),
      );
      // Captured while the notice is up, before the finally block clears it.
      await saveScreenshot(
        page,
        join(artifactDir, "screenshot-musickit-parity-preview.png"),
      );
      await guarded(check, PREVIEW_CHECKS.steady, () =>
        checkRecheckKeepsNotice(page, check),
      );
    } finally {
      // Restore a subscriber and re-check, so the notice clears for later groups.
      await fixtureCall(page, "configure", [
        { subscription: true, subscriptionDelayMs: 0 },
      ]);
      await fixtureCall(page, "emitAuthorizationStatus", [true]);
      await waitFor(page, `!document.querySelector(".preview-notice")`, 4000);
      await stopSubscriptionCounter(page);
      traces.preview = await transitionsSince(page, at);
      await ensureSignedInSafetyNet(page);
    }
    // Calls the real command with refused URLs only, so none opens a browser.
    await guarded(check, PREVIEW_CHECKS.refused, () =>
      checkSubscribeLinkRefused(page, check),
    );
  });

  try {
    await cycleRepeatTo(page, "Repeat off");
    if (!(await setShuffleTo(page, false))) {
      throw new Error("Shuffle did not turn off through the player bar");
    }
  } finally {
    await writeFile(
      join(artifactDir, "musickit-parity-trace.json"),
      `${JSON.stringify(traces, null, 2)}\n`,
    );
    await page.evaluate(
      'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;',
    );
    await fixtureCall(page, "reset");
  }
}
