/* Failure modes live in docs/TESTING.md ("Unavailable songs"). The fixture
 * mirrors MusicKit's item loader: an unresolved ID rejects the whole call with
 * NOT_FOUND, and an unplayable ID is dropped without an error. */

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixtureCall(page, method, args = []) {
  return page.evaluate(`
    return await ${FIXTURE}[${JSON.stringify(method)}](...${JSON.stringify(args)});
  `);
}

async function waitFor(page, expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(`return Boolean(${expression});`)) return true;
    await sleep(50);
  }
  return false;
}

const snapshot = (page) => fixtureCall(page, "snapshot");
const toastText = (page) =>
  page.evaluate(
    `return [...document.querySelectorAll('.action-toast-message')].map((node) => node.textContent).join(" | ");`,
  );

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

export async function runUnavailable({ page, check }) {
  try {
    // One removed song: the playlist plays from the chosen duplicate anyway.
    await playRow(page, 3, { unresolvedIds: ["song-c"] });
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
          JSON.stringify(PLAYLIST_IDS.filter((id) => id !== "song-c")) &&
        snap.queue.index === 2 &&
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
      snap.queue.index === 2 &&
        snap.queue.activeId === "song-duplicate" &&
        (await page.evaluate(`return ${TITLE};`)) === "Duplicate Occurrence",
      { index: snap.queue.index, activeId: snap.queue.activeId },
    );

    // An unplayable song MusicKit drops silently must not shift the start.
    await playRow(page, 3, { unplayableIds: ["song-a"] });
    await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.some((item) => item.type === "play")`,
    );
    snap = await snapshot(page);
    check(
      "a silently dropped song does not shift the chosen start",
      snap.queue.items.length === 5 &&
        snap.queue.index === 2 &&
        snap.queue.activeId === "song-duplicate" &&
        snap.transitions.some(
          (item) => item.type === "selectIndex" && item.index === 2,
        ),
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
      `document.querySelector(".library-detail-hero h1")?.textContent === "Big Playlist"`,
      15_000,
    );

    await page.evaluate(`
      [...document.querySelectorAll(".library-detail-actions button")]
        .find((node) => node.textContent.trim() === "Play all")?.click();
      return true;
    `);
    await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.some((item) => item.type === "play")`,
      20_000,
    );
    snap = await snapshot(page);
    queued = snap.transitions.filter((item) => item.type === "setQueue");
    const capped = queued.at(-1)?.ids ?? [];
    check(
      "a huge playlist queues at most 500 songs and skips unstreamable ones",
      capped.length === 499 &&
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

    // Near the end of the capped queue the next songs are appended once.
    await page.evaluate(`
      if (!document.querySelector(".queue-drawer")) {
        document.querySelector('button[aria-label="Toggle Playing Next"]')?.click();
      }
      return true;
    `);
    const restShown = await waitFor(
      page,
      `document.querySelector(".queue-rest-note")?.textContent?.includes("700 more songs")`,
    );
    await page.evaluate(
      "await window.MusicKit.getInstance().changeToMediaAtIndex(450); return true;",
    );
    const refilled = await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.some((item) => item.type === "playLater")`,
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
      restShown &&
        refilled &&
        refills.length === 1 &&
        refills[0].ids.length === 200 &&
        refills[0].ids[0] === "big-0500" &&
        snap.queue.activeId === "big-0451" &&
        String(restAfter).includes("500 more songs"),
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
      shuffledIds.length >= 499 &&
        shuffledIds.length <= 500 &&
        farIndexes > 0 &&
        snap.modes.shuffle === true,
      { length: shuffledIds.length, farIndexes, shuffle: snap.modes.shuffle },
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
  } finally {
    await fixtureCall(page, "reset");
    await fixtureCall(page, "configure", [
      { unresolvedIds: [], unplayableIds: [] },
    ]);
    await dismissToasts(page);
  }
}
