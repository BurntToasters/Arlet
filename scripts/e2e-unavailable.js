/* Failure modes live in docs/TESTING.md ("Unavailable songs"). The fixture
 * mirrors MusicKit's item loader: an unresolved ID rejects the whole call with
 * NOT_FOUND, and an unplayable ID is dropped without an error. */

import { fixtureCall, sleep, waitFor } from "./e2e-helpers.js";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const PLAYLIST_ID = "playlist-1";
const PLAYLIST_IDS = [
  "song-a",
  "song-duplicate",
  "song-c",
  "song-duplicate",
  "song-e",
  "song-f",
];
const TITLE = `document.querySelector(".player-bar .player-track-copy strong")?.textContent`;
const SESSION_FILE = "playback-session.json";
const RESTORED_QUEUE_SIZE = 20;
const RESTORED_POSITION = 42.5;
// Library IDs make queueDescriptorsForTracks send song details first, so one
// failed Play covers both the details attempt and the ID fallback.
const RESTORED_IDS = Array.from(
  { length: RESTORED_QUEUE_SIZE },
  (_, index) => `i.restore-${String(index + 1).padStart(2, "0")}`,
);
const snapshot = (page) => fixtureCall(page, "snapshot");
const toastText = (page) =>
  page.evaluate(
    `return [...document.querySelectorAll('.action-toast-message')].map((node) => node.textContent).join(" | ");`,
  );

function restoredItems() {
  return RESTORED_IDS.map((id, index) => ({
    id,
    title: `Restore Track ${index + 1}`,
    artistName: "Fixture Artist",
    albumTitle: "Restore Album",
    resourceType: "library-songs",
    durationMs: 180_000,
  }));
}

function readSession(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function reloadApp(page) {
  await page.send("Page.reload", { ignoreCache: true });
  await sleep(1000);
  return waitFor(
    page,
    `${FIXTURE} && document.querySelector(".app-shell .player-bar")`,
    30_000,
  );
}

/** Shortens the stream handoff's 60 s timer until restored. */
function installFastRelease(page, ms) {
  return page.evaluate(`
    window.__ARLET_E2E_NATIVE_SET_TIMEOUT__ ??= window.setTimeout;
    window.__ARLET_E2E_RELEASE_MS__ = ${ms};
    const native = window.__ARLET_E2E_NATIVE_SET_TIMEOUT__;
    window.setTimeout = (callback, delay, ...rest) =>
      native(callback, delay === 60000 ? window.__ARLET_E2E_RELEASE_MS__ : delay, ...rest);
    return true;`);
}

function restoreTimeouts(page) {
  return page.evaluate(`
    if (window.__ARLET_E2E_NATIVE_SET_TIMEOUT__) {
      window.setTimeout = window.__ARLET_E2E_NATIVE_SET_TIMEOUT__;
    }
    return true;`);
}

async function startStationFromMenu(page) {
  await fixtureCall(page, "selectContext", ["nav-multi"]);
  const ready = await waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item="start-station"]:not(:disabled)')`,
  );
  if (!ready) return false;
  await page.evaluate(
    `document.querySelector('.context-menu [data-menu-item="start-station"]')?.click(); return true;`,
  );
  return true;
}

async function dismissToasts(page) {
  await page.evaluate(`
    for (const button of document.querySelectorAll('.action-toast button')) button.click();
    return true;
  `);
}

/** Resets the fixture, configures unavailable IDs, and clicks a playlist row. */
async function playRow(page, row, unavailable) {
  await fixtureCall(page, "reset");
  await fixtureCall(page, "configure", [unavailable]);
  await dismissToasts(page);
  await page.evaluate(
    `location.hash = "#/playlist/${PLAYLIST_ID}"; return true;`,
  );
  const ready = await waitFor(
    page,
    `document.querySelectorAll(".library-track-row").length >= 4`,
  );
  if (!ready) return false;
  await page.evaluate(`
    document.querySelectorAll(".library-track-row")[${row}]?.click();
    return true;
  `);
  return true;
}

export async function runUnavailable({ page, check, dataDir }) {
  try {
    // One removed song after the chosen one: the chosen duplicate still
    // plays, and MusicKit's queue starts at it.
    await playRow(page, 3, { unresolvedIds: ["song-e"] });
    const skippedOne = await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.some((item) => item.type === "play")`,
    );
    let snap = await snapshot(page);
    let queued = snap.transitions.filter((item) => item.type === "setQueue");
    const toastOne = await toastText(page);
    check(
      "one unavailable song is skipped and the chosen song still plays",
      skippedOne &&
        snap.transitions.some((item) => item.type === "setQueueUnresolved") &&
        JSON.stringify(queued.at(-1)?.ids) ===
          JSON.stringify(["song-duplicate", "song-f"]) &&
        snap.queue.index === 0 &&
        (await page.evaluate(`return ${TITLE};`)) === "Duplicate Occurrence" &&
        toastOne.includes("Skipped 1 song"),
      { queued: queued.at(-1), index: snap.queue.index, toastOne },
    );

    // The chosen song itself is unavailable: the next available one starts.
    await playRow(page, 2, { unresolvedIds: ["song-c"] });
    await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.some((item) => item.type === "play")`,
    );
    snap = await snapshot(page);
    check(
      "an unavailable chosen song starts the next available song",
      snap.queue.index === 0 &&
        snap.queue.activeId === "song-duplicate" &&
        (await page.evaluate(`return ${TITLE};`)) === "Duplicate Occurrence",
      { index: snap.queue.index, activeId: snap.queue.activeId },
    );

    // An unplayable song MusicKit drops silently must not shift the start
    // or cause a re-select.
    await playRow(page, 3, { unplayableIds: ["song-e"] });
    await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.some((item) => item.type === "play")`,
    );
    snap = await snapshot(page);
    check(
      "a silently dropped song does not shift the chosen start",
      snap.queue.items.length === 2 &&
        snap.queue.index === 0 &&
        snap.queue.activeId === "song-duplicate" &&
        !snap.transitions.some((item) => item.type === "selectIndex"),
      {
        ids: snap.queue.items.map((item) => item.id),
        index: snap.queue.index,
        transitions: snap.transitions.map((item) => item.type),
      },
    );

    // Every song unavailable: a clear message, no playback, no loop.
    await playRow(page, 0, { unresolvedIds: [...new Set(PLAYLIST_IDS)] });
    const noneShown = await waitFor(
      page,
      `[...document.querySelectorAll('.action-toast-message')].some((node) => node.textContent.includes("None of these songs are available"))`,
    );
    snap = await snapshot(page);
    const attempts = snap.transitions.filter(
      (item) => item.type === "setQueueUnresolved",
    ).length;
    check(
      "a playlist with no available songs shows a clear message",
      noneShown &&
        !snap.transitions.some((item) => item.type === "play") &&
        attempts >= 1 &&
        attempts <= 4,
      { noneShown, attempts },
    );

    // Play next with one unavailable song still adds the others.
    await playRow(page, 0, {});
    await waitFor(page, `${TITLE} === "Track A"`);
    await fixtureCall(page, "configure", [{ unresolvedIds: ["album-b"] }]);
    await dismissToasts(page);
    await fixtureCall(page, "selectContext", [
      { id: "album-1", kind: "album", source: "library" },
    ]);
    await waitFor(
      page,
      `document.querySelector('.context-menu [data-menu-item="play-next-collection"]:not(:disabled)')`,
    );
    await page.evaluate(
      `document.querySelector('.context-menu [data-menu-item="play-next-collection"]')?.click(); return true;`,
    );
    const inserted = await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.some((item) => item.type === "playNext")`,
    );
    snap = await snapshot(page);
    const playNext = snap.transitions.find((item) => item.type === "playNext");
    check(
      "Play next skips an unavailable song and adds the rest",
      inserted &&
        snap.transitions.some((item) => item.type === "playNextUnresolved") &&
        JSON.stringify(playNext?.ids) ===
          JSON.stringify(["album-a", "album-c", "album-d"]) &&
        snap.queue.activeId === "song-a" &&
        (await toastText(page)).includes("Skipped 1 song"),
      { playNext, activeId: snap.queue.activeId },
    );

    // A song that fails as it starts is skipped, like Apple Music.
    await playRow(page, 0, {});
    await waitFor(page, `${TITLE} === "Track A"`);
    await dismissToasts(page);
    let mark = (await snapshot(page)).transitions.length;
    await fixtureCall(page, "failCurrentItem", ["CONTENT_UNAVAILABLE"]);
    const skippedFailing = await waitFor(
      page,
      `${TITLE} === "Duplicate Occurrence"`,
    );
    snap = await snapshot(page);
    check(
      "a song that fails to start is skipped to the next song",
      skippedFailing &&
        snap.transitions.slice(mark).some((item) => item.type === "next") &&
        (await toastText(page)).includes("Skipped “Track A”"),
      { transitions: snap.transitions.slice(mark).map((item) => item.type) },
    );

    // Consecutive failures stop after the cap instead of racing the queue.
    mark = (await snapshot(page)).transitions.length;
    for (let i = 0; i < 3; i += 1) {
      await fixtureCall(page, "failCurrentItem", ["CONTENT_UNAVAILABLE"]);
      await sleep(250);
    }
    snap = await snapshot(page);
    const cappedSkips = snap.transitions
      .slice(mark)
      .filter((item) => item.type === "next").length;
    check("auto-skip stops after three failures in a row", cappedSkips === 2, {
      cappedSkips,
    });

    // Account-wide failures never skip: every song would fail the same way.
    await playRow(page, 0, {});
    await waitFor(page, `${TITLE} === "Track A"`);
    mark = (await snapshot(page)).transitions.length;
    await fixtureCall(page, "failCurrentItem", ["SUBSCRIPTION_ERROR"]);
    await sleep(600);
    snap = await snapshot(page);
    check(
      "account-wide playback errors are not skipped",
      !snap.transitions.slice(mark).some((item) => item.type === "next") &&
        (await page.evaluate(`return ${TITLE};`)) === "Track A",
      { transitions: snap.transitions.slice(mark).map((item) => item.type) },
    );

    // Unstreamable songs are dimmed, and huge playlists are capped.
    await fixtureCall(page, "reset");
    await dismissToasts(page);
    await page.evaluate(
      `location.hash = "#/playlist/playlist-big"; return true;`,
    );
    const bigReady = await waitFor(
      page,
      `document.querySelectorAll(".library-track-row").length >= 3`,
      15_000,
    );
    const dimmed = await page.evaluate(`
      const rows = [...document.querySelectorAll(".song-row-shell")];
      return {
        unavailable: rows.filter((row) => row.classList.contains("is-unavailable")).length,
        secondDisabled: rows[1]?.querySelector(".library-track-row")?.disabled === true,
        firstDisabled: rows[0]?.querySelector(".library-track-row")?.disabled === true,
      };
    `);
    check(
      "an unstreamable song is dimmed and cannot be played from its row",
      bigReady &&
        dimmed.unavailable === 1 &&
        dimmed.secondDisabled &&
        !dimmed.firstDisabled,
      dimmed,
    );

    // The playlist page loads every page, not only the first.
    const allListed = await waitFor(
      page,
      `(() => {
        const scroller = document.querySelector(".content-scroll");
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        const numbers = [...document.querySelectorAll(".library-row-number")];
        return numbers.at(-1)?.textContent?.trim() === "1200";
      })()`,
      20_000,
    );
    check(
      "a long playlist page lists every song, not just the first page",
      allListed,
    );
    await page.evaluate(
      `document.querySelector(".content-scroll")?.scrollTo(0, 0); return true;`,
    );

    // Album pages follow the cursor too.
    await page.evaluate(`location.hash = "#/album/album-1"; return true;`);
    const albumAll = await waitFor(
      page,
      `document.querySelector(".library-detail-hero h1")?.textContent === "Fixture Album" &&
        [...document.querySelectorAll(".library-row-copy strong")].some((node) => node.textContent === "Album Track D")`,
      15_000,
    );
    check("an album page lists tracks past its first page", albumAll);
    await page.evaluate(
      `location.hash = "#/playlist/playlist-big"; return true;`,
    );
    await waitFor(
      page,
      `document.querySelector(".library-detail-hero h1")?.textContent?.startsWith("Big Playlist")`,
      15_000,
    );

    // Later pages answer slowly: Play must not wait for them. Earlier steps
    // already played songs and loaded every page, so compare against counts
    // and times taken at the click.
    const atClick = await page.evaluate(`
      ${FIXTURE}.configure({ delayPaths: ["playlist-big/tracks?offset"], delayMs: 2500 });
      const plays = ${FIXTURE}.snapshot().transitions.filter((item) => item.type === "play").length;
      const clickedAt = Date.now();
      [...document.querySelectorAll(".library-detail-actions button")]
        .find((node) => node.textContent.trim() === "Play all")?.click();
      return { plays, clickedAt };
    `);
    const playedEarly = await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.filter((item) => item.type === "play").length > ${atClick.plays}`,
      2_000,
    );
    const laterPagesAtPlay = (await snapshot(page)).requests.filter(
      (request) =>
        String(request.path).includes("playlist-big/tracks?offset") &&
        request.startedAt >= atClick.clickedAt &&
        request.completedAt,
    ).length;
    check(
      "Play on a large playlist starts before its later pages finish loading",
      playedEarly && laterPagesAtPlay === 0,
      { playedEarly, laterPagesAtPlay },
    );
    await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.some((item) => item.type === "play")`,
      20_000,
    );
    snap = await snapshot(page);
    queued = snap.transitions.filter((item) => item.type === "setQueue");
    const capped = queued.at(-1)?.ids ?? [];
    check(
      "a huge playlist starts with one lookup's worth of songs and skips unstreamable ones",
      capped.length === 15 &&
        capped[0] === "big-0000" &&
        !capped.includes("big-0001") &&
        snap.queue.activeId === "big-0000" &&
        (await toastText(page)).includes("Skipped 1 song"),
      {
        length: capped.length,
        first: capped[0],
        activeId: snap.queue.activeId,
      },
    );

    // The first batch has 15 upcoming songs, under the refill threshold, so
    // the next 100 are appended once audio starts; later pages join the rest.
    await page.evaluate(`
      if (!document.querySelector(".queue-drawer")) {
        document.querySelector('button[aria-label="Toggle Playing Next"]')?.click();
      }
      return true;
    `);
    const firstRefill = await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.some((item) => item.type === "playLater")`,
      15_000,
    );
    const restShown = await waitFor(
      page,
      `document.querySelector(".queue-rest-note")?.textContent?.includes("1,084 more songs")`,
      20_000,
    );
    // Near the end of the queue (44 upcoming), the next songs follow once.
    await page.evaluate(
      "await window.MusicKit.getInstance().changeToMediaAtIndex(70); return true;",
    );
    const refilled = await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.filter((item) => item.type === "playLater").length >= 2`,
      15_000,
    );
    await sleep(800);
    snap = await snapshot(page);
    const refills = snap.transitions.filter(
      (item) => item.type === "playLater",
    );
    const restAfter = await page.evaluate(
      `return document.querySelector(".queue-rest-note")?.textContent ?? null;`,
    );
    check(
      "a capped queue appends the next songs once as it runs low",
      firstRefill &&
        restShown &&
        refilled &&
        refills.length === 2 &&
        refills[0].ids.length === 100 &&
        refills[0].ids[0] === "big-0016" &&
        refills[1].ids[0] === "big-0116" &&
        snap.queue.activeId === "big-0071" &&
        String(restAfter).includes("984 more songs"),
      {
        restShown,
        refills: refills.map((item) => ({
          length: item.ids.length,
          first: item.ids[0],
        })),
        activeId: snap.queue.activeId,
        restAfter,
      },
    );
    check(
      "background top-ups queue song details, not IDs (no lookup per 16 songs)",
      refills.length === 2 &&
        refills.every((item) => item.shape?.includes("items")),
      { shapes: refills.map((item) => item.shape) },
    );

    // The saved session holds the whole playlist, not only the songs
    // already handed to MusicKit, so a restart does not cut it short.
    await sleep(2600);
    const savedSession = await page.evaluate(`
      const raw = await window.__TAURI_INTERNALS__.invoke("load_playback_session");
      const session = raw ? JSON.parse(raw) : null;
      return {
        count: session?.items?.length ?? 0,
        current: session?.items?.[session.index]?.id ?? null,
        hasRest: Boolean(session?.items?.some((item) => item.id === "big-0400")),
      };`);
    check(
      "the saved session includes the rest of a long playlist",
      savedSession.count === 500 &&
        savedSession.current === "big-0071" &&
        savedSession.hasRest,
      savedSession,
    );

    // Save as playlist offers every song, including the ones still to come.
    await page.evaluate(`
      [...document.querySelectorAll(".queue-toolbar button")]
        .find((node) => node.textContent.trim() === "Save as playlist")?.click();
      return true;
    `);
    const saveOffersAll = await waitFor(
      page,
      `document.querySelector(".playlist-dialog")?.textContent.includes("1199 selected songs")`,
    );
    const saveText = await page.evaluate(
      `return document.querySelector(".playlist-dialog")?.textContent ?? null;`,
    );
    await page.evaluate(`
      document.querySelector('button[aria-label="Close playlist dialog"]')?.click();
      return true;
    `);
    check(
      "Save as playlist includes the songs still waiting to be queued",
      saveOffersAll,
      { saveText: String(saveText).slice(0, 200) },
    );

    // Clear drops the rest of the playlist too.
    await page.evaluate(`
      document.querySelector('button[aria-label="Clear up next"]')?.click();
      return true;
    `);
    const restCleared = await waitFor(
      page,
      `!document.querySelector(".queue-rest-note")`,
    );
    check("Clear also drops the songs still waiting to be queued", restCleared);

    // Every song in the first batch unavailable: the next batch plays
    // instead of the whole Play failing.
    await fixtureCall(page, "reset");
    await fixtureCall(page, "configure", [
      {
        unresolvedIds: Array.from(
          { length: 16 },
          (_, index) => `big-${String(index).padStart(4, "0")}`,
        ),
      },
    ]);
    await dismissToasts(page);
    await page.evaluate(`
      [...document.querySelectorAll(".library-detail-actions button")]
        .find((node) => node.textContent.trim() === "Play all")?.click();
      return true;
    `);
    const nextBatchPlayed = await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.some((item) => item.type === "play")`,
      20_000,
    );
    snap = await snapshot(page);
    check(
      "a first batch with no available song falls through to the next batch",
      nextBatchPlayed && snap.queue.activeId === "big-0016",
      { activeId: snap.queue.activeId, toast: await toastText(page) },
    );

    await fixtureCall(page, "reset");
    await page.evaluate(`
      [...document.querySelectorAll(".library-detail-actions button")]
        .find((node) => node.textContent.trim() === "Shuffle")?.click();
      return true;
    `);
    await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.some((item) => item.type === "play")`,
      20_000,
    );
    snap = await snapshot(page);
    const shuffledIds =
      snap.transitions.filter((item) => item.type === "setQueue").at(-1)?.ids ??
      [];
    const farIndexes = shuffledIds
      .map((id) => Number(id.slice(4)))
      .filter((index) => index >= 600).length;
    check(
      "shuffle of a huge playlist samples the whole playlist within the cap",
      shuffledIds.length >= 15 &&
        shuffledIds.length <= 16 &&
        farIndexes > 0 &&
        snap.modes.shuffle === true,
      { length: shuffledIds.length, farIndexes, shuffle: snap.modes.shuffle },
    );

    // With shuffle on, clicking a row loads the whole playlist first, so the
    // shuffle can draw from every song.
    const rowClick = await page.evaluate(`
      const plays = ${FIXTURE}.snapshot().transitions.filter((item) => item.type === "play").length;
      document.querySelectorAll(".library-track-row")[0]?.click();
      return { plays };
    `);
    await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.filter((item) => item.type === "play").length > ${rowClick.plays}`,
      20_000,
    );
    snap = await snapshot(page);
    // Loaded only up to the clicked row, the sample would hold nothing past
    // the first page (300 songs).
    const rowShuffleIds =
      snap.transitions.filter((item) => item.type === "setQueue").at(-1)?.ids ??
      [];
    const beyondFirstPage = rowShuffleIds.filter(
      (id) => Number(id.slice(4)) >= 300,
    ).length;
    check(
      "with shuffle on, a row click loads every page before playing",
      beyondFirstPage > 0 && snap.modes.shuffle === true,
      { beyondFirstPage, ids: rowShuffleIds, shuffle: snap.modes.shuffle },
    );

    // A queue replaced outside Arlet drops the previous playlist's rest.
    const restBefore = await waitFor(
      page,
      `document.querySelector(".queue-rest-note")`,
    );
    mark = (await snapshot(page)).transitions.length;
    await page.evaluate(`
      const music = window.MusicKit.getInstance();
      await music.setQueue({ songs: ["song-a"] });
      await music.play();
      return true;
    `);
    const restDropped = await waitFor(
      page,
      `!document.querySelector(".queue-rest-note")`,
    );
    await sleep(500);
    snap = await snapshot(page);
    check(
      "a queue replaced elsewhere never receives the previous playlist's songs",
      restBefore &&
        restDropped &&
        !snap.transitions.slice(mark).some((item) => item.type === "playLater"),
      { restBefore, restDropped },
    );

    // Playback integrity: a Play whose queue setup fails must leave the
    // restored queue, position, and saved session untouched; a failed station
    // Play must not label the next handoff's parked queue as a station.
    await fixtureCall(page, "reset");
    await sleep(2500);
    const sessionFile = path.join(dataDir, SESSION_FILE);
    fs.rmSync(`${sessionFile}.bak`, { force: true });
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        schemaVersion: 1,
        items: restoredItems(),
        index: 0,
        positionSeconds: RESTORED_POSITION,
        savedAt: Date.now() - 60_000,
      }),
    );
    const reloaded = await reloadApp(page);
    const restoredTitle = await waitFor(
      page,
      `${TITLE} === "Restore Track 1"`,
      15_000,
    );
    await page.evaluate(`
      if (!document.querySelector(".queue-drawer")) {
        document.querySelector('button[aria-label="Toggle Playing Next"]')?.click();
      }
      return true;
    `);
    const parkedRows = await waitFor(
      page,
      `document.querySelectorAll(".queue-list > li").length === ${RESTORED_QUEUE_SIZE}`,
    );
    const parkedUi = await page.evaluate(`
      return {
        position: document.querySelector(".player-progress span")?.textContent ?? null,
        button: document.querySelector(".play-button")?.getAttribute("aria-label") ?? null,
        active: document.querySelector(".queue-row-shell.is-active .queue-copy strong")?.textContent ?? null,
      };`);
    check(
      "a restored queue is parked with every saved song and its position",
      reloaded &&
        restoredTitle &&
        parkedRows &&
        parkedUi.position === "0:42" &&
        parkedUi.button === "Play" &&
        parkedUi.active === "Restore Track 1",
      { reloaded, restoredTitle, parkedRows, parkedUi },
    );

    // Hold queue setup so the debounced save would fire while only the first
    // batch is provisional; it must not replace the saved session.
    await fixtureCall(page, "configure", [{ holdSetQueue: true }]);
    const failedMark = (await snapshot(page)).transitions.length;
    await page.evaluate(
      `document.querySelector(".play-button")?.click(); return true;`,
    );
    const queueHeld = await waitFor(
      page,
      `${FIXTURE}.snapshot().queueEdit.setQueueHeld >= 1`,
    );
    await sleep(2800);
    const savedWhileHeld = readSession(sessionFile);
    await fixtureCall(page, "configure", [{ rejectSetQueue: true }]);
    await fixtureCall(page, "releaseSetQueue");
    const fallbackHeld = await waitFor(
      page,
      `${FIXTURE}.snapshot().queueEdit.setQueueHeld >= 1`,
      5_000,
    );
    await fixtureCall(page, "releaseSetQueue");
    const failedToast = await waitFor(
      page,
      `[...document.querySelectorAll(".action-toast-message")].some((node) => node.textContent.includes("Fixture queue setup failed"))`,
      10_000,
    );
    await fixtureCall(page, "configure", [
      { holdSetQueue: false, rejectSetQueue: false },
    ]);
    await sleep(2600);
    const failedRows = await page.evaluate(
      `return document.querySelectorAll(".queue-list > li").length;`,
    );
    const failedUi = await page.evaluate(`
      return {
        position: document.querySelector(".player-progress span")?.textContent ?? null,
        button: document.querySelector(".play-button")?.getAttribute("aria-label") ?? null,
        active: document.querySelector(".queue-row-shell.is-active .queue-copy strong")?.textContent ?? null,
      };`);
    const failedSnap = await snapshot(page);
    const failedTransitions = failedSnap.transitions.slice(failedMark);
    const savedAfterFailure = readSession(sessionFile);
    check(
      "a failed Play leaves the full parked queue, position, and saved session intact",
      queueHeld &&
        fallbackHeld &&
        failedToast &&
        failedTransitions.filter((item) => item.type === "setQueueRejected")
          .length === 2 &&
        !failedTransitions.some((item) => item.type === "play") &&
        failedRows === RESTORED_QUEUE_SIZE &&
        failedUi.position === "0:42" &&
        failedUi.button === "Play" &&
        failedUi.active === "Restore Track 1" &&
        savedWhileHeld?.items?.length === RESTORED_QUEUE_SIZE &&
        savedAfterFailure?.items?.length === RESTORED_QUEUE_SIZE &&
        savedAfterFailure?.index === 0 &&
        Math.abs(
          (savedAfterFailure?.positionSeconds ?? -1) - RESTORED_POSITION,
        ) < 0.5 &&
        (await toastText(page)).includes("Fixture queue setup failed"),
      {
        queueHeld,
        fallbackHeld,
        failedToast,
        failedRows,
        failedUi,
        savedWhileHeld: savedWhileHeld
          ? {
              count: savedWhileHeld.items?.length,
              index: savedWhileHeld.index,
            }
          : null,
        savedAfterFailure: savedAfterFailure
          ? {
              count: savedAfterFailure.items?.length,
              index: savedAfterFailure.index,
              position: savedAfterFailure.positionSeconds,
            }
          : null,
        transitions: failedTransitions.map((item) => item.type),
      },
    );

    // With queue setup working again, the same press starts the parked queue.
    const retryMark = (await snapshot(page)).transitions.length;
    await page.evaluate(
      `document.querySelector(".play-button")?.click(); return true;`,
    );
    const retried = await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.slice(${retryMark}).some((item) => item.type === "play")`,
      15_000,
    );
    const retriedSeek = await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.slice(${retryMark}).some((item) => item.type === "seekToTime")`,
      15_000,
    );
    const rowsAfterRetry = await waitFor(
      page,
      `document.querySelectorAll(".queue-list > li").length === ${RESTORED_QUEUE_SIZE}`,
      15_000,
    );
    const retryTransitions = (await snapshot(page)).transitions.slice(
      retryMark,
    );
    const retryQueue = retryTransitions.find(
      (item) => item.type === "setQueue",
    );
    const retrySeek = retryTransitions.find(
      (item) => item.type === "seekToTime",
    );
    const retryUi = await page.evaluate(`
      return {
        title: ${TITLE},
        button: document.querySelector(".play-button")?.getAttribute("aria-label") ?? null,
      };`);
    check(
      "Play after a failed resume starts the same full queue and saved position",
      retried &&
        retriedSeek &&
        rowsAfterRetry &&
        JSON.stringify(retryQueue?.ids) ===
          JSON.stringify(RESTORED_IDS.slice(0, 16)) &&
        Math.abs((retrySeek?.seconds ?? -1) - RESTORED_POSITION) < 0.001 &&
        // The fixture names an unknown queued ID after itself once MusicKit
        // publishes it; the saved queue's own titles were checked while parked.
        retryUi.title === RESTORED_IDS[0] &&
        retryUi.button === "Pause",
      {
        retried,
        retriedSeek,
        rowsAfterRetry,
        ids: retryQueue?.ids,
        seek: retrySeek,
        retryUi,
      },
    );

    // A failed station Play must not leave its label on the queue a later
    // stream handoff parks; Play after the handoff resumes songs, not a URL.
    await fixtureCall(page, "configure", [{ rejectSetQueue: true }]);
    await installFastRelease(page, 400);
    const stationMark = (await snapshot(page)).transitions.length;
    const stationClicked = await startStationFromMenu(page);
    const stationToast = await waitFor(
      page,
      `[...document.querySelectorAll(".action-toast-message")].some((node) => node.textContent.includes("Fixture queue setup failed"))`,
      10_000,
    );
    const stopped = await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.slice(${stationMark}).some((item) => item.type === "stop")`,
      10_000,
    );
    await restoreTimeouts(page);
    await fixtureCall(page, "configure", [{ rejectSetQueue: false }]);
    await sleep(500);
    const stationSnap = await snapshot(page);
    const stationTransitions = stationSnap.transitions.slice(stationMark);
    const stationUi = await page.evaluate(`
      return {
        title: ${TITLE},
        button: document.querySelector(".play-button")?.getAttribute("aria-label") ?? null,
      };`);
    check(
      "a failed station Play leaves the queue parked as songs, not a station",
      stationClicked &&
        stationToast &&
        stopped &&
        stationTransitions.some((item) => item.type === "setQueueRejected") &&
        stationUi.title === RESTORED_IDS[0] &&
        stationUi.button === "Play",
      { stationClicked, stationToast, stopped, stationUi },
    );

    const stationResumeMark = (await snapshot(page)).transitions.length;
    await page.evaluate(
      `document.querySelector(".play-button")?.click(); return true;`,
    );
    const stationResumed = await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.slice(${stationResumeMark}).some((item) => item.type === "play")`,
      15_000,
    );
    const stationResumeSeek = await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.slice(${stationResumeMark}).some((item) => item.type === "seekToTime")`,
      15_000,
    );
    const stationResumeTransitions = (await snapshot(page)).transitions.slice(
      stationResumeMark,
    );
    const stationResumeQueues = stationResumeTransitions.filter(
      (item) => item.type === "setQueue",
    );
    const stationUrlQueue = stationResumeQueues.find(
      (item) => item.options?.url,
    );
    const resumeQueue = stationResumeQueues.find((item) => !item.options?.url);
    const stationResumeSeekTransition = stationResumeTransitions.find(
      (item) => item.type === "seekToTime",
    );
    check(
      "Play after the failed station handoff resumes the saved songs at their position",
      stationResumed &&
        stationResumeSeek &&
        !stationUrlQueue &&
        JSON.stringify(resumeQueue?.ids) ===
          JSON.stringify(RESTORED_IDS.slice(0, 16)) &&
        Math.abs(
          (stationResumeSeekTransition?.seconds ?? -1) - RESTORED_POSITION,
        ) < 0.001,
      {
        stationResumed,
        stationResumeSeek,
        stationUrlQueue,
        resumeQueue,
        seek: stationResumeSeekTransition,
        transitions: stationResumeTransitions.map((item) => item.type),
      },
    );

    // A Play Next pressed while a Play is still replacing the provider queue
    // must queue into the new queue, in order, not the queue being replaced.
    await fixtureCall(page, "reset");
    await dismissToasts(page);
    await page.evaluate(
      `location.hash = "#/playlist/${PLAYLIST_ID}"; return true;`,
    );
    const raceRows = await waitFor(
      page,
      `document.querySelectorAll(".library-track-row").length >= 4`,
    );
    await page.evaluate(
      `document.querySelectorAll(".library-track-row")[0]?.click(); return true;`,
    );
    await waitFor(page, `${TITLE} === "Track A"`, 15_000);
    await fixtureCall(page, "configure", [{ holdSetQueue: true }]);
    const raceMark = (await snapshot(page)).transitions.length;
    // Row 1 starts a new Play; its provider queue setup is held.
    await page.evaluate(
      `document.querySelectorAll(".library-track-row")[1]?.click(); return true;`,
    );
    const raceHeld = await waitFor(
      page,
      `${FIXTURE}.snapshot().queueEdit.setQueueHeld >= 1`,
      10_000,
    );
    // While that setup is still in flight, ask for the album to play next.
    await fixtureCall(page, "selectContext", [
      { id: "album-1", kind: "album", source: "library" },
    ]);
    const raceMenu = await waitFor(
      page,
      `document.querySelector('.context-menu [data-menu-item="play-next-collection"]:not(:disabled)')`,
      10_000,
    );
    await page.evaluate(
      `document.querySelector('.context-menu [data-menu-item="play-next-collection"]')?.click(); return true;`,
    );
    await fixtureCall(page, "releaseSetQueue");
    const raceSettled = await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.slice(${raceMark}).some((item) => item.type === "play")`,
      15_000,
    );
    const raceInserted = await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.slice(${raceMark}).some((item) => item.type === "playNext")`,
      15_000,
    );
    const raceSnap = await snapshot(page);
    const raceIds = raceSnap.queue.items.map((item) => item.id);
    const raceActive = raceIds.indexOf(raceSnap.queue.activeId);
    const racePlayNext = raceSnap.transitions
      .slice(raceMark)
      .find((item) => item.type === "playNext");
    const raceExpected = ["album-a", "album-b", "album-c", "album-d"];
    check(
      "Play Next during a slow Play queues into the new queue in order",
      raceRows &&
        raceHeld &&
        raceMenu &&
        raceSettled &&
        raceInserted &&
        raceActive >= 0 &&
        JSON.stringify(racePlayNext?.ids) === JSON.stringify(raceExpected) &&
        JSON.stringify(raceIds.slice(raceActive + 1, raceActive + 5)) ===
          JSON.stringify(raceExpected),
      {
        raceHeld,
        raceMenu,
        raceSettled,
        raceInserted,
        active: raceSnap.queue.activeId,
        playNextIds: racePlayNext?.ids,
        ids: raceIds,
      },
    );
    await fixtureCall(page, "configure", [{ holdSetQueue: false }]);

    // Leave no seeded restore for the harness's later relaunch checks.
    await fixtureCall(page, "reset");
    await dismissToasts(page);
    fs.rmSync(sessionFile, { force: true });
    fs.rmSync(`${sessionFile}.bak`, { force: true });
  } finally {
    await fixtureCall(page, "reset");
    await fixtureCall(page, "configure", [
      { unresolvedIds: [], unplayableIds: [] },
    ]);
    await dismissToasts(page);
  }
}
