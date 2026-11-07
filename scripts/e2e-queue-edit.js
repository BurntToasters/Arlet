#!/usr/bin/env node

import { fixtureCall, waitFor as pollFor } from "./e2e-helpers.js";

const PLAYLIST_ID = "playlist-1";
const PLAYER_TITLE = `document.querySelector(".player-bar .player-track-copy strong")?.textContent`;
const PLAY_LABEL = `document.querySelector(".play-button")?.getAttribute("aria-label")`;
const DRAWER_ROWS = `document.querySelectorAll(".queue-drawer .queue-list > li:not([aria-hidden])")`;
const SHUFFLE_BUTTON = `document.querySelector('button[aria-label="Toggle shuffle"]')`;
const MUSIC_TRANSITION_TYPES = ["setQueue", "selectIndex", "play", "pause"];

const waitFor = (page, expression, timeoutMs = 10_000) =>
  pollFor(page, expression, timeoutMs, 100);

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

/**
 * Makes sure the drawer shows `rowCount` rows, reopening it when it is closed.
 * The drawer has closed between phases in some runs with no edit made, so each
 * drawer-dependent step checks it and reopens it, and reports how often.
 */
async function ensureDrawer(page, rowCount) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (
      await waitFor(
        page,
        `document.querySelectorAll(".queue-drawer .queue-list > li").length === ${rowCount}`,
        1500,
      )
    ) {
      return attempt;
    }
    await page.evaluate(`
      if (!document.querySelector(".queue-drawer .queue-list")) {
        document.querySelector('button[aria-label="Toggle Playing Next"]')?.click();
      }
      return true;
    `);
  }
  await waitFor(
    page,
    `document.querySelectorAll(".queue-drawer .queue-list > li").length === ${rowCount}`,
  );
  return 3;
}

async function openDrawer(page) {
  await page.evaluate(`
    if (!document.querySelector(".queue-drawer")) {
      document.querySelector('button[aria-label="Toggle Playing Next"]')?.click();
    }
    return true;
  `);
}

/** Drawer song IDs in drawer order (MusicKit's order), history rows included. */
const DRAWER_IDS = `[...document.querySelectorAll(".queue-drawer .queue-list > li .queue-row-shell")].map((node) => node.getAttribute("data-context-id"))`;

async function drawerIds(page) {
  return page.evaluate(`return ${DRAWER_IDS};`);
}

/**
 * Clicks one control in the drawer row of a song ID. Rows are found by ID,
 * because MusicKit's shuffled order sets their positions.
 */
function clickRowControlById(songId, selector) {
  return `(() => {
    const shell = [...document.querySelectorAll(".queue-drawer .queue-list > li .queue-row-shell")]
      .find((node) => node.getAttribute("data-context-id") === ${JSON.stringify(songId)});
    const control = shell?.querySelector(${JSON.stringify(selector)});
    if (!control || control.disabled) return false;
    control.click();
    return true;
  })()`;
}

/** The list with one song moved one place up (a native move is an adjacent swap). */
function moveUp(list, id) {
  const next = [...list];
  const at = next.indexOf(id);
  [next[at - 1], next[at]] = [next[at], next[at - 1]];
  return next;
}

/** Describes a DOM node for diagnostics: its nearest button or labelled element. */
const DESCRIBE_NODE = `(node) => {
  const el = node?.closest?.("button,[aria-label],[class]") ?? node;
  return el
    ? {
        tag: el.tagName ?? null,
        label: el.getAttribute?.("aria-label") ?? null,
        cls: String(el.className?.baseVal ?? el.className ?? "").slice(0, 80),
      }
    : null;
}`;

/** Exercises queue edits through the real drawer against the MusicKit fixture. */
export async function runQueueEdit({ page, check }) {
  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.reset();
    location.hash = "#/playlist/${PLAYLIST_ID}";
    return true;
  `);
  // The hero confirms these rows are the playlist's, not the previous page's.
  const rowsReady = await waitFor(
    page,
    `document.querySelector(".library-detail-hero") && document.querySelectorAll(".library-track-row").length >= 4 && document.querySelector(".library-track-row")?.textContent.includes("Track A")`,
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
      (await page.evaluate(`return ${PLAYER_TITLE};`)) === "Track A",
    { rebuild },
  );

  // Phase 2, shuffle on: a rebuild writes the order the drawer shows (MusicKit's
  // shuffled order) with MusicKit's shuffle held off. The UI still reports
  // Shuffle on, so the keep-order lease holds the order without reshuffling.
  await page.evaluate(`${SHUFFLE_BUTTON}?.click(); return true;`);
  const shuffleOn = await waitFor(
    page,
    `${SHUFFLE_BUTTON}?.getAttribute("aria-pressed") === "true"`,
  );
  const drawerReopens2 = await ensureDrawer(page, 5);
  const beforeShuffleRemove = await snapshotOf(page);
  const shuffledDrawer = await drawerIds(page);
  const mark2 = beforeShuffleRemove.transitions.length;
  const removed2 = await page.evaluate(
    `return ${clickRowControlById("song-e", '[data-queue-action="remove"]')};`,
  );
  const settled2 = await waitFor(page, rebuildSettled(mark2));
  const afterShuffleRemove = await snapshotOf(page);
  const afterShuffleDrawer = await drawerIds(page);
  const setQueueShuffle = afterShuffleRemove.transitions
    .slice(mark2)
    .find((item) => item.type === "setQueue");
  const shuffleUiPressed = await page.evaluate(
    `return ${SHUFFLE_BUTTON}?.getAttribute("aria-pressed") ?? null;`,
  );
  const keptOrder = ids(beforeShuffleRemove).filter((id) => id !== "song-e");
  check(
    "editing with shuffle on keeps the explicit order and restores shuffle",
    shuffleOn &&
      removed2 &&
      settled2 &&
      sameIds(shuffledDrawer, ids(beforeShuffleRemove)) &&
      sameIds(setQueueShuffle?.ids, keptOrder) &&
      setQueueShuffle?.shuffle === false &&
      sameIds(ids(afterShuffleRemove), keptOrder) &&
      sameIds(afterShuffleDrawer, ids(afterShuffleRemove)) &&
      afterShuffleRemove.modes.shuffle === false &&
      shuffleUiPressed === "true",
    {
      keptOrder,
      drawerBeforeEdit: shuffledDrawer,
      setQueue: setQueueShuffle,
      ids: ids(afterShuffleRemove),
      drawerAfterEdit: afterShuffleDrawer,
      modes: afterShuffleRemove.modes,
      shuffleUiPressed,
    },
  );

  // Phase 3, native tier: turning shuffle off ends the lease without reordering
  // (MusicKit is already off). A native move then keeps the current index.
  await page.evaluate(`${SHUFFLE_BUTTON}?.click(); return true;`);
  await waitFor(
    page,
    `${SHUFFLE_BUTTON}?.getAttribute("aria-pressed") === "false"`,
  );
  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.configure({ nativeQueueEdit: true });
    return true;
  `);
  const drawerReopens3 = await ensureDrawer(page, 4);
  const beforeMove = await snapshotOf(page);
  const mark3 = beforeMove.transitions.length;
  const movedId = ids(beforeMove).at(-1);
  const expectedMoved = moveUp(ids(beforeMove), movedId);
  const moved = await page.evaluate(
    `return ${clickRowControlById(movedId, '[data-queue-action="up"]')};`,
  );
  const movedVisible = await waitFor(
    page,
    `JSON.stringify(${DRAWER_IDS}) === ${JSON.stringify(JSON.stringify(expectedMoved))}`,
  );
  const afterMove = await snapshotOf(page);
  const sinceMove = afterMove.transitions.slice(mark3);
  check(
    "reorder through native queue methods keeps the current index with no new play transition",
    moved &&
      movedVisible &&
      sameIds(ids(afterMove), expectedMoved) &&
      sameIds(await drawerIds(page), expectedMoved) &&
      afterMove.queue.index === 0 &&
      !sinceMove.some((item) => MUSIC_TRANSITION_TYPES.includes(item.type)) &&
      sinceMove.some((item) => item.type === "nativeSplice") &&
      (await page.evaluate(`return ${PLAYER_TITLE};`)) === "Track A",
    { movedId, expectedMoved, sinceMove },
  );

  // Phase 4: a provider change during a slow native edit is not overwritten.
  // A middle upcoming song (neither the current song nor the last) is removed
  // while the current track finishes.
  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.configure({ queueEditDelayMs: 400 });
    return true;
  `);
  const drawerReopens4 = await ensureDrawer(page, 4);
  const beforeAbort = await snapshotOf(page);
  const drawerBeforeAbort = await page.evaluate(
    `return Boolean(document.querySelector(".queue-drawer"));`,
  );
  const mark4 = beforeAbort.transitions.length;
  const abortedIndex = Math.floor(ids(beforeAbort).length / 2);
  const abortedId = ids(beforeAbort)[abortedIndex];
  const abortedMiddle =
    abortedIndex > 0 && abortedIndex < ids(beforeAbort).length - 1;
  const expectedAfterAbort = ids(beforeAbort).filter((id) => id !== abortedId);
  // Diagnostic listeners, removed after the check: which element had focus,
  // every click and key with its target, and when the drawer left the DOM.
  const focusBefore = await page.evaluate(`
    const describe = ${DESCRIBE_NODE};
    const events = [];
    const diag = { events, drawerGone: null, onClick: null, onKey: null, observer: null };
    const wasOpen = Boolean(document.querySelector(".queue-drawer"));
    diag.onClick = (e) => events.push({ t: Math.round(performance.now()), type: "click", target: describe(e.target) });
    diag.onKey = (e) => events.push({ t: Math.round(performance.now()), type: "keydown", key: e.key, target: describe(e.target) });
    window.addEventListener("click", diag.onClick, true);
    window.addEventListener("keydown", diag.onKey, true);
    diag.observer = new MutationObserver(() => {
      if (wasOpen && !diag.drawerGone && !document.querySelector(".queue-drawer")) {
        diag.drawerGone = { t: Math.round(performance.now()), lastEvent: events.at(-1) ?? null, activeElement: describe(document.activeElement) };
      }
    });
    diag.observer.observe(document.body, { childList: true, subtree: true });
    window.__ABORT_DIAG__ = diag;
    return describe(document.activeElement);
  `);
  const abortStarted = await page.evaluate(`
    const started = ${clickRowControlById(abortedId, '[data-queue-action="remove"]')};
    window.__ARLET_E2E_MUSIC__.finishCurrentTrack();
    return started;
  `);
  const abortToast = await waitFor(
    page,
    `[...document.querySelectorAll(".action-toast-message")].some((node) => node.textContent?.includes("changed"))`,
  );
  const afterAbort = await snapshotOf(page);
  const drawerAfterAbort = await page.evaluate(
    `return Boolean(document.querySelector(".queue-drawer"));`,
  );
  const activeRow = await page.evaluate(`
    const rows = [...document.querySelectorAll(".queue-drawer .queue-list > li")];
    return rows.findIndex((row) => row.querySelector('[aria-current="true"]'));
  `);
  const abortDiagnostic = await page.evaluate(`
    const describe = ${DESCRIBE_NODE};
    const diag = window.__ABORT_DIAG__ ?? {};
    return {
      events: diag.events ?? [],
      drawerGone: diag.drawerGone ?? null,
      focusAfter: describe(document.activeElement),
    };
  `);
  check(
    "a provider track change during a native edit resyncs instead of overwriting",
    abortStarted &&
      abortToast &&
      abortedMiddle &&
      sameIds(ids(afterAbort), expectedAfterAbort) &&
      afterAbort.queue.index === 1 &&
      afterAbort.queue.activeId === expectedAfterAbort[1] &&
      activeRow === 1 &&
      !afterAbort.transitions
        .slice(mark4)
        .some((item) => item.type === "setQueue"),
    {
      abortedId,
      abortedIndex,
      abortedMiddle,
      expectedAfterAbort,
      ids: ids(afterAbort),
      index: afterAbort.queue.index,
      activeRow,
      drawerBeforeAbort,
      drawerAfterAbort,
      focusBefore,
      diagnostic: abortDiagnostic,
    },
  );
  await page.evaluate(`
    const diag = window.__ABORT_DIAG__ ?? {};
    window.removeEventListener("click", diag.onClick, true);
    window.removeEventListener("keydown", diag.onKey, true);
    diag.observer?.disconnect();
    delete window.__ABORT_DIAG__;
    return true;
  `);
  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.configure({
      nativeQueueEdit: false,
      queueEditDelayMs: 0,
    });
    return true;
  `);

  // Phase 5, rebuild tier: history and the current song are locked, and Clear
  // keeps the current song playing. Native edits are off, so Clear rebuilds the
  // queue as history plus the current song.
  // The drawer can close during the native edit above, so reopen it for the
  // rebuild-tier checks and record that it was closed.
  const drawerClosedBeforePhase5 = !(await page.evaluate(
    `return Boolean(document.querySelector(".queue-drawer"));`,
  ));
  await openDrawer(page);
  await waitFor(
    page,
    `${DRAWER_ROWS}.length === ${ids(await snapshotOf(page)).length}`,
  );
  const locks = await page.evaluate(`
    const rows = document.querySelectorAll(".queue-drawer .queue-list > li");
    const controlsIn = (row) => row?.querySelectorAll("[data-queue-action]").length ?? -1;
    return {
      history: controlsIn(rows[0]),
      current: controlsIn(rows[1]),
      upcoming: controlsIn(rows[2]),
    };
  `);
  const beforeClear = await snapshotOf(page);
  const currentAtClear = beforeClear.queue.index;
  const keptAfterClear = ids(beforeClear).slice(0, currentAtClear + 1);
  const mark5 = beforeClear.transitions.length;
  const cleared = await page.evaluate(`
    const button = document.querySelector('button[aria-label="Clear up next"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  `);
  const clearSettled = await waitFor(
    page,
    `${rebuildSettled(mark5)} && ${DRAWER_ROWS}.length === ${keptAfterClear.length}`,
  );
  const afterClear = await snapshotOf(page);
  const sinceClear = afterClear.transitions.slice(mark5);
  const clearRebuild = sinceClear.find((item) => item.type === "setQueue");
  check(
    "history and the current song have no edit controls",
    locks.history === 0 && locks.current === 0 && locks.upcoming === 3,
    locks,
  );
  check(
    "Clear removes upcoming songs and keeps the current song playing",
    cleared &&
      clearSettled &&
      sameIds(clearRebuild?.ids, keptAfterClear) &&
      sameIds(ids(afterClear), keptAfterClear) &&
      afterClear.queue.index === currentAtClear &&
      (await page.evaluate(`return ${PLAYER_TITLE};`)) ===
        beforeClear.queue.items[currentAtClear]?.title &&
      !sinceClear.some((item) => item.type === "pause") &&
      sinceClear.at(-1)?.type === "play",
    {
      keptAfterClear,
      sinceClear,
      drawerClosedBeforePhase5,
      drawerReopens2,
      drawerReopens3,
      drawerReopens4,
    },
  );

  // Phase 6: a pause during setQueue keeps the edit but does not resume audio.
  await page.evaluate(`window.__ARLET_E2E_MUSIC__.seedQueue(6); return true;`);
  const sixRowsReady = await waitFor(
    page,
    `${DRAWER_ROWS}.length === 6 && ${PLAY_LABEL} === "Pause"`,
  );
  const mark6 = (await snapshotOf(page)).transitions.length;
  await fixtureCall(page, "configure", [{ holdSetQueue: true }]);
  // Row index is the queue index, so row 1 is bulk-1 (the expected removal).
  const removeDuringPause = await page.evaluate(
    `return ${clickRowControl(1, '[data-queue-action="remove"]')};`,
  );
  const pauseQueueHeld = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().queueEdit.setQueueHeld === 1`,
  );
  const pauseClicked = await page.evaluate(`
    const button = document.querySelector(".play-button");
    if (button?.getAttribute("aria-label") !== "Pause") return false;
    button.click();
    return true;
  `);
  const pausedDuringRebuild = await waitFor(page, `${PLAY_LABEL} === "Play"`);
  let releasedForPause = 0;
  try {
    releasedForPause = await fixtureCall(page, "releaseSetQueue");
  } finally {
    releasedForPause = Math.max(
      releasedForPause,
      await fixtureCall(page, "releaseSetQueue"),
    );
    await fixtureCall(page, "configure", [{ holdSetQueue: false }]);
  }
  const pauseEditSettled = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().queue.items.length === 5 && window.__ARLET_E2E_MUSIC__.snapshot().transitions.slice(${mark6}).some((item) => item.type === "seekToTime") && ${PLAY_LABEL} === "Play"`,
  );
  const afterPauseEdit = await snapshotOf(page);
  const pauseEditTransitions = afterPauseEdit.transitions.slice(mark6);
  const pauseTransitionIndex = pauseEditTransitions.findIndex(
    (item) => item.type === "pause",
  );
  check(
    "a newer Pause keeps a successful queue rebuild paused",
    sixRowsReady &&
      removeDuringPause &&
      pauseQueueHeld &&
      pauseClicked &&
      pausedDuringRebuild &&
      releasedForPause === 1 &&
      pauseEditSettled &&
      sameIds(ids(afterPauseEdit), [
        "bulk-0",
        "bulk-2",
        "bulk-3",
        "bulk-4",
        "bulk-5",
      ]) &&
      !pauseEditTransitions
        .slice(pauseTransitionIndex + 1)
        .some((item) => item.type === "play"),
    {
      sixRowsReady,
      removeDuringPause,
      pauseQueueHeld,
      pauseClicked,
      pausedDuringRebuild,
      releasedForPause,
      pauseEditSettled,
      transitions: pauseEditTransitions,
      ids: ids(afterPauseEdit),
    },
  );

  // Phase 7: a Play pressed during a paused rebuild stays the last word.
  const mark7 = (await snapshotOf(page)).transitions.length;
  await fixtureCall(page, "configure", [{ holdSetQueue: true }]);
  const removeDuringPlay = await page.evaluate(
    `return ${clickRowControl(2, '[data-queue-action="remove"]')};`,
  );
  const playQueueHeld = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().queueEdit.setQueueHeld === 1`,
  );
  const playClicked = await page.evaluate(`
    const button = document.querySelector(".play-button");
    if (button?.getAttribute("aria-label") !== "Play") return false;
    button.click();
    return true;
  `);
  const playingDuringRebuild = await waitFor(page, `${PLAY_LABEL} === "Pause"`);
  let releasedForPlay = 0;
  try {
    releasedForPlay = await fixtureCall(page, "releaseSetQueue");
  } finally {
    releasedForPlay = Math.max(
      releasedForPlay,
      await fixtureCall(page, "releaseSetQueue"),
    );
    await fixtureCall(page, "configure", [{ holdSetQueue: false }]);
  }
  const playEditSettled = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().queue.items.length === 4 && window.__ARLET_E2E_MUSIC__.snapshot().transitions.slice(${mark7}).some((item) => item.type === "seekToTime") && ${PLAY_LABEL} === "Pause"`,
  );
  const afterPlayEdit = await snapshotOf(page);
  const playEditTransitions = afterPlayEdit.transitions.slice(mark7);
  const playTransitionIndex = playEditTransitions.findIndex(
    (item) => item.type === "play",
  );
  check(
    "a newer Play keeps a successful queue rebuild playing",
    removeDuringPlay &&
      playQueueHeld &&
      playClicked &&
      playingDuringRebuild &&
      releasedForPlay === 1 &&
      playEditSettled &&
      sameIds(ids(afterPlayEdit), ["bulk-0", "bulk-2", "bulk-4", "bulk-5"]) &&
      !playEditTransitions
        .slice(playTransitionIndex + 1)
        .some((item) => item.type === "pause"),
    {
      removeDuringPlay,
      playQueueHeld,
      playClicked,
      playingDuringRebuild,
      releasedForPlay,
      playEditSettled,
      transitions: playEditTransitions,
      ids: ids(afterPlayEdit),
    },
  );

  // Phase 8: a 600-song queue renders only the visible window.
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

  // Phase 9: with Queue.splice hidden, every edit rebuilds the queue. A slow
  // setQueue keeps the first rebuild in flight while the next row is clicked;
  // the edits must queue behind each other and plan from the settled state.
  await fixtureCall(page, "configure", [
    {
      nativeQueueEdit: true,
      hideQueueSplice: true,
      setQueueDelayMs: 250,
    },
  ]);
  const seedSixIds = [
    "bulk-0",
    "bulk-1",
    "bulk-2",
    "bulk-3",
    "bulk-4",
    "bulk-5",
  ];
  await page.evaluate(`
    for (const button of document.querySelectorAll('.action-toast button[aria-label="Dismiss"]')) {
      button.click();
    }
    window.__ARLET_E2E_MUSIC__.seedQueue(6);
    return true;
  `);
  const serialMoveReady = await waitFor(
    page,
    `JSON.stringify(window.__ARLET_E2E_MUSIC__.snapshot().queue.items.map((item) => item.id)) === ${JSON.stringify(JSON.stringify(seedSixIds))} && ${DRAWER_ROWS}.length === 6 && ${PLAY_LABEL} === "Pause"`,
  );
  const beforeDoubleMove = await snapshotOf(page);
  const mark9 = beforeDoubleMove.transitions.length;
  const moveStart = beforeDoubleMove.queueEdit.setQueueStarts;
  const firstMove = await page.evaluate(
    `return ${clickRowControl(3, '[data-queue-action="up"]')};`,
  );
  const firstMoveStarted = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().queueEdit.setQueueStarts === ${moveStart + 1}`,
  );
  const secondMove = await page.evaluate(`
    const seeded = JSON.stringify(window.__ARLET_E2E_MUSIC__.snapshot().queue.items.map((item) => item.id)) === ${JSON.stringify(JSON.stringify(seedSixIds))};
    const clicked = ${clickRowControl(3, '[data-queue-action="up"]')};
    return seeded && clicked;
  `);
  const doubleMove = firstMove && firstMoveStarted && secondMove;
  const afterFirstMove = [
    "bulk-0",
    "bulk-1",
    "bulk-3",
    "bulk-2",
    "bulk-4",
    "bulk-5",
  ];
  const afterDoubleMove = [
    "bulk-0",
    "bulk-3",
    "bulk-1",
    "bulk-2",
    "bulk-4",
    "bulk-5",
  ];
  const doubleMoveSettled = await waitFor(
    page,
    `(() => {
      const snapshot = window.__ARLET_E2E_MUSIC__.snapshot();
      const transitions = snapshot.transitions.slice(${mark9});
      return transitions.filter((item) => item.type === "setQueue").length === 2 &&
        transitions.filter((item) => item.type === "play").length === 2 &&
        JSON.stringify(snapshot.queue.items.map((item) => item.id)) === ${JSON.stringify(JSON.stringify(afterDoubleMove))};
    })()`,
  );
  const afterDoubleMoveSnapshot = await snapshotOf(page);
  const doubleMoveTransitions =
    afterDoubleMoveSnapshot.transitions.slice(mark9);
  const doubleMoveSetQueues = doubleMoveTransitions.filter(
    (item) => item.type === "setQueue",
  );
  const doubleMoveToasts = await page.evaluate(`
    return [...document.querySelectorAll(".action-toast-message")].map((node) => node.textContent ?? "");
  `);
  check(
    "two rebuild-tier moves queue behind each other and apply in order",
    serialMoveReady &&
      doubleMove &&
      doubleMoveSettled &&
      sameIds(ids(afterDoubleMoveSnapshot), afterDoubleMove) &&
      afterDoubleMoveSnapshot.queue.index === 0 &&
      afterDoubleMoveSnapshot.queueEdit.native &&
      afterDoubleMoveSnapshot.queueEdit.spliceHidden &&
      sameIds(doubleMoveSetQueues[0]?.ids, afterFirstMove) &&
      sameIds(doubleMoveSetQueues[1]?.ids, afterDoubleMove) &&
      !doubleMoveToasts.some(
        (text) => text.includes("changed") || text.includes("reloaded"),
      ),
    {
      ready: serialMoveReady,
      firstMove,
      firstMoveStarted,
      secondDuringFirstRebuild: secondMove,
      settled: doubleMoveSettled,
      ids: ids(afterDoubleMoveSnapshot),
      setQueues: doubleMoveSetQueues.map((item) => item.ids),
      toasts: doubleMoveToasts,
    },
  );

  // Phase 10: a move followed by a remove composes the same way.
  await page.evaluate(`
    for (const button of document.querySelectorAll('.action-toast button[aria-label="Dismiss"]')) {
      button.click();
    }
    window.__ARLET_E2E_MUSIC__.seedQueue(6);
    return true;
  `);
  const serialRemoveReady = await waitFor(
    page,
    `JSON.stringify(window.__ARLET_E2E_MUSIC__.snapshot().queue.items.map((item) => item.id)) === ${JSON.stringify(JSON.stringify(seedSixIds))} && ${DRAWER_ROWS}.length === 6 && ${PLAY_LABEL} === "Pause"`,
  );
  const beforeMoveThenRemove = await snapshotOf(page);
  const mark10 = beforeMoveThenRemove.transitions.length;
  const removeMoveStart = beforeMoveThenRemove.queueEdit.setQueueStarts;
  const firstRemoveMove = await page.evaluate(
    `return ${clickRowControl(3, '[data-queue-action="up"]')};`,
  );
  const firstRemoveMoveStarted = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().queueEdit.setQueueStarts === ${removeMoveStart + 1}`,
  );
  const removeClick = await page.evaluate(`
    const seeded = JSON.stringify(window.__ARLET_E2E_MUSIC__.snapshot().queue.items.map((item) => item.id)) === ${JSON.stringify(JSON.stringify(seedSixIds))};
    const clicked = ${clickRowControl(2, '[data-queue-action="remove"]')};
    return seeded && clicked;
  `);
  const moveThenRemove =
    firstRemoveMove && firstRemoveMoveStarted && removeClick;
  const afterMoveThenRemove = [
    "bulk-0",
    "bulk-1",
    "bulk-3",
    "bulk-4",
    "bulk-5",
  ];
  const moveThenRemoveSettled = await waitFor(
    page,
    `(() => {
      const snapshot = window.__ARLET_E2E_MUSIC__.snapshot();
      const transitions = snapshot.transitions.slice(${mark10});
      return transitions.filter((item) => item.type === "setQueue").length === 2 &&
        transitions.filter((item) => item.type === "play").length === 2 &&
        JSON.stringify(snapshot.queue.items.map((item) => item.id)) === ${JSON.stringify(JSON.stringify(afterMoveThenRemove))};
    })()`,
  );
  const afterMoveThenRemoveSnapshot = await snapshotOf(page);
  const moveThenRemoveTransitions =
    afterMoveThenRemoveSnapshot.transitions.slice(mark10);
  const moveThenRemoveSetQueues = moveThenRemoveTransitions.filter(
    (item) => item.type === "setQueue",
  );
  const moveThenRemoveToasts = await page.evaluate(`
    return [...document.querySelectorAll(".action-toast-message")].map((node) => node.textContent ?? "");
  `);
  check(
    "a rebuild-tier move and remove queue behind each other and apply in order",
    serialRemoveReady &&
      moveThenRemove &&
      moveThenRemoveSettled &&
      sameIds(ids(afterMoveThenRemoveSnapshot), afterMoveThenRemove) &&
      afterMoveThenRemoveSnapshot.queue.index === 0 &&
      sameIds(moveThenRemoveSetQueues[0]?.ids, afterFirstMove) &&
      sameIds(moveThenRemoveSetQueues[1]?.ids, afterMoveThenRemove) &&
      !moveThenRemoveToasts.some(
        (text) => text.includes("changed") || text.includes("reloaded"),
      ),
    {
      ready: serialRemoveReady,
      firstRemoveMove,
      firstRemoveMoveStarted,
      removeDuringFirstRebuild: removeClick,
      settled: moveThenRemoveSettled,
      ids: ids(afterMoveThenRemoveSnapshot),
      setQueues: moveThenRemoveSetQueues.map((item) => item.ids),
      toasts: moveThenRemoveToasts,
    },
  );
  await fixtureCall(page, "configure", [
    {
      nativeQueueEdit: false,
      hideQueueSplice: false,
      setQueueDelayMs: 0,
    },
  ]);
}
