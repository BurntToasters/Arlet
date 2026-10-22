// Failure modes this scenario guards. Each one has a check named below.

// 1. Ctrl or Meta click starts playback, so a selection gesture plays a song.
//    Checked by "ctrl-click selects three rows without playing": no new
//    fixture transitions, and the queue is unchanged.

// 2. The selection follows click order, not list order. The clicks run in
//    the order 9, 2, 5. Checked by "Play Next queues the selection in list
//    order" and by the POST body check.

// 3. Shift+click plays, or selects only its two ends instead of the range.
//    Checked by "shift-click selects the contiguous range without playing".

// 4. Ctrl+A is not consumed, so the page selects text, or it selects only a
//    part of the loaded rows. Checked by "ctrl+a selects every loaded row".

// 5. Escape clears with no selection (swallowing its usual job), or does not
//    clear one. Checked by "escape clears the selection and its bar" and
//    "escape with no selection is left alone".

// 6. The bulk menu is missing, lists single-song items such as Go to album,
//    or a right-click on an unselected row shows bulk items. Checked by "bulk
//    context menu lists only the bulk actions" and "unselected row keeps the
//    single menu".

// 7. Add to Playlist does not open the picker, or posts the wrong ids.
//    Checked by "Add to Playlist posts exactly the selection in list order".

// 8. The drag payload is wrong, the sidebar takes a catalog pin, a library pin
//    refuses the drop, or the highlight sticks after a drop. Checked by "drag
//    payload", "catalog pin does not take the drop", "drag over a library pin
//    takes the drop", and "drop posts the selection and clears the highlight".

// 9. Leaving the list keeps its selection. Checked by "leaving the list
//    clears the selection".

// 10. A plain click no longer plays a single song after the selection work.
//     Checked by "plain click on an unselected row plays that song".

// 11. Cleanup leaves a pin, the library view flag or the selection behind for
//     the next scenario. Cleanup runs in finally and writes the results file.

import fs from "node:fs";
import path from "node:path";
import { fixtureCall, sleep, waitFor } from "./e2e-helpers.js";

const STORAGE_KEY = "arlet.library.view.v1";
const LIBRARY_CACHE_SCOPE = "current-account";
const SONG_COUNT = 120;
const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const DRAG_TYPE = "application/x-arlet-tracks";

// Ids of the library view songs. Clicks happen in CLICK_ORDER; the selection
// must come out in LIST_ORDER.
const songId = (index) => `lv-song-${String(index).padStart(5, "0")}`;
const CLICK_ORDER = [9, 2, 5].map(songId);
const LIST_ORDER = [2, 5, 9].map(songId);
const RANGE = [10, 11, 12, 13, 14].map(songId);
const UNSELECTED = songId(30);
const PLAIN_CLICK = songId(70);
// "Bravo Hits" is the editable library playlist the picker lists.
const PLAYLIST_ID = "lv-pl-06";
const PLAYLIST_NAME = "Bravo Hits";
const CATALOG_PLAYLIST_ID = "pl.catalog-fixture";
const PLAYLIST_ADD_PATH = `/v1/me/library/playlists/${PLAYLIST_ID}/tracks`;

const q = (value) => JSON.stringify(value);
const rowShell = (id) =>
  `.library-track-list .song-row-shell[data-context-id="${id}"]`;
const rowButton = (id) => `${rowShell(id)} > button`;
const pinButton = (id) =>
  `.sidebar-group[aria-label="Pinned playlists"] button[data-context-id="${id}"]`;

const snapshot = (page) => page.evaluate(`return ${FIXTURE}.snapshot();`);

async function transitionsSince(page, mark) {
  return (await snapshot(page)).transitions.slice(mark);
}

async function reloadApp(page) {
  await page.evaluate("location.hash = '#/home'; return true;");
  await page.send("Page.reload", { ignoreCache: true });
  await sleep(1000);
  return waitFor(
    page,
    "window.__ARLET_E2E_MUSIC__ && document.querySelector('.app-shell .player-bar')",
    30_000,
  );
}

// A plain or modified click on a row's main button, as the browser would send it.
function clickRow(page, id, init = {}) {
  return page.evaluate(`
    const button = document.querySelector(${q(rowButton(id))});
    if (!button) return false;
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...${JSON.stringify(init)} }));
    return true;
  `);
}

function focusRow(page, id) {
  return page.evaluate(`
    const button = document.querySelector(${q(rowButton(id))});
    if (!button) return false;
    button.focus();
    return document.activeElement === button;
  `);
}

// Dispatches a keydown at the focused element, or at the document. Returns
// true when nothing called preventDefault.
function pressKey(page, key, { ctrlKey = false, onDocument = false } = {}) {
  return page.evaluate(`
    const target = ${onDocument ? "document" : "(document.activeElement ?? document.body)"};
    const event = new KeyboardEvent("keydown", { key: ${q(key)}, ctrlKey: ${ctrlKey}, bubbles: true, cancelable: true });
    return target.dispatchEvent(event);
  `);
}

const selectedIds = (page) =>
  page.evaluate(`
    return [...document.querySelectorAll(".library-track-list li.is-selected > .song-row-shell")]
      .map((node) => node.getAttribute("data-context-id"));
  `);

const selectionState = (page) =>
  page.evaluate(`
    return {
      count: document.querySelector(".selection-count")?.textContent ?? null,
      bar: document.querySelector(".selection-bar") !== null,
      named: [...document.querySelectorAll(".library-track-list li.is-selected button[aria-label*='selected']")].length,
      countStatus: document.querySelector(".selection-count")?.getAttribute("role") === "status",
    };
  `);

const sameIds = (actual, expected) =>
  JSON.stringify(actual ?? []) === JSON.stringify(expected);

// With no sort, filter or favorites active, the songs list does not auto-load:
// it shows a Load more button per page (100, then 20). Click it until every
// song is rendered, so the scenario starts from the full 120.
async function openSongs(page) {
  await page.evaluate(`location.hash = "#/library/songs"; return true;`);
  const rows = `document.querySelectorAll(".library-track-list .song-row-shell").length`;
  if (!(await waitFor(page, `${rows} > 0`, 20_000))) return false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await waitFor(page, `${rows} >= ${SONG_COUNT}`, 1_000)) return true;
    const before = await page.evaluate(`return ${rows};`);
    const clicked = await page.evaluate(`
      const button = document.querySelector(".library-load-more");
      if (!button || button.disabled) return false;
      button.click();
      return true;
    `);
    if (!clicked) {
      await waitFor(page, `${rows} >= ${SONG_COUNT}`, 5_000);
      continue;
    }
    await waitFor(page, `${rows} > ${before}`, 15_000);
  }
  return (await page.evaluate(`return ${rows};`)) === SONG_COUNT;
}

// Opens the context menu for a target (a playlist, or a song row) through the
// fixture, as the other scenarios do, and clicks one item.
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

// Right-clicks a row (dispatched on its shell, so the window listener sees it).
function rightClickRow(page, id) {
  return page.evaluate(`
    const shell = document.querySelector(${q(rowShell(id))});
    if (!shell) return false;
    const rect = shell.getBoundingClientRect();
    shell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 10 }));
    return true;
  `);
}

const menuEntries = (page) =>
  page.evaluate(`
    return [...document.querySelectorAll(".context-menu [data-menu-item]")].map((node) => ({
      id: node.getAttribute("data-menu-item"),
      label: node.querySelector("span")?.textContent ?? "",
    }));
  `);

export async function runMultiSelect({ page, check, artifactDir }) {
  const results = [];
  const record = (name, passed, details) => {
    const ok = Boolean(passed);
    results.push({ name, passed: ok, details });
    check(name, ok, details);
  };

  try {
    await reloadApp(page);
    await fixtureCall(page, "reset");
    await fixtureCall(page, "configure", [{ libraryView: true }]);
    await page.evaluate(
      `localStorage.removeItem(${q(STORAGE_KEY)}); return true;`,
    );
    const loaded = await openSongs(page);
    if (!loaded) throw new Error("Songs list did not load all 120 rows.");

    // A plain click starts playback, so the queue has songs for Play Next.
    await clickRow(page, songId(0));
    await waitFor(
      page,
      `window.__ARLET_E2E_MUSIC__.snapshot().transitions.some((item) => item.type === "play")`,
      15_000,
    );
    const seeded = await snapshot(page);
    const seededIds = seeded.queue.items.map((item) => item.id);

    // Ctrl+click, out of list order, without playing.
    const beforeCtrl = seeded.transitions.length;
    for (const id of CLICK_ORDER) await clickRow(page, id, { ctrlKey: true });
    const threeSelected = await waitFor(
      page,
      `document.querySelectorAll(".library-track-list li.is-selected").length === 3`,
    );
    const ctrlSelection = await selectedIds(page);
    const ctrlState = await selectionState(page);
    const ctrlTransitions = await transitionsSince(page, beforeCtrl);
    const ctrlQueue = (await snapshot(page)).queue.items.map((item) => item.id);
    record(
      "ctrl-click selects three rows without playing",
      threeSelected &&
        sameIds(ctrlSelection, LIST_ORDER) &&
        ctrlState.count === "3 selected" &&
        ctrlState.named === 3 &&
        ctrlState.countStatus &&
        ctrlTransitions.length === 0 &&
        sameIds(ctrlQueue, seededIds),
      {
        selected: ctrlSelection,
        state: ctrlState,
        transitions: ctrlTransitions,
      },
    );

    // Play Next: the three songs go after the current one, in list order.
    const beforeNext = (await snapshot(page)).transitions.length;
    const beforeQueue = (await snapshot(page)).queue;
    await page.evaluate(
      `document.querySelector('[data-selection-action="play-next"]').click(); return true;`,
    );
    await waitFor(
      page,
      `window.__ARLET_E2E_MUSIC__.snapshot().transitions.slice(${beforeNext}).some((item) => item.type === "playNext")`,
      10_000,
    );
    const nextTransitions = await transitionsSince(page, beforeNext);
    const nextInsertion = nextTransitions.find(
      (item) => item.type === "playNext",
    );
    const afterQueue = (await snapshot(page)).queue;
    const insertedAt = (beforeQueue.index ?? 0) + 1;
    const queuedAfterCurrent = afterQueue.items
      .map((item) => item.id)
      .slice(insertedAt, insertedAt + 3);
    const stillSelected = await selectionState(page);
    record(
      "Play Next queues the selection in list order",
      sameIds(nextInsertion?.ids, LIST_ORDER) &&
        sameIds(queuedAfterCurrent, LIST_ORDER) &&
        afterQueue.items.length === beforeQueue.items.length + 3 &&
        stillSelected.count === "3 selected",
      {
        insertion: nextInsertion,
        queuedAfterCurrent,
        currentIndex: beforeQueue.index,
        selectionCount: stillSelected.count,
      },
    );

    // Escape clears the selection and its bar; with no selection it is left alone.
    await focusRow(page, LIST_ORDER[0]);
    const escapeCleared = await pressKey(page, "Escape");
    const afterEscape = await selectionState(page);
    record(
      "escape clears the selection and its bar",
      escapeCleared === false &&
        afterEscape.bar === false &&
        (await selectedIds(page)).length === 0,
      { prevented: escapeCleared === false, state: afterEscape },
    );
    const escapeUntouched = await pressKey(page, "Escape");
    record("escape with no selection is left alone", escapeUntouched === true, {
      notCanceled: escapeUntouched,
    });

    // Shift+click after an anchor selects the contiguous range, without playing.
    await clickRow(page, RANGE[0], { ctrlKey: true });
    const beforeShift = (await snapshot(page)).transitions.length;
    await clickRow(page, RANGE[RANGE.length - 1], { shiftKey: true });
    await waitFor(
      page,
      `document.querySelectorAll(".library-track-list li.is-selected").length === ${RANGE.length}`,
    );
    const shiftSelection = await selectedIds(page);
    const shiftTransitions = await transitionsSince(page, beforeShift);
    record(
      "shift-click selects the contiguous range without playing",
      sameIds(shiftSelection, RANGE) && shiftTransitions.length === 0,
      { selected: shiftSelection, transitions: shiftTransitions },
    );

    // Ctrl+A selects every loaded row, and the key is consumed.
    await focusRow(page, RANGE[2]);
    const ctrlAAllowed = await pressKey(page, "a", { ctrlKey: true });
    const allSelected = await waitFor(
      page,
      `document.querySelectorAll(".library-track-list li.is-selected").length === ${SONG_COUNT}`,
    );
    const allCount = await page.evaluate(
      `return document.querySelectorAll(".library-track-list .song-row-shell").length;`,
    );
    const allState = await selectionState(page);
    record(
      "ctrl+a selects every loaded row",
      allSelected &&
        ctrlAAllowed === false &&
        allCount === SONG_COUNT &&
        allState.count === `${SONG_COUNT} selected`,
      {
        prevented: ctrlAAllowed === false,
        loadedRows: allCount,
        count: allState.count,
      },
    );
    await pressKey(page, "Escape");

    // Bulk context menu on a selected row; single menu on an unselected one.
    for (const id of CLICK_ORDER) await clickRow(page, id, { ctrlKey: true });
    await waitFor(
      page,
      `document.querySelectorAll(".library-track-list li.is-selected").length === 3`,
    );
    rightClickRow(page, songId(5));
    const bulkReady = await waitFor(
      page,
      `document.querySelector('.context-menu [data-menu-item="play-next"]')?.textContent.includes("Play 3 Songs Next")`,
      10_000,
    );
    await sleep(300);
    const bulkItems = await menuEntries(page);
    const bulkIds = bulkItems.map((item) => item.id);
    const bulkLabels = Object.fromEntries(
      bulkItems.map((item) => [item.id, item.label]),
    );
    const bulkClean = !bulkIds.some(
      (id) =>
        [
          "go-to-album",
          "play-now",
          "start-station",
          "copy-link",
          "remove-from-queue",
        ].includes(id) || id.startsWith("go-to-artist"),
    );
    record(
      "bulk context menu lists only the bulk actions",
      bulkReady &&
        bulkLabels["play-later"] === "Play 3 Songs Later" &&
        bulkLabels["add-to-playlist"] === "Add 3 Songs to Playlist…" &&
        bulkLabels.favorite === "Favorite 3 Songs" &&
        bulkClean,
      { bulkItems },
    );
    await pressKey(page, "Escape", { onDocument: true });
    await waitFor(page, `!document.querySelector(".context-menu")`);

    rightClickRow(page, UNSELECTED);
    const singleReady = await waitFor(
      page,
      `document.querySelector('.context-menu [data-menu-item="play-next"]')?.textContent.trim() === "Play next"`,
      10_000,
    );
    await sleep(300);
    const singleItems = await menuEntries(page);
    const singleLabels = Object.fromEntries(
      singleItems.map((item) => [item.id, item.label]),
    );
    record(
      "unselected row keeps the single menu",
      singleReady &&
        singleLabels["play-now"] === "Play now" &&
        singleLabels["play-next"] === "Play next" &&
        singleLabels.favorite === "Favorite" &&
        !singleItems.some((item) => item.label.includes("Songs")),
      { singleItems },
    );
    await pressKey(page, "Escape", { onDocument: true });
    await waitFor(page, `!document.querySelector(".context-menu")`);

    // Add to Playlist from the bar: the picker opens and the POST carries the selection.
    const addSince = (await snapshot(page)).requests.length;
    await page.evaluate(
      `document.querySelector('[data-selection-action="add-to-playlist"]').click(); return true;`,
    );
    const pickerShown = await waitFor(
      page,
      `[...document.querySelectorAll(".playlist-dialog-option")].some((node) => node.textContent.includes(${q(PLAYLIST_NAME)}))`,
      20_000,
    );
    await page.evaluate(`
      [...document.querySelectorAll(".playlist-dialog-option")]
        .find((node) => node.textContent.includes(${q(PLAYLIST_NAME)}))
        ?.click();
      return true;
    `);
    const addPosted = await waitFor(
      page,
      `window.__ARLET_E2E_MUSIC__.snapshot().requests.slice(${addSince}).some((request) => request.method === "POST" && request.path.split("?")[0] === ${q(PLAYLIST_ADD_PATH)})`,
      10_000,
    );
    const addRequest = (await snapshot(page)).requests
      .slice(addSince)
      .find(
        (request) =>
          request.method === "POST" &&
          request.path.split("?")[0] === PLAYLIST_ADD_PATH,
      );
    const addedIds = (addRequest?.body?.data ?? []).map((ref) => ref.id);
    record(
      "Add to Playlist posts exactly the selection in list order",
      pickerShown && addPosted && sameIds(addedIds, LIST_ORDER),
      { pickerShown, addedIds, request: addRequest?.path },
    );
    await waitFor(page, `!document.querySelector(".playlist-dialog-backdrop")`);

    // Drag: pin the library playlist and a catalog playlist, then drag the selection.
    await clickMenuItem(
      page,
      { id: PLAYLIST_ID, kind: "playlist", source: "library" },
      "pin-playlist",
    );
    const libraryPinned = await waitFor(
      page,
      `document.querySelector(${q(pinButton(PLAYLIST_ID))})`,
    );
    await clickMenuItem(
      page,
      { id: CATALOG_PLAYLIST_ID, kind: "playlist", source: "catalog" },
      "pin-playlist",
    );
    const catalogPinned = await waitFor(
      page,
      `document.querySelector(${q(pinButton(CATALOG_PLAYLIST_ID))})`,
    );

    const dragStart = await page.evaluate(`
      window.__arletMultiSelectDrag = new DataTransfer();
      const shell = document.querySelector(${q(rowShell(songId(5)))});
      if (!shell) return null;
      shell.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: window.__arletMultiSelectDrag }));
      return JSON.parse(window.__arletMultiSelectDrag.getData(${q(DRAG_TYPE)}) || "null");
    `);
    record(
      "drag payload is the whole selection in list order",
      sameIds(dragStart, LIST_ORDER),
      { payload: dragStart },
    );

    const catalogAccepts = await page.evaluate(`
      const pin = document.querySelector(${q(pinButton(CATALOG_PLAYLIST_ID))});
      if (!pin) return null;
      const notCanceled = pin.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: window.__arletMultiSelectDrag }));
      return { notCanceled, highlighted: pin.classList.contains("is-drop-target") };
    `);
    record(
      "catalog pin does not take the drop",
      catalogPinned &&
        catalogAccepts !== null &&
        catalogAccepts.notCanceled === true &&
        catalogAccepts.highlighted === false,
      { catalogAccepts },
    );

    // dropEffect is not asserted: Sidebar sets "copy" on dragover, but a
    // DataTransfer built in script outside a real OS drag does not keep a
    // dropEffect write (it reads "none" here). Acceptance is the canceled
    // dragover plus the highlight; the drop POST below proves the rest.
    const overLibrary = await page.evaluate(`
      const pin = document.querySelector(${q(pinButton(PLAYLIST_ID))});
      if (!pin) return null;
      const notCanceled = pin.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: window.__arletMultiSelectDrag }));
      return { notCanceled, dropEffect: window.__arletMultiSelectDrag.dropEffect };
    `);
    const highlighted = await waitFor(
      page,
      `document.querySelector(${q(pinButton(PLAYLIST_ID))})?.classList.contains("is-drop-target")`,
    );
    record(
      "drag over a library pin takes the drop",
      libraryPinned &&
        overLibrary !== null &&
        overLibrary.notCanceled === false &&
        highlighted,
      { overLibrary, highlighted },
    );

    const dropSince = (await snapshot(page)).requests.length;
    const dropResult = await page.evaluate(`
      const pin = document.querySelector(${q(pinButton(PLAYLIST_ID))});
      if (!pin) return null;
      return pin.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.__arletMultiSelectDrag }));
    `);
    const dropPosted = await waitFor(
      page,
      `window.__ARLET_E2E_MUSIC__.snapshot().requests.slice(${dropSince}).some((request) => request.method === "POST" && request.path.split("?")[0] === ${q(PLAYLIST_ADD_PATH)})`,
      10_000,
    );
    const dropRequest = (await snapshot(page)).requests
      .slice(dropSince)
      .find(
        (request) =>
          request.method === "POST" &&
          request.path.split("?")[0] === PLAYLIST_ADD_PATH,
      );
    const droppedIds = (dropRequest?.body?.data ?? []).map((ref) => ref.id);
    const noticeShown = await waitFor(
      page,
      `document.querySelector(".action-toasts")?.textContent.includes(${q(`Added 3 songs to ${PLAYLIST_NAME}.`)})`,
      10_000,
    );
    const cleared = await page.evaluate(
      `return !document.querySelector(${q(pinButton(PLAYLIST_ID))})?.classList.contains("is-drop-target");`,
    );
    await page.evaluate(`
      const shell = document.querySelector(${q(rowShell(songId(5)))});
      shell?.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: window.__arletMultiSelectDrag }));
      delete window.__arletMultiSelectDrag;
      return true;
    `);
    record(
      "drop posts the selection and clears the highlight",
      dropResult === false &&
        dropPosted &&
        sameIds(droppedIds, LIST_ORDER) &&
        cleared &&
        noticeShown,
      { dropPrevented: dropResult === false, droppedIds, cleared, noticeShown },
    );

    // Plain click on an unselected row still plays that song alone.
    await focusRow(page, LIST_ORDER[0]);
    await pressKey(page, "Escape");
    const plainSince = (await snapshot(page)).transitions.length;
    await clickRow(page, PLAIN_CLICK);
    const playing = await waitFor(
      page,
      `window.__ARLET_E2E_MUSIC__.snapshot().queue.activeId === ${q(PLAIN_CLICK)}`,
      10_000,
    );
    const plainTransitions = await transitionsSince(page, plainSince);
    record(
      "plain click on an unselected row plays that song",
      playing &&
        plainTransitions.some(
          (item) => item.type === "play" || item.type === "selectIndex",
        ),
      { activeId: (await snapshot(page)).queue.activeId, plainTransitions },
    );

    // Leaving the list clears its selection.
    await clickRow(page, songId(3), { ctrlKey: true });
    await clickRow(page, songId(4), { ctrlKey: true });
    await waitFor(
      page,
      `document.querySelectorAll(".library-track-list li.is-selected").length === 2`,
    );
    await page.evaluate(`location.hash = "#/library/playlists"; return true;`);
    await waitFor(page, `document.querySelector(".playlist-tree")`, 15_000);
    await openSongs(page);
    const afterLeave = await selectionState(page);
    record(
      "leaving the list clears the selection",
      afterLeave.bar === false && (await selectedIds(page)).length === 0,
      { state: afterLeave },
    );

    // Album pages (LibraryDetailView) select too: two songs clicked out of
    // order go to Play Later in album order, and Escape clears them.
    await page.evaluate(`location.hash = "#/album/album-1"; return true;`);
    const albumReady = await waitFor(
      page,
      `document.querySelector(${q(rowButton("album-d"))}) !== null`,
      15_000,
    );
    await clickRow(page, "album-c", { ctrlKey: true });
    await clickRow(page, "album-a", { ctrlKey: true });
    const albumBar = await waitFor(
      page,
      `document.querySelector(".selection-count")?.textContent === "2 selected"`,
    );
    const beforeLater = (await snapshot(page)).transitions.length;
    await page.evaluate(
      `document.querySelector('[data-selection-action="play-later"]')?.click(); return true;`,
    );
    await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.slice(${beforeLater}).some((item) => item.type === "playLater")`,
      10_000,
    );
    const later = (await transitionsSince(page, beforeLater)).find(
      (item) => item.type === "playLater",
    );
    await focusRow(page, "album-a");
    await pressKey(page, "Escape");
    const albumCleared = await waitFor(
      page,
      `!document.querySelector(".selection-bar")`,
    );
    record(
      "album page: ctrl-click selects, Play Later queues in album order, Escape clears",
      albumReady &&
        albumBar &&
        sameIds(later?.ids, ["album-a", "album-c"]) &&
        albumCleared,
      { albumReady, albumBar, later, albumCleared },
    );
  } finally {
    // Unpin both playlists, then drop the fixture state the other scenarios read.
    try {
      await clickMenuItem(
        page,
        { id: PLAYLIST_ID, kind: "playlist", source: "library" },
        "unpin-playlist",
      );
      await clickMenuItem(
        page,
        { id: CATALOG_PLAYLIST_ID, kind: "playlist", source: "catalog" },
        "unpin-playlist",
      );
      await waitFor(
        page,
        `!document.querySelector(".sidebar-group[aria-label='Pinned playlists']")`,
        8000,
      );
    } catch {
      // The reload below resets the page either way.
    }
    await page.evaluate(
      `localStorage.removeItem(${q(STORAGE_KEY)}); return true;`,
    );
    await fixtureCall(page, "reset");
    if (artifactDir) {
      fs.writeFileSync(
        path.join(artifactDir, "multi-select-results.json"),
        `${JSON.stringify(
          {
            checks: results.map(({ name, passed }) => ({ name, passed })),
            observed: Object.fromEntries(
              results.map(({ name, details }) => [name, details]),
            ),
          },
          null,
          2,
        )}\n`,
      );
    }
    await page.evaluate(
      `await window.__TAURI_INTERNALS__.invoke("library_cache_clear", { scope: ${q(LIBRARY_CACHE_SCOPE)} }); return true;`,
    );
    await reloadApp(page);
  }
}
