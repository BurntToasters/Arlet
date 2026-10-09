#!/usr/bin/env node

const PLAYLIST_ID = "playlist-1";
const PLAYER_TITLE = `document.querySelector(".player-bar .player-track-copy strong")?.textContent`;
const DRAWER_ROWS = `document.querySelectorAll(".queue-drawer .queue-list > li:not([aria-hidden])")`;
const SHUFFLE_BUTTON = `document.querySelector('button[aria-label="Toggle shuffle"]')`;
const MUSIC_TRANSITION_TYPES = ["setQueue", "selectIndex", "play", "pause"];

async function waitFor(page, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(`return Boolean(${expression});`)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function snapshotOf(page) {
  return page.evaluate("return window.__ARLET_E2E_MUSIC__.snapshot();");
}

function ids(snapshot) {
  return snapshot.queue?.items?.map((item) => item.id) ?? [];
}

function sameIds(actual, expected) {
  return JSON.stringify(actual ?? []) === JSON.stringify(expected);
}

/** Clicks one control inside a drawer row; true when it exists and is enabled. */
function clickRowControl(index, selector) {
  return `(() => {
    const row = document.querySelectorAll(".queue-drawer .queue-list > li")[${index}];
    const control = row?.querySelector(${JSON.stringify(selector)});
    if (!control || control.disabled) return false;
    control.click();
    return true;
  })()`;
}

/** True once the provider has resumed playback after an edit began at `mark`. */
function rebuildSettled(mark) {
  return `window.__ARLET_E2E_MUSIC__.snapshot().transitions.slice(${mark}).some((item) => item.type === "play")`;
}

async function openDrawer(page) {
  await page.evaluate(`
    if (!document.querySelector(".queue-drawer")) {
      document.querySelector('button[aria-label="Toggle Playing Next"]')?.click();
    }
    return true;
  `);
}

/** Exercises queue edits through the real drawer against the MusicKit fixture. */
export async function runQueueEdit({ page, check }) {
  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.reset();
    location.hash = "#/playlist/${PLAYLIST_ID}";
    return true;
  `);
  const rowsReady = await waitFor(
    page,
    `document.querySelectorAll(".library-track-row").length >= 4`,
  );
  check("queue-edit playlist renders its first page", rowsReady);
  if (!rowsReady) return;

  // Starting at the first song leaves both duplicates upcoming.
  await page.evaluate(`
    document.querySelectorAll(".library-track-row")[0]?.click();
    return true;
  `);
  const started = await waitFor(page, `${PLAYER_TITLE} === "Track A"`);
  await openDrawer(page);
  const drawerReady = await waitFor(page, `${DRAWER_ROWS}.length === 6`);
  check(
    "queue-edit drawer shows the full playlist queue",
    started && drawerReady,
  );
  if (!started || !drawerReady) return;

  // Phase 1, rebuild tier: removing the second duplicate must not remove the first.
  await page.evaluate(
    `window.__ARLET_E2E_MUSIC__.emitPlaybackTime(42); return true;`,
  );
  const mark1 = (await snapshotOf(page)).transitions.length;
  const removed1 = await page.evaluate(
    `return ${clickRowControl(3, '[data-queue-action="remove"]')};`,
  );
  const settled1 = await waitFor(page, rebuildSettled(mark1));
  const afterRemove = await snapshotOf(page);
  const rebuild = afterRemove.transitions.slice(mark1);
  const expectedAfterRemove = [
    "song-a",
    "song-duplicate",
    "song-c",
    "song-e",
    "song-f",
  ];
  check(
    "removing an upcoming duplicate removes only the selected occurrence",
    removed1 &&
      settled1 &&
      sameIds(ids(afterRemove), expectedAfterRemove) &&
      afterRemove.queue.index === 0,
    { ids: ids(afterRemove), index: afterRemove.queue.index },
  );
  const setQueue = rebuild.find((item) => item.type === "setQueue");
  const selectIndex = rebuild.findIndex((item) => item.type === "selectIndex");
  const seek = rebuild.find((item) => item.type === "seekToTime");
  check(
    "rebuild tier sets the queue, reselects the current song, and seeks to the saved position",
    Boolean(setQueue) &&
      sameIds(setQueue.ids, expectedAfterRemove) &&
      rebuild.indexOf(setQueue) < selectIndex &&
      rebuild[selectIndex]?.index === 0 &&
      seek?.seconds === 42 &&
      rebuild.indexOf(seek) > selectIndex &&
      rebuild.at(-1)?.type === "play" &&
      !rebuild.some((item) => item.type === "pause") &&
      PLAYER_TITLE === "Track A",
    { rebuild },
  );

  // Phase 2, shuffle on: a rebuild must write an explicit order with shuffle
  // off, then restore shuffle.
  await page.evaluate(`${SHUFFLE_BUTTON}?.click(); return true;`);
  const shuffleOn = await waitFor(
    page,
    `${SHUFFLE_BUTTON}?.getAttribute("aria-pressed") === "true"`,
  );
  const mark2 = (await snapshotOf(page)).transitions.length;
  const removed2 = await page.evaluate(
    `return ${clickRowControl(4, '[data-queue-action="remove"]')};`,
  );
  const settled2 = await waitFor(page, rebuildSettled(mark2));
  const afterShuffleRemove = await snapshotOf(page);
  const setQueueShuffle = afterShuffleRemove.transitions
    .slice(mark2)
    .find((item) => item.type === "setQueue");
  check(
    "editing with shuffle on keeps the explicit order and restores shuffle",
    shuffleOn &&
      removed2 &&
      settled2 &&
      sameIds(ids(afterShuffleRemove), [
        "song-a",
        "song-duplicate",
        "song-c",
        "song-e",
      ]) &&
      setQueueShuffle?.shuffle === false &&
      afterShuffleRemove.modes.shuffle === true,
    {
      ids: ids(afterShuffleRemove),
      setQueueShuffle: setQueueShuffle?.shuffle,
      modes: afterShuffleRemove.modes,
    },
  );

  // Phase 3, native tier: reorder through native queue methods without
  // rebuilding or restarting the current song.
  await page.evaluate(`${SHUFFLE_BUTTON}?.click(); return true;`);
  await waitFor(
    page,
    `${SHUFFLE_BUTTON}?.getAttribute("aria-pressed") === "false"`,
  );
  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.configure({ nativeQueueEdit: true });
    return true;
  `);
  const mark3 = (await snapshotOf(page)).transitions.length;
  const moved = await page.evaluate(
    `return ${clickRowControl(3, '[data-queue-action="up"]')};`,
  );
  const movedVisible = await waitFor(
    page,
    `document.querySelectorAll(".queue-drawer .queue-list > li")[2]?.querySelector(".queue-copy strong")?.textContent === "Track E"`,
  );
  const afterMove = await snapshotOf(page);
  const sinceMove = afterMove.transitions.slice(mark3);
  check(
    "reorder through native queue methods keeps the current index with no new play transition",
    moved &&
      movedVisible &&
      sameIds(ids(afterMove), [
        "song-a",
        "song-duplicate",
        "song-e",
        "song-c",
      ]) &&
      afterMove.queue.index === 0 &&
      !sinceMove.some((item) => MUSIC_TRANSITION_TYPES.includes(item.type)) &&
      sinceMove.some((item) => item.type === "nativeSplice") &&
      PLAYER_TITLE === "Track A",
    { sinceMove },
  );

  // Phase 4: a provider change during a slow native edit is not overwritten.
  // Removing "Track C" is still upcoming before the track finishes.
  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.configure({ queueEditDelayMs: 400 });
    return true;
  `);
  const mark4 = (await snapshotOf(page)).transitions.length;
  const abortStarted = await page.evaluate(`
    const started = ${clickRowControl(3, '[data-queue-action="remove"]')};
    window.__ARLET_E2E_MUSIC__.finishCurrentTrack();
    return started;
  `);
  const abortToast = await waitFor(
    page,
    `[...document.querySelectorAll(".action-toast-message")].some((node) => node.textContent?.includes("changed"))`,
  );
  const afterAbort = await snapshotOf(page);
  const activeRow = await page.evaluate(`
    const rows = [...document.querySelectorAll(".queue-drawer .queue-list > li")];
    return rows.findIndex((row) => row.querySelector('[aria-current="true"]'));
  `);
  check(
    "a provider track change during a native edit resyncs instead of overwriting",
    abortStarted &&
      abortToast &&
      sameIds(ids(afterAbort), ["song-a", "song-duplicate", "song-e"]) &&
      afterAbort.queue.index === 1 &&
      activeRow === 1 &&
      !afterAbort.transitions
        .slice(mark4)
        .some((item) => item.type === "setQueue"),
    { ids: ids(afterAbort), index: afterAbort.queue.index, activeRow },
  );
  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.configure({
      nativeQueueEdit: false,
      queueEditDelayMs: 0,
    });
    return true;
  `);

  // Phase 5, rebuild tier: history and the current song are locked, and Clear
  // keeps the current song playing.
  const locks = await page.evaluate(`
    const rows = document.querySelectorAll(".queue-drawer .queue-list > li");
    const controlsIn = (row) => row?.querySelectorAll("[data-queue-action]").length ?? -1;
    return {
      history: controlsIn(rows[0]),
      current: controlsIn(rows[1]),
      upcoming: controlsIn(rows[2]),
    };
  `);
  const mark5 = (await snapshotOf(page)).transitions.length;
  const cleared = await page.evaluate(`
    const button = document.querySelector('button[aria-label="Clear up next"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  `);
  const clearSettled = await waitFor(
    page,
    `${rebuildSettled(mark5)} && ${DRAWER_ROWS}.length === 2`,
  );
  const afterClear = await snapshotOf(page);
  const sinceClear = afterClear.transitions.slice(mark5);
  check(
    "history and the current song have no edit controls",
    locks.history === 0 && locks.current === 0 && locks.upcoming === 3,
    locks,
  );
  check(
    "Clear removes upcoming songs and keeps the current song playing",
    cleared &&
      clearSettled &&
      sameIds(ids(afterClear), ["song-a", "song-duplicate"]) &&
      afterClear.queue.index === 1 &&
      PLAYER_TITLE === "Duplicate Occurrence" &&
      !sinceClear.some((item) => item.type === "pause") &&
      sinceClear.at(-1)?.type === "play",
    { sinceClear },
  );

  // Phase 6: a 600-song queue renders only the visible window.
  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.seedQueue(600);
    return true;
  `);
  const windowed = await waitFor(
    page,
    `document.querySelectorAll(".queue-drawer .queue-list > li[aria-hidden]").length === 2`,
  );
  const renderedRows = await page.evaluate(`return ${DRAWER_ROWS}.length;`);
  check(
    "a 600-song queue renders fewer than 100 drawer rows",
    windowed && renderedRows > 0 && renderedRows < 100,
    { renderedRows },
  );
}
