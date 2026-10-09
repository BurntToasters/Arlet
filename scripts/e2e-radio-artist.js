/* Failure modes live in docs/TESTING.md ("Radio and artist pages"). */

const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SONG_STATION_URL =
  "https://music.apple.com/us/station/navigation-song-station/ra.song-one";
const TOP_IDS = ["top-1", "top-2", "top-3"];
const EXPECTED_SHORTCUTS = [
  "Space",
  "Ctrl+→",
  "Ctrl+←",
  "Ctrl+↑",
  "Ctrl+↓",
  "Shift+→",
  "Shift+←",
  "M",
  "Esc",
  "Ctrl+K",
  "Ctrl+R",
  "Alt+←",
  "Alt+→",
];

function fixtureCall(page, method, args = []) {
  return page.evaluate(`
    const fixture = ${FIXTURE};
    return await fixture[${JSON.stringify(method)}](...${JSON.stringify(args)});
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
const transitionsOf = async (page) => (await snapshot(page)).transitions;
const queuesOf = (transitions) =>
  transitions.filter((item) => item.type === "setQueue");

async function openMenuAndClick(page, target, itemId) {
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

async function clickHeroButton(page, label) {
  return page.evaluate(`
    const button = [...document.querySelectorAll('.library-detail-actions button')]
      .find((node) => node.textContent.trim() === ${JSON.stringify(label)});
    if (!button) return false;
    button.click();
    return true;
  `);
}

const topSongTitles = (page) =>
  page.evaluate(`
    return [...document.querySelectorAll('.artist-top-songs .library-row-copy strong')]
      .map((node) => node.textContent.trim());
  `);

/** Run radio, whole-item queueing, artist page, and shortcut-list checks. */
export async function runRadioArtist({ page, check }) {
  // Song station: the station URL is queued once, then played.
  await fixtureCall(page, "reset");
  await fixtureCall(page, "setCurrentTrack", ["song-a"]);
  const clicked = await openMenuAndClick(page, "nav-multi", "start-station");
  await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.some((item) => item.type === "setQueue" && item.options?.url)`,
  );
  await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.at(-1)?.type === "play"`,
  );
  let transitions = await transitionsOf(page);
  let queued = queuesOf(transitions).at(-1);
  check(
    "Start Station on a song queues its station URL and plays",
    clicked &&
      queued?.options?.url === SONG_STATION_URL &&
      transitions.at(-1)?.type === "play",
    { clicked, queued, last: transitions.at(-1) },
  );
  let requests = (await snapshot(page)).requests;
  check(
    "song station lookup uses the catalog song with include=station",
    requests.some(
      (item) =>
        item.path === "/v1/catalog/us/songs/nav-multi" &&
        item.query?.include === "station",
    ),
    { paths: requests.map((item) => item.path) },
  );

  // A second request for the same song reuses the cached lookup.
  await openMenuAndClick(page, "nav-multi", "start-station");
  await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.filter((item) => item.type === "setQueue").length >= 2`,
  );
  requests = (await snapshot(page)).requests;
  check(
    "repeat Start Station on the same song reuses the cached lookup",
    requests.filter(
      (item) =>
        item.path === "/v1/catalog/us/songs/nav-multi" &&
        item.query?.include === "station",
    ).length === 1,
    { count: requests.length },
  );

  // A library song without a catalog ID reports and queues nothing.
  await fixtureCall(page, "reset");
  await fixtureCall(page, "setCurrentTrack", ["song-a"]);
  await openMenuAndClick(page, "i.library-only", "start-station");
  const toasted = await waitFor(
    page,
    `[...document.querySelectorAll('.action-toast-message')].some((node) => node.textContent.includes("No station is available for this song"))`,
  );
  transitions = await transitionsOf(page);
  requests = (await snapshot(page)).requests;
  check(
    "library song without a catalog ID reports no station and never queues",
    toasted &&
      queuesOf(transitions).length === 0 &&
      !requests.some((item) => item.path.includes("i.library-only")),
    { toasted, transitions },
  );

  // A lookup that finishes after other playback started is dropped.
  await fixtureCall(page, "reset");
  await fixtureCall(page, "setCurrentTrack", ["song-a"]);
  await fixtureCall(page, "configure", [
    { delayPaths: ["/v1/catalog/us/songs/nav-delayed"], delayMs: 900 },
  ]);
  await openMenuAndClick(page, "nav-delayed", "start-station");
  await openMenuAndClick(page, "song-e", "play-now");
  await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.some((item) => item.type === "setQueue" && item.ids?.[0] === "song-e")`,
  );
  await sleep(1300);
  transitions = await transitionsOf(page);
  const finalQueue = queuesOf(transitions);
  check(
    "a station lookup that resolves after other playback started is dropped",
    finalQueue.length === 1 && finalQueue[0].ids[0] === "song-e",
    { finalQueue },
  );
  await fixtureCall(page, "configure", [{ delayPaths: [] }]);

  // Whole album and playlist queueing never interrupts the current song.
  await fixtureCall(page, "reset");
  await fixtureCall(page, "setCurrentTrack", ["song-a"]);
  const before = (await transitionsOf(page)).length;
  await openMenuAndClick(
    page,
    { id: "album-1", kind: "album", source: "library" },
    "play-next-collection",
  );
  await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.some((item) => item.type === "playNext")`,
  );
  let snap = await snapshot(page);
  const added = snap.transitions.slice(before);
  check(
    "album Play next inserts every page after the current song without restarting",
    JSON.stringify(snap.queue.items.map((item) => item.id)) ===
      JSON.stringify(["song-a", "album-a", "album-b", "album-c", "album-d"]) &&
      added.every((item) => item.type === "playNext") &&
      snap.queue.activeId === "song-a",
    { queue: snap.queue.items.map((item) => item.id), added },
  );

  await openMenuAndClick(
    page,
    { id: "playlist-1", kind: "playlist", source: "library" },
    "play-later-collection",
  );
  await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.some((item) => item.type === "playLater")`,
  );
  snap = await snapshot(page);
  const queueIds = snap.queue.items.map((item) => item.id);
  check(
    "playlist Play later appends every page in order at the end",
    JSON.stringify(queueIds.slice(5)) ===
      JSON.stringify([
        "song-a",
        "song-duplicate",
        "song-c",
        "song-duplicate",
        "song-e",
        "song-f",
      ]) &&
      !snap.transitions.slice(before).some((item) => item.type === "setQueue"),
    { queueIds },
  );

  // Library artist: the catalog artist is resolved before top songs load.
  await fixtureCall(page, "reset");
  await page.evaluate(
    `location.hash = "#/artist/nav-artist-one"; return true;`,
  );
  const listed = await waitFor(
    page,
    `document.querySelectorAll('.artist-top-songs .library-row-copy').length === 3`,
  );
  requests = (await snapshot(page)).requests;
  check(
    "library artist top songs load through the catalog artist and list in order",
    listed &&
      JSON.stringify(await topSongTitles(page)) ===
        JSON.stringify(["Top Song 1", "Top Song 2", "Top Song 3"]) &&
      requests.some(
        (item) =>
          item.path === "/v1/catalog/us/artists/nav-artist-two/view/top-songs",
      ) &&
      !requests.some((item) =>
        item.path.startsWith("/v1/catalog/us/artists/nav-artist-one"),
      ),
    { listed, paths: requests.map((item) => item.path) },
  );

  const playClicked = await clickHeroButton(page, "Play");
  await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.some((item) => item.type === "setQueue")`,
  );
  await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.at(-1)?.type === "play"`,
  );
  transitions = await transitionsOf(page);
  queued = queuesOf(transitions).at(-1);
  check(
    "artist Play queues the top songs in order from the first",
    JSON.stringify(queued?.ids) === JSON.stringify(TOP_IDS) &&
      queued?.index === 0 &&
      transitions.at(-1)?.type === "play",
    {
      queued,
      playClicked,
      toasts: await page.evaluate(
        `return [...document.querySelectorAll('.action-toast-message')].map((node) => node.textContent);`,
      ),
    },
  );

  await fixtureCall(page, "reset");
  await clickHeroButton(page, "Shuffle");
  await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.some((item) => item.type === "setQueue")`,
  );
  snap = await snapshot(page);
  queued = queuesOf(snap.transitions).at(-1);
  check(
    "artist Shuffle turns shuffle on and queues every top song",
    snap.modes.shuffle === true &&
      JSON.stringify([...(queued?.ids ?? [])].sort()) ===
        JSON.stringify([...TOP_IDS].sort()),
    { modes: snap.modes, queued },
  );

  await fixtureCall(page, "reset");
  await clickHeroButton(page, "Station");
  await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.some((item) => item.type === "setQueue")`,
  );
  snap = await snapshot(page);
  queued = queuesOf(snap.transitions).at(-1);
  check(
    "artist Station falls back to the station ID when no URL exists",
    JSON.stringify(queued?.options) ===
      JSON.stringify({ station: "ra.artist-two" }) &&
      snap.requests.some(
        (item) =>
          item.path === "/v1/catalog/us/artists/nav-artist-two" &&
          item.query?.include === "station",
      ),
    { queued },
  );

  // Moving to another artist never shows the previous artist's songs.
  await fixtureCall(page, "configure", [
    { delayPaths: ["/view/top-songs"], delayMs: 900 },
  ]);
  await page.evaluate(
    `location.hash = "#/artist/nav-artist-two?source=catalog"; return true;`,
  );
  await waitFor(page, `location.hash.includes("nav-artist-two")`);
  await sleep(150);
  await page.evaluate(`location.hash = "#/artist/nav-empty"; return true;`);
  await waitFor(page, `location.hash === "#/artist/nav-empty"`);
  await sleep(1400);
  check(
    "a late top-songs response for a previous artist is dropped",
    (await topSongTitles(page)).length === 0,
    { titles: await topSongTitles(page) },
  );

  // A failing top-songs request hides the section but keeps the page.
  await fixtureCall(page, "configure", [
    { delayPaths: [], rejectPaths: ["/view/top-songs"] },
  ]);
  await page.evaluate(
    `location.hash = "#/artist/nav-artist-two?source=catalog"; return true;`,
  );
  await waitFor(
    page,
    `document.querySelector('.library-detail-hero h1')?.textContent === "Artist Two"`,
  );
  await sleep(400);
  check(
    "top songs failure hides the section and keeps the artist page usable",
    (await topSongTitles(page)).length === 0 &&
      (await page.evaluate(
        `return Boolean(document.querySelector('.library-detail-actions .secondary-button'));`,
      )),
  );
  await fixtureCall(page, "configure", [{ rejectPaths: [] }]);

  // Settings lists every shortcut.
  await page.evaluate(`location.hash = "#/settings"; return true;`);
  await waitFor(page, `document.querySelector('.shortcut-list')`);
  const keys = await page.evaluate(`
    return [...document.querySelectorAll('.shortcut-row dt kbd')].map((node) => node.textContent.trim());
  `);
  check(
    "Settings lists every keyboard shortcut",
    JSON.stringify(keys) === JSON.stringify(EXPECTED_SHORTCUTS),
    { keys },
  );
  await page.evaluate(`location.hash = "#/home"; return true;`);
}
