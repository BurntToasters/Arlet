#!/usr/bin/env node

/* Catalog extras against the MusicKit fixture (docs/TESTING.md "Catalog
 * extras"): Replay shelves on Home with data and with none, a record label
 * page and the album link to it, an activity page capped at 10 playlists, the
 * record label and activity Search groups, the song Get Info dialog as plain
 * text, a playlist created inside a fixture folder, and the Edit in Apple Music
 * context-menu item: shown on an editable library playlist in the sidebar, the
 * playlist list, and the playlist page, and absent from every other area. Its
 * clicks land in the profile root's opened-links.jsonl, not in a browser.
 * Each check reads the fixture's recorded requests as well as the rendered
 * page. The run ends with a fixture reset; the runner's isolation guard then
 * checks the app is ready. */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureCall, sleep, waitFor } from "./e2e-helpers.js";

const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const REPLAY_PATH = "/v1/me/music-summaries";
const SEARCH_PATH = "/v1/catalog/us/search";
const ALBUM_ID = "album-1";
const LABEL_1 = { id: "rl-fixture-1", name: "Fixture Records" };
const LABEL_2 = { id: "rl-fixture-2", name: "Second Label" };
const LABEL_DESCRIPTION = "Independent fixture releases & reissues.";
const ACTIVITY_ID = "act-fixture-1";
const ACTIVITY_LIMIT = 10;
const FOLDER = { id: "lv-folder-road", name: "Road Trip" };
const NEW_PLAYLIST = "Catalog Extras Mix";
// Library song whose catalog twin has a numeric ID (fixture 1700000001).
const SONG_ID = "get-info-song";
const SONG_TITLE = "Info Track";
const SONG_ISRC = "USFIX2600009";
const REPLAY_TITLES = {
  "replay-songs": "Replay 2026: Top Songs",
  "replay-albums": "Replay 2026: Top Albums",
  "replay-artists": "Replay 2026: Top Artists",
};
// Apple result types the fixture answers for a search, and their group titles.
const SEARCH_RESULT_TITLES = {
  songs: "Songs",
  albums: "Albums",
  artists: "Artists",
  playlists: "Playlists",
  stations: "Stations",
  "apple-curators": "Curators",
};
// Edit in Apple Music: a library playlist's menu item calls open_subscribe_link
// with its music.apple.com link. The checks record that call and never forward
// it to Rust, so no browser page opens.
const EDIT_PLAYLIST = "playlist-1";
const EDIT_PLAYLIST_NAME = "Fixture Playlist";
const EDIT_URL = `https://music.apple.com/library/playlist/${encodeURIComponent(EDIT_PLAYLIST)}`;
const EDIT_ITEM = "edit-in-apple-music";
// The E2E build appends each link it would open to this file in the profile
// root (src-tauri/src/commands.rs, E2E_OPENED_LINKS_FILE), one JSON line each.
const OPENED_LINKS_FILE = "opened-links.jsonl";
const SIDEBAR_PIN = `.sidebar-group[aria-label="Pinned playlists"] .sidebar-link[data-context-id="${EDIT_PLAYLIST}"]`;
const PLAYLIST_HERO = "section.library-detail-hero";
const PLAYLIST_CARD = `.content-scroll [data-context-kind="playlist"][data-context-id="${EDIT_PLAYLIST}"] .library-card`;
const CHECKS = {
  replayData: "Replay shows this year's top songs, albums, and artists",
  replayEmpty: "Replay with no data shows an empty state, not an error",
  label: "a record label page shows its latest and top releases",
  albumLink:
    "an album's More section lines up with its header, and its record label opens its label page",
  activity: "an activity page lists its playlists",
  search: "Search shows record labels and activities",
  info: "Get Info shows the song's composer, ISRC, and label as plain text",
  folder: "New playlist can be created inside a folder",
  editShown:
    "Edit in Apple Music shows for an editable library playlist in the sidebar, the playlist list, and the playlist page, and opens its music.apple.com library link once",
  editAbsent:
    "Edit in Apple Music is absent from search results, albums, songs, catalog playlists, read-only playlists, and folders",
};

const q = (value) => JSON.stringify(value);
const snapshot = (page) => fixtureCall(page, "snapshot");
const sameList = (actual, expected) =>
  actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);

function pathOf(request) {
  return request.path.split("?", 1)[0];
}

/** Query parameters from the path and from the call's query object. */
function paramsOf(request) {
  const inPath = Object.fromEntries(
    new URLSearchParams(request.path.split("?")[1] ?? ""),
  );
  const given = Object.fromEntries(
    Object.entries(request.query ?? {}).map(([key, value]) => [
      key,
      String(value),
    ]),
  );
  return { ...inPath, ...given };
}

function summarize(request) {
  return {
    method: request.method,
    path: pathOf(request),
    params: paramsOf(request),
    status: request.status ?? null,
    error: request.error ?? null,
  };
}

async function mark(page) {
  const trace = await snapshot(page);
  return {
    requests: trace.requests.length,
    transitions: trace.transitions.length,
  };
}

/** Raw fixture requests made since a mark, with their responses. */
async function rawSince(page, at) {
  return (await snapshot(page)).requests.slice(at.requests);
}

/** The requests and transitions a group caused, for the groups trace. */
async function since(page, at) {
  const trace = await snapshot(page);
  return {
    requests: trace.requests.slice(at.requests).map(summarize),
    transitions: trace.transitions.slice(at.transitions),
  };
}

/** Runs one check; a throw becomes one failed check instead of a lost run. */
async function guarded(check, name, body) {
  try {
    await body();
  } catch (error) {
    check(name, false, String(error?.message ?? error));
  }
}

/** Runs one check and keeps the fixture requests and transitions it made. */
async function tracked(page, check, traces, key, name, body) {
  const at = await mark(page);
  try {
    await guarded(check, name, body);
  } finally {
    traces[key] = await since(page, at);
  }
}

function closeOverlays(page) {
  return page.evaluate(`
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;`);
}

function go(page, hash) {
  return page.evaluate(`location.hash = ${q(hash)}; return true;`);
}

/** Runs a statement body in the page and returns what it returns. */
function readPage(page, body) {
  return page.evaluate(`return (() => { ${body} })();`);
}

async function typeInto(page, selector, value) {
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

async function saveScreenshot(page, file) {
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  await writeFile(file, Buffer.from(shot.data, "base64"));
}

// The Refresh Home button is enabled once no Home load is in flight.
const REFRESH_HOME = `document.querySelector('button[aria-label="Refresh Home"]')`;
const REFRESH_HOME_IDLE = `(() => { const button = ${REFRESH_HOME}; return Boolean(button) && !button.disabled; })()`;

/** Refreshes Home once it is idle, so Replay is read again, not kept. */
async function refreshHome(page) {
  const idle = await waitFor(page, REFRESH_HOME_IDLE, 15_000);
  if (!idle) return false;
  await page.evaluate(`${REFRESH_HOME}.click(); return true;`);
  return true;
}

async function checkReplayData(page, check, artifactDir) {
  await closeOverlays(page);
  await go(page, "#/home");
  const at = await mark(page);
  const refreshed = await refreshHome(page);
  const shelfIds = Object.keys(REPLAY_TITLES);
  const shelves = await waitFor(
    page,
    `${q(shelfIds)}.every((id) => document.querySelector('[data-shelf="' + id + '"]'))`,
    15_000,
  );
  const titles = await readPage(
    page,
    `const out = {};
     for (const id of ${q(shelfIds)}) {
       out[id] = document.querySelector('[data-shelf="' + id + '"] h2')?.textContent.trim() ?? null;
     }
     return out;`,
  );
  await saveScreenshot(
    page,
    join(artifactDir, "screenshot-catalog-replay.png"),
  );
  const replayRequests = (await rawSince(page, at)).filter(
    (request) => pathOf(request) === REPLAY_PATH,
  );
  const yearOk =
    replayRequests.length > 0 &&
    replayRequests.every(
      (request) => paramsOf(request)["filter[year]"] === "latest",
    );
  const viewsOk = replayRequests.some((request) => {
    const views = String(paramsOf(request).views ?? "").split(",");
    return ["top-songs", "top-albums", "top-artists"].every((view) =>
      views.includes(view),
    );
  });
  const titlesOk = Object.entries(REPLAY_TITLES).every(
    ([id, title]) => titles[id] === title,
  );
  check(
    CHECKS.replayData,
    refreshed && shelves && yearOk && viewsOk && titlesOk,
    {
      refreshed,
      shelves,
      titles,
      requests: replayRequests.map(summarize),
    },
  );
}

async function checkReplayEmpty(page, check) {
  await fixtureCall(page, "configure", [{ replay: "empty" }]);
  try {
    await closeOverlays(page);
    await go(page, "#/home");
    const at = await mark(page);
    const refreshed = await refreshHome(page);
    const answered = await waitFor(
      page,
      `${FIXTURE}.snapshot().requests.slice(${at.requests}).some((item) => item.path.split("?", 1)[0] === ${q(REPLAY_PATH)} && item.completedAt !== undefined)`,
      15_000,
    );
    const settled = await waitFor(page, REFRESH_HOME_IDLE, 15_000);
    await sleep(500);
    const replayShelves = await readPage(
      page,
      `return document.querySelectorAll("[data-shelf^='replay-']").length;`,
    );
    const alerts = await readPage(
      page,
      `return [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent.trim());`,
    );
    const replayError = await readPage(
      page,
      `const text = document.querySelector(".app-shell")?.innerText ?? "";
       return /replay[^\\n]{0,60}(could not|unavailable|error|failed|try again)/i.test(text);`,
    );
    const replayRequests = (await rawSince(page, at)).filter(
      (request) => pathOf(request) === REPLAY_PATH,
    );
    const yearOk =
      replayRequests.length > 0 &&
      replayRequests.every(
        (request) => paramsOf(request)["filter[year]"] === "latest",
      );
    check(
      CHECKS.replayEmpty,
      refreshed &&
        answered &&
        settled &&
        yearOk &&
        replayShelves === 0 &&
        alerts.length === 0 &&
        replayError === false,
      {
        refreshed,
        answered,
        replayShelves,
        alerts,
        replayError,
        requests: replayRequests.map(summarize),
      },
    );
  } finally {
    await fixtureCall(page, "configure", [{ replay: "data" }]);
  }
}

const labelReady = (name) =>
  `(document.querySelector(".record-label-page h1")?.textContent.trim() === ${q(name)} && document.querySelectorAll(".record-label-page .library-card-copy strong").length === 6)`;

const LABEL_SHELF_TITLES = `(() => {
  const shelves = {};
  for (const id of ["latest-releases", "top-releases"]) {
    shelves[id] = [...document.querySelectorAll('[data-label-shelf="' + id + '"] .library-card-copy strong')].map((node) => node.textContent.trim());
  }
  return shelves;
})()`;

// Apple's album titles for a label view: "Fixture Records Latest 1" and so on.
const labelAlbumNames = (label, view) =>
  [1, 2, 3].map((number) => `${label.name} ${view} ${number}`);

async function checkLabelPage(page, check, artifactDir) {
  await closeOverlays(page);
  const at = await mark(page);
  await go(page, `#/label/${LABEL_1.id}`);
  const firstReady = await waitFor(page, labelReady(LABEL_1.name), 15_000);
  const first = await readPage(page, `return ${LABEL_SHELF_TITLES};`);
  const description = await readPage(
    page,
    `const node = document.querySelector(".record-label-page .library-detail-notes");
     return node ? { text: node.textContent.trim(), elements: node.querySelectorAll("*").length } : null;`,
  );
  await saveScreenshot(page, join(artifactDir, "screenshot-catalog-label.png"));
  const labelRequests = (await rawSince(page, at)).filter((request) =>
    pathOf(request).endsWith(`/record-labels/${LABEL_1.id}`),
  );
  const viewsOk = labelRequests.some(
    (request) => paramsOf(request).views === "latest-releases,top-releases",
  );
  const firstOk =
    sameList(first["latest-releases"], labelAlbumNames(LABEL_1, "Latest")) &&
    sameList(first["top-releases"], labelAlbumNames(LABEL_1, "Top"));
  const descriptionOk =
    description?.text === LABEL_DESCRIPTION && description.elements === 0;

  // Second label: none of the first label's albums may remain on its page.
  const secondMark = await mark(page);
  await go(page, `#/label/${LABEL_2.id}`);
  const secondReady = await waitFor(page, labelReady(LABEL_2.name), 15_000);
  const second = await readPage(page, `return ${LABEL_SHELF_TITLES};`);
  const leftover = [
    ...second["latest-releases"],
    ...second["top-releases"],
  ].filter((title) => title.startsWith(`${LABEL_1.name} `));
  const secondOk =
    sameList(second["latest-releases"], labelAlbumNames(LABEL_2, "Latest")) &&
    sameList(second["top-releases"], labelAlbumNames(LABEL_2, "Top"));
  check(
    CHECKS.label,
    firstReady &&
      viewsOk &&
      firstOk &&
      descriptionOk &&
      secondReady &&
      secondOk &&
      leftover.length === 0,
    {
      firstReady,
      first,
      description,
      viewsOk,
      requests: labelRequests.map(summarize),
      secondReady,
      second,
      leftover,
      secondRequests: (await rawSince(page, secondMark)).map(summarize),
    },
  );
}

async function checkAlbumLabelLink(page, check) {
  await closeOverlays(page);
  // Library albums have no record-labels relationship on Apple: album-1 links
  // its catalog twin, and the label comes from that twin.
  await fixtureCall(page, "configure", [{ albumCatalogTwin: true }]);
  try {
    await checkAlbumLabelLinkWithTwin(page, check);
  } finally {
    await fixtureCall(page, "configure", [{ albumCatalogTwin: false }]);
  }
}

async function checkAlbumLabelLinkWithTwin(page, check) {
  const at = await mark(page);
  await go(page, `#/album/${ALBUM_ID}`);
  const moreShown = await waitFor(
    page,
    `document.querySelector(".library-detail-more-toggle")`,
    15_000,
  );
  // The More section shares the header's centered column: same left edge.
  const edges = await readPage(
    page,
    `const hero = document.querySelector(".library-detail-hero")?.getBoundingClientRect();
     const more = document.querySelector(".library-detail-more")?.getBoundingClientRect();
     return hero && more ? { hero: hero.left, more: more.left } : null;`,
  );
  const aligned = edges !== null && Math.abs(edges.hero - edges.more) <= 1;
  await page.evaluate(
    `document.querySelector(".library-detail-more-toggle")?.click(); return true;`,
  );
  const selector = `a[aria-label=${q(`Record label: ${LABEL_1.name}`)}]`;
  const linkShown = await waitFor(
    page,
    `document.querySelector(${q(selector)})`,
    8_000,
  );
  const href = await readPage(
    page,
    `return document.querySelector(${q(selector)})?.getAttribute("href") ?? null;`,
  );
  await page.evaluate(
    `document.querySelector(${q(selector)})?.click(); return true;`,
  );
  const landed = await waitFor(
    page,
    `location.hash === ${q(`#/label/${LABEL_1.id}`)} && document.querySelector(".record-label-page h1")?.textContent.trim() === ${q(LABEL_1.name)}`,
    15_000,
  );
  const requests = await rawSince(page, at);
  const includesOf = (request) =>
    String(paramsOf(request).include ?? "").split(",");
  const albumRequests = requests.filter((request) =>
    pathOf(request).startsWith(`/v1/me/library/albums/${ALBUM_ID}`),
  );
  const twinRequests = requests.filter((request) =>
    pathOf(request).endsWith("/albums/cat-album-1"),
  );
  // Only the catalog twin is asked for its label.
  const libraryAsksLabel = albumRequests.some((request) =>
    includesOf(request).includes("record-labels"),
  );
  const twinAsksLabel = twinRequests.some((request) =>
    includesOf(request).includes("record-labels"),
  );
  check(
    CHECKS.albumLink,
    moreShown &&
      aligned &&
      linkShown &&
      href === `#/label/${LABEL_1.id}` &&
      landed &&
      !libraryAsksLabel &&
      twinAsksLabel,
    {
      moreShown,
      edges,
      linkShown,
      href,
      landed,
      libraryAsksLabel,
      twinAsksLabel,
      requests: albumRequests.map(summarize),
      twinRequests: twinRequests.map(summarize),
    },
  );
}

async function checkActivityPage(page, check, artifactDir) {
  await closeOverlays(page);
  const at = await mark(page);
  await go(page, `#/activity/${ACTIVITY_ID}`);
  const shown = await waitFor(
    page,
    `document.querySelectorAll('[aria-label="Activity playlists"] .library-card').length > 0`,
    15_000,
  );
  // Long enough for a follow-up page of playlists to land before counting.
  await sleep(1000);
  const names = await readPage(
    page,
    `return [...document.querySelectorAll('[aria-label="Activity playlists"] .library-card strong')].map((node) => node.textContent.trim());`,
  );
  await saveScreenshot(
    page,
    join(artifactDir, "screenshot-catalog-activity.png"),
  );
  const requests = await rawSince(page, at);
  const expectedNames = Array.from(
    { length: ACTIVITY_LIMIT },
    (_, index) => `Workout Mix ${index + 1}`,
  );
  const fetched = requests.some(
    (request) =>
      pathOf(request) === `/v1/catalog/us/activities/${ACTIVITY_ID}` &&
      paramsOf(request).include === "playlists",
  );
  const followedNext = requests.filter((request) =>
    pathOf(request).includes(`/activities/${ACTIVITY_ID}/playlists`),
  );
  const withOffset = requests.filter(
    (request) =>
      "offset" in paramsOf(request) || request.path.includes("offset"),
  );
  check(
    CHECKS.activity,
    shown &&
      fetched &&
      sameList(names, expectedNames) &&
      followedNext.length === 0 &&
      withOffset.length === 0,
    {
      shown,
      count: names.length,
      names,
      requests: requests.map(summarize),
    },
  );
}

/** Waits until the fixture has answered a catalog search for term since at. */
async function waitForSearch(page, at, term) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const answered = (await rawSince(page, at)).some(
      (request) =>
        pathOf(request) === SEARCH_PATH &&
        paramsOf(request).term === term &&
        request.completedAt !== undefined,
    );
    if (answered) return true;
    await sleep(100);
  }
  return false;
}

async function checkSearchGroups(page, check) {
  await closeOverlays(page);
  // Clear the search first. A term left by an earlier scenario (the shortcuts
  // scenario searches "?") would otherwise stay on screen, and an unchanged
  // term runs no search at all.
  await go(page, "#/search?q=");
  await waitFor(
    page,
    `document.querySelector(".search-form input")?.value === ""`,
    5000,
  );
  const at = await mark(page);
  await go(page, "#/search?q=fixture");
  const searched = await waitForSearch(page, at, "fixture");
  // Let the answer render before the groups are read.
  if (searched) await sleep(300);
  const shown = await waitFor(
    page,
    `document.querySelectorAll('[data-search-group="record-labels"] a.search-tile').length === 2 && document.querySelectorAll('[data-search-group="activities"] a.search-tile').length === 2`,
    15_000,
  );
  const rendered = await readPage(
    page,
    `const tiles = (kind) => [...document.querySelectorAll('[data-search-group="' + kind + '"] a.search-tile')].map((node) => node.getAttribute("href"));
     const heading = (kind) => document.querySelector('[data-search-group="' + kind + '"] h2')?.textContent.trim() ?? null;
     const others = [...document.querySelectorAll(".search-groups section:not([data-search-group])")];
     return {
       labelHrefs: tiles("record-labels"),
       activityHrefs: tiles("activities"),
       labelHeading: heading("record-labels"),
       activityHeading: heading("activities"),
       otherHeadings: others.map((section) => section.querySelector("h2")?.textContent.trim()).filter(Boolean),
       strayLinks: others.reduce((count, section) => count + section.querySelectorAll('a[href^="#/label/"], a[href^="#/activity/"]').length, 0),
     };`,
  );
  const requests = await rawSince(page, at);
  const searchRequest = requests
    .filter(
      (request) =>
        pathOf(request) === SEARCH_PATH &&
        String(paramsOf(request).types ?? "").includes("record-labels"),
    )
    .at(-1);
  const types = searchRequest
    ? String(paramsOf(searchRequest).types ?? "").split(",")
    : [];
  const typesOk = ["record-labels", "activities"].every((type) =>
    types.includes(type),
  );
  const results = searchRequest?.response?.results ?? {};
  const expectedOthers = Object.entries(SEARCH_RESULT_TITLES)
    .filter(([key]) => (results[key]?.data?.length ?? 0) > 0)
    .map(([, title]) => title)
    .sort();
  const renderedOthers = rendered.otherHeadings
    .filter((title) => Object.values(SEARCH_RESULT_TITLES).includes(title))
    .sort();
  const labelsOk = sameList(rendered.labelHrefs, [
    `#/label/${LABEL_1.id}`,
    `#/label/${LABEL_2.id}`,
  ]);
  const activitiesOk = sameList(rendered.activityHrefs, [
    `#/activity/${ACTIVITY_ID}`,
    "#/activity/act-fixture-2",
  ]);
  check(
    CHECKS.search,
    shown &&
      typesOk &&
      labelsOk &&
      activitiesOk &&
      rendered.labelHeading === "Record Labels" &&
      rendered.activityHeading === "Activities" &&
      rendered.strayLinks === 0 &&
      sameList(renderedOthers, expectedOthers),
    {
      shown,
      typesOk,
      rendered,
      expectedOthers,
      renderedOthers,
      requests: requests.map(summarize),
    },
  );
}

async function checkGetInfo(page, check, artifactDir) {
  await closeOverlays(page);
  await go(page, "#/home");
  const opened = await clickMenuItem(page, SONG_ID, "get-info");
  const shown = await waitFor(
    page,
    `document.querySelectorAll('.song-info-dialog .song-info-row').length > 0`,
    15_000,
  );
  const info = await readPage(
    page,
    `const dialog = document.querySelector(".song-info-dialog");
     return {
       role: dialog?.getAttribute("role") ?? null,
       label: dialog?.getAttribute("aria-label") ?? null,
       title: dialog?.querySelector("h2")?.textContent.trim() ?? null,
       rows: [...(dialog?.querySelectorAll(".song-info-row") ?? [])].map((row) => ({
         label: row.querySelector("dt")?.textContent.trim() ?? null,
         value: row.querySelector("dd")?.textContent.trim() ?? null,
       })),
       links: dialog?.querySelectorAll("a").length ?? -1,
       bold: dialog?.querySelectorAll("b").length ?? -1,
     };`,
  );
  await saveScreenshot(page, join(artifactDir, "screenshot-catalog-info.png"));
  await closeOverlays(page);
  const closed = await waitFor(
    page,
    `!document.querySelector(".song-info-dialog")`,
    8_000,
  );
  const valueOf = (label) =>
    info.rows.find((row) => row.label === label)?.value;
  check(
    CHECKS.info,
    opened &&
      shown &&
      closed &&
      info.role === "dialog" &&
      info.label === "Song info" &&
      info.title === SONG_TITLE &&
      valueOf("Composer") === "Composer A" &&
      valueOf("ISRC") === SONG_ISRC &&
      valueOf("Label") === LABEL_1.name &&
      valueOf("Copyright") === "℗ 2026 Fixture Records" &&
      info.links === 0 &&
      info.bold === 0,
    { opened, shown, closed, info },
  );
}

const folderOf = (id) =>
  `(() => {
    const node = [...document.querySelectorAll("[data-context-id]")].find((element) => element.getAttribute("data-context-id") === ${q(id)});
    const owner = node?.closest(".playlist-folder-content")?.parentElement;
    return owner?.querySelector(":scope > .playlist-folder-heading")?.getAttribute("data-context-id") ?? null;
  })()`;

async function checkFolderPlaylist(page, check) {
  await closeOverlays(page);
  await fixtureCall(page, "configure", [{ libraryView: true }]);
  await go(page, "#/library/playlists");
  const folderShown = await waitFor(
    page,
    `[...document.querySelectorAll(".playlist-folder-heading")].some((node) => node.textContent.includes(${q(FOLDER.name)}))`,
    15_000,
  );
  const at = await mark(page);
  // A context menu on the playlist area, not on a playlist or folder, offers
  // New playlist with no folder preselected.
  await page.evaluate(`
    const area = document.querySelector(".playlist-tree") ?? document.querySelector(".content-scroll");
    const rect = area.getBoundingClientRect();
    area.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 10 }));
    return true;`);
  const menuReady = await waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item="new-playlist"]')`,
  );
  if (menuReady) {
    await page.evaluate(
      `document.querySelector('.context-menu [data-menu-item="new-playlist"]').click(); return true;`,
    );
  }
  const formShown = await waitFor(
    page,
    `document.querySelector(".playlist-dialog-form select")`,
  );
  const optionsReady = await waitFor(
    page,
    `[...document.querySelectorAll(".playlist-dialog-form select option")].some((option) => option.value === ${q(FOLDER.id)})`,
    10_000,
  );
  const options = await readPage(
    page,
    `return [...document.querySelectorAll(".playlist-dialog-form select option")].map((option) => ({ value: option.value, text: option.textContent.trim() }));`,
  );
  const chosen = await page.evaluate(`
    const select = document.querySelector(".playlist-dialog-form select");
    if (!select) return null;
    select.value = ${q(FOLDER.id)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return select.value;`);
  const typed = await typeInto(
    page,
    ".playlist-dialog-form input[type='text']",
    NEW_PLAYLIST,
  );
  await page.evaluate(
    `document.querySelector(".playlist-dialog-form").requestSubmit(); return true;`,
  );
  const closed = await waitFor(
    page,
    `!document.querySelector(".playlist-dialog-backdrop")`,
    15_000,
  );
  const trace = await snapshot(page);
  const created = trace.playlistMutations.creates
    .filter((entry) => entry.name === NEW_PLAYLIST)
    .at(-1);
  const post = trace.requests
    .slice(at.requests)
    .find(
      (request) =>
        request.method === "POST" &&
        pathOf(request) === "/v1/me/library/playlists",
    );
  const postParent = post?.body?.relationships?.parent?.data?.[0]?.id ?? null;
  const shownIn = created
    ? await waitFor(page, `${folderOf(created.id)} === ${q(FOLDER.id)}`, 10_000)
    : false;
  const placedIn = created
    ? await readPage(page, `return ${folderOf(created.id)};`)
    : null;
  await closeOverlays(page);
  check(
    CHECKS.folder,
    folderShown &&
      menuReady &&
      formShown &&
      optionsReady &&
      chosen === FOLDER.id &&
      typed &&
      closed &&
      created?.parentId === FOLDER.id &&
      postParent === FOLDER.id &&
      shownIn,
    {
      folderShown,
      menuReady,
      formShown,
      options,
      chosen,
      typed,
      closed,
      created,
      postParent,
      placedIn,
    },
  );
}

/** Lines the E2E build appended to opened-links.jsonl in the profile root. */
async function openedLinks(profileRoot) {
  let text;
  try {
    text = await readFile(join(profileRoot, OPENED_LINKS_FILE), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** Waits until the file holds at least count lines, or the timeout passes. */
async function waitForLines(profileRoot, count, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await openedLinks(profileRoot)).length >= count) return true;
    await sleep(100);
  }
  return false;
}

/** Dispatches a real contextmenu event on the element, then waits for the menu. */
async function openMenuOn(page, selector) {
  // A row can re-render while a page is still loading and drop the first
  // event, so a menu that does not open gets one more right-click.
  let menu = await openMenuOnce(page, selector);
  if (menu.target && !menu.opened) {
    await closeMenu(page);
    await sleep(500);
    menu = await openMenuOnce(page, selector);
  }
  return menu;
}

/** Waits until the element's rect and the content scroll hold still. */
async function settleRect(page, selector) {
  let last = null;
  let stable = 0;
  for (let attempt = 0; attempt < 50 && stable < 3; attempt += 1) {
    await sleep(100);
    const sample = await page.evaluate(`
      const node = document.querySelector(${q(selector)});
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return [r.top, r.left, r.width, r.height, document.querySelector(".content-scroll")?.scrollTop ?? 0];`);
    if (!sample) return;
    stable =
      last && sample.every((value, index) => value === last[index])
        ? stable + 1
        : 0;
    last = sample;
  }
}

async function openMenuOnce(page, selector) {
  // A scroll that moves the row while a page still reflows would close the
  // menu, so scroll first, let the layout settle, then take fresh coordinates.
  const scrolled = await page.evaluate(`
    const node = document.querySelector(${q(selector)});
    if (!node) return false;
    node.scrollIntoView({ block: "center", inline: "nearest" });
    return true;`);
  if (scrolled) await settleRect(page, selector);
  const target = await page.evaluate(`
    const node = document.querySelector(${q(selector)});
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    node.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + Math.min(20, rect.width / 2),
      clientY: rect.top + Math.min(10, rect.height / 2),
    }));
    // The app resolves the menu target from the closest [data-context-kind].
    const context = node.closest("[data-context-kind]") ?? node;
    return {
      tag: context.tagName.toLowerCase(),
      kind: context.getAttribute("data-context-kind"),
      id: context.getAttribute("data-context-id"),
    };`);
  if (!target) return { target: null, opened: false, items: [] };
  const opened = await waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item]')`,
    5000,
  );
  // Ratings and lookups rebuild the items when they land; read them after that.
  if (opened) await sleep(300);
  const items = opened
    ? await readPage(
        page,
        `return [...document.querySelectorAll('.context-menu [data-menu-item]')].map((node) => node.getAttribute("data-menu-item"));`,
      )
    : [];
  return { target, opened, items };
}

/** Closes any open menu and waits until it is gone. */
async function closeMenu(page) {
  await closeOverlays(page);
  return waitFor(page, `!document.querySelector(".context-menu")`, 3000);
}

/** Clicks an enabled menu item; false when it is missing or disabled. */
async function clickMenuEntry(page, itemId) {
  const ready = await waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item="${itemId}"]:not(:disabled)')`,
    5000,
  );
  if (!ready) return false;
  await page.evaluate(
    `document.querySelector('.context-menu [data-menu-item="${itemId}"]').click(); return true;`,
  );
  return true;
}

/**
 * Clicks Edit in Apple Music once. The E2E build appends each opened link to
 * the profile root's file, so the lines added by this click are the calls.
 */
async function clickEditItem(page, profileRoot) {
  const before = (await openedLinks(profileRoot)).length;
  const clicked = await clickMenuEntry(page, EDIT_ITEM);
  if (clicked) await waitForLines(profileRoot, before + 1, 3000);
  // A second call from a double fire would land inside this window.
  await sleep(400);
  const calls = (await openedLinks(profileRoot)).slice(before);
  return { clicked, calls };
}

/** Opens the menu on an editable playlist area and clicks Edit in Apple Music. */
async function probeEditArea(page, selector, profileRoot) {
  const menu = await openMenuOn(page, selector);
  const present = menu.items.includes(EDIT_ITEM);
  const click = present
    ? await clickEditItem(page, profileRoot)
    : { clicked: false, calls: [] };
  const closed = await closeMenu(page);
  const onPlaylist = menu.target?.id === EDIT_PLAYLIST;
  return {
    selector,
    target: menu.target,
    items: menu.items,
    present,
    ...click,
    closed,
    ok:
      menu.opened &&
      onPlaylist &&
      present &&
      click.calls.length === 1 &&
      click.calls[0].url === EDIT_URL,
  };
}

/** Opens the menu on an area that must not offer Edit in Apple Music. */
async function probeAbsentArea(page, name, selector) {
  const menu = await openMenuOn(page, selector);
  const closed = await closeMenu(page);
  const edit = menu.items.includes(EDIT_ITEM);
  return {
    name,
    selector,
    target: menu.target,
    items: menu.items,
    edit,
    closed,
    ok: menu.opened && menu.items.length > 0 && !edit,
  };
}

/** Pins the playlist from its page header when it is not pinned yet. */
async function pinForCheck(page, state) {
  const menu = await openMenuOn(page, PLAYLIST_HERO);
  state.pin = {
    wasPinned: menu.items.includes("unpin-playlist"),
    pinnedByCheck: false,
  };
  if (menu.items.includes("pin-playlist")) {
    state.pin.pinnedByCheck = await clickMenuEntry(page, "pin-playlist");
  }
  await closeMenu(page);
}

/** Unpins the playlist again, only when this check pinned it. */
async function unpinForCheck(page, pin) {
  if (!pin?.pinnedByCheck) return null;
  await go(page, `#/playlist/${EDIT_PLAYLIST}`);
  await waitFor(
    page,
    `document.querySelector(".library-detail-hero h1")?.textContent.trim() === ${q(EDIT_PLAYLIST_NAME)}`,
    15_000,
  );
  const menu = await openMenuOn(page, PLAYLIST_HERO);
  const clicked = menu.items.includes("unpin-playlist")
    ? await clickMenuEntry(page, "unpin-playlist")
    : false;
  await closeMenu(page);
  const gone = await waitFor(
    page,
    `!document.querySelector(${q(SIDEBAR_PIN)})`,
    8000,
  );
  return { clicked, gone };
}

/**
 * Reloads the app, then sets the fixture's library configuration. The library
 * list loads once per session, so a mode switch needs a fresh load to show.
 */
async function reloadLibrary(page, options) {
  await page.evaluate("location.hash = '#/home'; return true;");
  await page.send("Page.reload", { ignoreCache: true });
  await sleep(1000);
  const ready = await waitFor(
    page,
    "window.__ARLET_E2E_MUSIC__ && document.querySelector('.app-shell .player-bar')",
    30_000,
  );
  await fixtureCall(page, "configure", [options]);
  return ready;
}

async function checkEditShown(page, check, profileRoot) {
  await closeOverlays(page);
  const linesBefore = (await openedLinks(profileRoot)).length;
  const state = {
    pin: null,
    sidebarShown: false,
    areas: {},
    calls: [],
    unpin: null,
    error: null,
  };
  try {
    await go(page, `#/playlist/${EDIT_PLAYLIST}`);
    await waitFor(
      page,
      `document.querySelector(".library-detail-hero h1")?.textContent.trim() === ${q(EDIT_PLAYLIST_NAME)}`,
      15_000,
    );
    await pinForCheck(page, state);
    state.sidebarShown = await waitFor(
      page,
      `document.querySelector(${q(SIDEBAR_PIN)})?.getAttribute("aria-label") === ${q(EDIT_PLAYLIST_NAME)}`,
      15_000,
    );
    state.areas.sidebar = await probeEditArea(page, SIDEBAR_PIN, profileRoot);
    state.areas.playlistPage = await probeEditArea(
      page,
      PLAYLIST_HERO,
      profileRoot,
    );
    await reloadLibrary(page, { libraryView: false });
    await go(page, "#/library/playlists");
    const cardShown = await waitFor(
      page,
      `document.querySelector(${q(PLAYLIST_CARD)})`,
      15_000,
    );
    state.areas.playlistList = {
      cardShown,
      ...(await probeEditArea(page, PLAYLIST_CARD, profileRoot)),
    };
  } catch (error) {
    state.error = String(error?.message ?? error);
  } finally {
    state.unpin = await unpinForCheck(page, state.pin).catch((error) => ({
      clicked: false,
      gone: false,
      error: String(error?.message ?? error),
    }));
    state.calls = (await openedLinks(profileRoot)).slice(linesBefore);
  }
  const areas = Object.values(state.areas);
  check(
    CHECKS.editShown,
    !state.error &&
      state.sidebarShown &&
      areas.length === 3 &&
      areas.every((area) => area.ok) &&
      state.calls.length === 3 &&
      (state.unpin === null || state.unpin.gone === true),
    state,
  );
}

async function checkEditAbsent(page, check, profileRoot) {
  await closeOverlays(page);
  await fixtureCall(page, "configure", [
    { libraryView: false, artworkGrid: false },
  ]);
  const linesBefore = (await openedLinks(profileRoot)).length;
  const probes = [];
  const state = { probes, calls: [], error: null };
  try {
    // Search: a catalog playlist tile. The fixture answers a catalog playlist
    // only for a term containing "polish"; "fixture" returns none.
    const catalogTile = `.content-scroll [data-context-kind="playlist"][data-context-source="catalog"]`;
    await go(page, "#/search?q=polish");
    await waitFor(page, `document.querySelector(${q(catalogTile)})`, 15_000);
    probes.push(
      await probeAbsentArea(page, "search: catalog playlist", catalogTile),
    );

    // Album: its hero and a song row.
    const albumHero = `section.library-detail-hero[data-context-kind="album"]`;
    const songRow = `.content-scroll [data-context-kind="track"]`;
    await go(page, `#/album/${ALBUM_ID}`);
    await waitFor(page, `document.querySelector(${q(albumHero)})`, 15_000);
    await waitFor(page, `document.querySelector(${q(songRow)})`, 15_000);
    probes.push(await probeAbsentArea(page, "album: hero", albumHero));
    probes.push(await probeAbsentArea(page, "album: song row", songRow));

    // Playlist page: a song row of the editable playlist itself.
    await go(page, `#/playlist/${EDIT_PLAYLIST}`);
    await waitFor(
      page,
      `document.querySelector(".library-detail-hero h1")?.textContent.trim() === ${q(EDIT_PLAYLIST_NAME)}`,
      15_000,
    );
    await waitFor(page, `document.querySelector(${q(songRow)})`, 15_000);
    probes.push(
      await probeAbsentArea(page, "playlist page: song row", songRow),
    );

    // Read-only library playlist (canEdit false) from the artwork grid.
    await reloadLibrary(page, { libraryView: false, artworkGrid: true });
    const readOnlyCard = `.content-scroll [data-context-kind="playlist"][data-context-id="lib-pl-art-1"] .library-card`;
    await go(page, "#/library/playlists");
    await waitFor(page, `document.querySelector(${q(readOnlyCard)})`, 15_000);
    probes.push(
      await probeAbsentArea(
        page,
        "library playlists: read-only card",
        readOnlyCard,
      ),
    );
    // Folder heading, in the library view that holds it.
    await reloadLibrary(page, { libraryView: true, artworkGrid: false });
    const folder = `.content-scroll .playlist-folder-heading[data-context-id="${FOLDER.id}"]`;
    await go(page, "#/library/playlists");
    await waitFor(page, `document.querySelector(${q(folder)})`, 15_000);
    probes.push(
      await probeAbsentArea(page, "library playlists: folder", folder),
    );
    await fixtureCall(page, "configure", [{ libraryView: false }]);

    // Home: a playlist card when Home has one, otherwise any card.
    const anyCard = `.content-scroll .card-shell[data-context-kind]`;
    const playlistCard = `.content-scroll .card-shell[data-context-kind="playlist"]`;
    await go(page, "#/home");
    await waitFor(page, `document.querySelector(${q(anyCard)})`, 15_000);
    const homeCard = await readPage(
      page,
      `return document.querySelector(${q(playlistCard)}) ? ${q(playlistCard)} : ${q(anyCard)};`,
    );
    probes.push(await probeAbsentArea(page, "home: card", homeCard));
  } catch (error) {
    state.error = String(error?.message ?? error);
  } finally {
    state.calls = (await openedLinks(profileRoot)).slice(linesBefore);
    await fixtureCall(page, "configure", [
      { libraryView: false, artworkGrid: false },
    ]);
  }
  check(
    CHECKS.editAbsent,
    !state.error &&
      probes.length === 7 &&
      probes.every((probe) => probe.ok) &&
      state.calls.length === 0,
    state,
  );
}

/** Groups trace, the fixture requests and transitions each check caused. */
export async function runCatalogExtras({
  page,
  check,
  artifactDir,
  profileRoot,
}) {
  const traces = {};
  try {
    await fixtureCall(page, "reset");
    await tracked(page, check, traces, "replayData", CHECKS.replayData, () =>
      checkReplayData(page, check, artifactDir),
    );
    await tracked(page, check, traces, "replayEmpty", CHECKS.replayEmpty, () =>
      checkReplayEmpty(page, check),
    );
    await tracked(page, check, traces, "label", CHECKS.label, () =>
      checkLabelPage(page, check, artifactDir),
    );
    await tracked(page, check, traces, "albumLink", CHECKS.albumLink, () =>
      checkAlbumLabelLink(page, check),
    );
    await tracked(page, check, traces, "activity", CHECKS.activity, () =>
      checkActivityPage(page, check, artifactDir),
    );
    await tracked(page, check, traces, "search", CHECKS.search, () =>
      checkSearchGroups(page, check),
    );
    await tracked(page, check, traces, "info", CHECKS.info, () =>
      checkGetInfo(page, check, artifactDir),
    );
    await tracked(page, check, traces, "folder", CHECKS.folder, () =>
      checkFolderPlaylist(page, check),
    );
    await tracked(page, check, traces, "editShown", CHECKS.editShown, () =>
      checkEditShown(page, check, profileRoot),
    );
    await tracked(page, check, traces, "editAbsent", CHECKS.editAbsent, () =>
      checkEditAbsent(page, check, profileRoot),
    );
  } finally {
    await writeFile(
      join(artifactDir, "catalog-extras-groups.json"),
      `${JSON.stringify(traces, null, 2)}\n`,
    );
    await closeOverlays(page);
    await fixtureCall(page, "reset");
  }
}
