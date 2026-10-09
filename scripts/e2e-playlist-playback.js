#!/usr/bin/env node

const PLAYLIST_ID = "playlist-1";
const ALBUM_ID = "album-1";
const SECOND_PLAYLIST_PAGE =
  "/v1/me/library/playlists/playlist-1/tracks?offset=4";

async function waitFor(page, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(`return Boolean(${expression});`)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function ids(snapshot) {
  return snapshot.queue?.items?.map((item) => item.id) ?? [];
}

function currentIndex(snapshot) {
  return snapshot.queue?.index ?? -1;
}

/** Exercises the real detail rows and player against the injected MusicKit fixture. */
export async function runPlaylistPlayback({ page, check }) {
  await page.evaluate(`
    const fixture = window.__ARLET_E2E_MUSIC__;
    fixture.reset();
    location.hash = "#/playlist/${PLAYLIST_ID}";
    return true;
  `);

  const playlistRowsReady = await waitFor(
    page,
    `document.querySelectorAll(".library-track-row").length >= 4`,
  );
  check("playlist detail renders its first page", playlistRowsReady);
  if (!playlistRowsReady) return;

  await page.evaluate(`
    const shuffle = document.querySelector('button[aria-label="Toggle shuffle"]');
    const repeat = document.querySelector('button[aria-label="Repeat off"]');
    shuffle?.click();
    repeat?.click();
    return true;
  `);
  const modesApplied = await waitFor(
    page,
    `document.querySelector('button[aria-label="Toggle shuffle"]')?.getAttribute("aria-pressed") === "true" && document.querySelector('button[aria-label="Repeat all"]')`,
  );
  const modesReady = await page.evaluate(`
    return {
      shuffle: document.querySelector('button[aria-label="Toggle shuffle"]')?.getAttribute("aria-pressed"),
      repeat: Boolean(document.querySelector('button[aria-label="Repeat all"]')),
    };
  `);
  check(
    "shuffle and repeat are enabled before collection playback",
    modesApplied && modesReady.shuffle === "true" && modesReady.repeat,
    modesReady,
  );

  const clicked = await page.evaluate(`
    const rows = [...document.querySelectorAll(".library-track-row")];
    rows[3]?.click();
    return { count: rows.length, selectedLabel: rows[3]?.getAttribute("aria-label") };
  `);
  const playlistStarted = await waitFor(
    page,
    `document.querySelector(".player-bar .player-track-copy strong")?.textContent === "Duplicate Occurrence"`,
  );
  const playlistSnapshot = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot();",
  );
  const expectedPlaylistIds = [
    "song-a",
    "song-duplicate",
    "song-c",
    "song-duplicate",
    "song-e",
    "song-f",
  ];
  check(
    "middle playlist occurrence keeps the full paginated queue and selects that duplicate",
    playlistStarted &&
      clicked.count >= 4 &&
      JSON.stringify(ids(playlistSnapshot)) ===
        JSON.stringify(expectedPlaylistIds) &&
      currentIndex(playlistSnapshot) === 3,
    {
      clicked,
      queue: playlistSnapshot.queue,
      transitions: playlistSnapshot.transitions,
      requests: playlistSnapshot.requests,
    },
  );

  await page.evaluate(`
    document.querySelector('button[aria-label="Toggle Playing Next"]')?.click();
    return true;
  `);
  const drawerReady = await waitFor(
    page,
    `document.querySelectorAll(".queue-drawer .queue-list li").length === 6`,
  );
  const drawer = await page.evaluate(`
    const list = document.querySelector(".queue-drawer .queue-list");
    const rows = [...(list?.querySelectorAll("li") ?? [])];
    const active = list?.querySelector('[aria-current="true"]');
    return {
      count: rows.length,
      activeIndex: active ? rows.indexOf(active.closest("li")) : -1,
      titles: rows.map((row) => row.querySelector(".queue-copy strong")?.textContent),
    };
  `);
  check(
    "Playing Next shows all playlist occurrences in order with the selected occurrence active",
    drawerReady &&
      drawer.activeIndex === 3 &&
      drawer.titles.filter((title) => title === "Duplicate Occurrence")
        .length === 2,
    drawer,
  );

  await page.evaluate(`
    document.querySelector('button[aria-label="Next track"]')?.click();
    return true;
  `);
  const nextAdvanced = await waitFor(
    page,
    `document.querySelector(".player-bar .player-track-copy strong")?.textContent === "Track C"`,
  );
  const afterNext = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot();",
  );
  await page.evaluate(`
    document.querySelector('button[aria-label="Previous track"]')?.click();
    return true;
  `);
  const previousRestored = await waitFor(
    page,
    `document.querySelector(".player-bar .player-track-copy strong")?.textContent === "Duplicate Occurrence"`,
  );
  const afterPrevious = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot();",
  );
  check(
    "shuffle can advance to a playlist occurrence before the clicked row and return",
    nextAdvanced &&
      previousRestored &&
      currentIndex(afterNext) === 2 &&
      currentIndex(afterPrevious) === 3 &&
      afterPrevious.modes.shuffle === true &&
      afterPrevious.modes.repeat === 1,
    {
      afterNext: afterNext.queue,
      afterPrevious: afterPrevious.queue,
      modes: afterPrevious.modes,
    },
  );

  await page.evaluate(`
    document.querySelector('button[aria-label="Toggle shuffle"]')?.click();
    return true;
  `);
  const shuffleDisabled = await waitFor(
    page,
    `document.querySelector('button[aria-label="Toggle shuffle"]')?.getAttribute("aria-pressed") === "false"`,
  );
  await page.evaluate(`
    document.querySelector('button[aria-label="Next track"]')?.click();
    return true;
  `);
  const linearNext = await waitFor(
    page,
    `document.querySelector(".player-bar .player-track-copy strong")?.textContent === "Track E"`,
  );
  const linearNextSnapshot = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot();",
  );
  await page.evaluate(`
    document.querySelector('button[aria-label="Previous track"]')?.click();
    return true;
  `);
  const linearPrevious = await waitFor(
    page,
    `document.querySelector(".player-bar .player-track-copy strong")?.textContent === "Duplicate Occurrence"`,
  );
  const linearPreviousSnapshot = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot();",
  );
  check(
    "shuffle off follows playlist order while preserving the clicked occurrence",
    shuffleDisabled &&
      linearNext &&
      linearPrevious &&
      currentIndex(linearNextSnapshot) === 4 &&
      currentIndex(linearPreviousSnapshot) === 3,
    { next: linearNextSnapshot.queue, previous: linearPreviousSnapshot.queue },
  );

  await page.evaluate(`
    document.querySelectorAll(".song-row-more")[2]?.click();
    return true;
  `);
  const rowMenuReady = await waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item="play-now"]')`,
  );
  await page.evaluate(`
    document.querySelector('.context-menu [data-menu-item="play-now"]')?.click();
    return true;
  `);
  const rowContextPlayStarted = await waitFor(
    page,
    `document.querySelector(".player-bar .player-track-copy strong")?.textContent === "Track C"`,
  );
  const rowContextPlay = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot();",
  );
  check(
    "track-row Play now keeps its playlist and occurrence context",
    rowMenuReady &&
      rowContextPlayStarted &&
      JSON.stringify(ids(rowContextPlay)) ===
        JSON.stringify(expectedPlaylistIds) &&
      currentIndex(rowContextPlay) === 2,
    { queue: rowContextPlay.queue, transitions: rowContextPlay.transitions },
  );

  await page.evaluate(`
    document.querySelectorAll(".song-row-more")[1]?.click();
    return true;
  `);
  const nextMenuReady = await waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item="play-next"]')`,
  );
  await page.evaluate(`
    document.querySelector('.context-menu [data-menu-item="play-next"]')?.click();
    return true;
  `);
  const afterPlayNext = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot();",
  );
  const nextInsertion = afterPlayNext.transitions
    .filter((transition) => transition.type === "playNext")
    .at(-1);
  await page.evaluate(`
    document.querySelectorAll(".song-row-more")[1]?.click();
    return true;
  `);
  const laterMenuReady = await waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item="play-later"]')`,
  );
  await page.evaluate(`
    document.querySelector('.context-menu [data-menu-item="play-later"]')?.click();
    return true;
  `);
  const afterPlayLater = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot();",
  );
  const laterInsertion = afterPlayLater.transitions
    .filter((transition) => transition.type === "playLater")
    .at(-1);
  check(
    "Play next and Play later from a playlist row insert only its selected song",
    nextMenuReady &&
      laterMenuReady &&
      JSON.stringify(nextInsertion?.ids) ===
        JSON.stringify(["song-duplicate"]) &&
      JSON.stringify(laterInsertion?.ids) ===
        JSON.stringify(["song-duplicate"]),
    { nextInsertion, laterInsertion },
  );

  const workingQueue = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot();",
  );
  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.configure({ repeatPlaylistCursor: true });
    document.querySelectorAll(".library-track-row")[0]?.click();
    return true;
  `);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterRepeatedCursor = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot();",
  );
  check(
    "repeated playlist cursor stops safely without replacing the current queue",
    JSON.stringify(ids(afterRepeatedCursor)) ===
      JSON.stringify(ids(workingQueue)) &&
      currentIndex(afterRepeatedCursor) === currentIndex(workingQueue) &&
      afterRepeatedCursor.transitions.filter((item) => item.type === "setQueue")
        .length ===
        workingQueue.transitions.filter((item) => item.type === "setQueue")
          .length,
    {
      before: workingQueue.queue,
      after: afterRepeatedCursor.queue,
      requests: afterRepeatedCursor.requests.slice(
        workingQueue.requests.length,
      ),
    },
  );

  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.configure({
      repeatPlaylistCursor: false,
      rejectPaths: [${JSON.stringify(SECOND_PLAYLIST_PAGE)}],
    });
    document.querySelectorAll(".library-track-row")[1]?.click();
    return true;
  `);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterPageFailure = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot();",
  );
  check(
    "failed playlist page leaves the working queue intact",
    JSON.stringify(ids(afterPageFailure)) ===
      JSON.stringify(ids(workingQueue)) &&
      currentIndex(afterPageFailure) === currentIndex(workingQueue) &&
      afterPageFailure.transitions.filter((item) => item.type === "setQueue")
        .length ===
        workingQueue.transitions.filter((item) => item.type === "setQueue")
          .length,
    {
      before: workingQueue.queue,
      after: afterPageFailure.queue,
      requests: afterPageFailure.requests.slice(workingQueue.requests.length),
    },
  );

  await page.evaluate(`
    const fixture = window.__ARLET_E2E_MUSIC__;
    fixture.configure({ repeatPlaylistCursor: false, rejectPaths: [] });
    location.hash = "#/album/${ALBUM_ID}";
    return true;
  `);
  const albumRowsReady = await waitFor(
    page,
    `document.querySelectorAll(".library-track-row").length >= 2 && document.querySelector(".library-detail-hero h1")?.textContent === "Fixture Album"`,
  );
  check("album detail renders its first page", albumRowsReady);
  if (!albumRowsReady) return;

  await page.evaluate(`
    document.querySelectorAll(".library-track-row")[1]?.click();
    return true;
  `);
  const albumStarted = await waitFor(
    page,
    `document.querySelector(".player-bar .player-track-copy strong")?.textContent === "Album Track B"`,
  );
  const albumSnapshot = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot();",
  );
  check(
    "album detail row starts its selected track in the full paginated album queue",
    albumStarted &&
      JSON.stringify(ids(albumSnapshot)) ===
        JSON.stringify(["album-a", "album-b", "album-c", "album-d"]) &&
      currentIndex(albumSnapshot) === 1,
    {
      queue: albumSnapshot.queue,
      transitions: albumSnapshot.transitions,
      requests: albumSnapshot.requests,
    },
  );

  await page.evaluate(`
    document.querySelector('button[aria-label="Repeat all"]')?.click();
    return true;
  `);
  const repeatOneReady = await waitFor(
    page,
    `document.querySelector('button[aria-label="Repeat one"]')`,
  );
  await page.evaluate(`
    document.querySelector('button[aria-label="Repeat one"]')?.click();
    return true;
  `);
  const repeatOffReady = await waitFor(
    page,
    `document.querySelector('button[aria-label="Repeat off"]')`,
  );
  await page.evaluate(`
    document.querySelector('button[aria-label="Next track"]')?.click();
    document.querySelector('button[aria-label="Next track"]')?.click();
    return true;
  `);
  const albumAtEnd = await waitFor(
    page,
    `document.querySelector(".player-bar .player-track-copy strong")?.textContent === "Album Track D"`,
  );
  await page.evaluate(`
    await window.__ARLET_E2E_MUSIC__.finishCurrentTrack();
    return true;
  `);
  const repeatOffAtEnd = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot();",
  );
  check(
    "repeat off stops at the last album occurrence after natural completion",
    repeatOneReady &&
      repeatOffReady &&
      albumAtEnd &&
      repeatOffAtEnd.transitions.some((item) => item.type === "finishEnd") &&
      currentIndex(repeatOffAtEnd) === 3,
    {
      queue: repeatOffAtEnd.queue,
      transitions: repeatOffAtEnd.transitions.slice(-4),
    },
  );

  await page.evaluate(`
    document.querySelector('button[aria-label="Repeat off"]')?.click();
    return true;
  `);
  const repeatAllReady = await waitFor(
    page,
    `document.querySelector('button[aria-label="Repeat all"]')`,
  );
  await page.evaluate(`
    await window.__ARLET_E2E_MUSIC__.finishCurrentTrack();
    return true;
  `);
  const repeatAllAtStart = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot();",
  );
  check(
    "repeat all wraps to the beginning after natural completion",
    repeatAllReady &&
      repeatAllAtStart.transitions.some((item) => item.type === "finishWrap") &&
      currentIndex(repeatAllAtStart) === 0,
    {
      queue: repeatAllAtStart.queue,
      transitions: repeatAllAtStart.transitions.slice(-3),
    },
  );

  await page.evaluate(`
    document.querySelector('button[aria-label="Repeat all"]')?.click();
    return true;
  `);
  const repeatOneReadyAgain = await waitFor(
    page,
    `document.querySelector('button[aria-label="Repeat one"]')`,
  );
  await page.evaluate(`
    await window.__ARLET_E2E_MUSIC__.finishCurrentTrack();
    return true;
  `);
  const repeatOneSnapshot = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot();",
  );
  check(
    "repeat one retains the current occurrence after natural completion",
    repeatOneReadyAgain &&
      repeatOneSnapshot.transitions.some(
        (item) => item.type === "finishRepeatOne",
      ) &&
      currentIndex(repeatOneSnapshot) === 0,
    {
      queue: repeatOneSnapshot.queue,
      transitions: repeatOneSnapshot.transitions.slice(-3),
    },
  );
}
