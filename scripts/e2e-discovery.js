/* Apple Music discovery checks against the discovery fixture ids in
 * scripts/e2e-music-fixture.js. Each check names its failure mode in
 * docs/TESTING.md ("Apple Music discovery features"). Browser code runs as
 * strings inside the page, as in the other native scenarios. External sign-out
 * runs last and is undone in `finally`, so Session restore starts signed in. */

import fs from "node:fs";
import path from "node:path";
import { fixtureCall, sleep, waitFor } from "./e2e-helpers.js";

const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const ARTIST_PATH = "/v1/catalog/us/artists/artist-views";
const ARTIST_HASH = "#/artist/artist-views?source=catalog";
const ARTIST_VIEWS = [
  "compilation-albums",
  "featured-playlists",
  "full-albums",
  "latest-release",
  "live-albums",
  "appears-on-albums",
  "similar-artists",
  "singles",
  "top-songs",
];
const SEARCH_INPUT = '.search-form input[role="combobox"]';
const SUGGESTION_OPTIONS = '#search-suggestions-list [role="option"]';
const SUGGESTION_POPUP = ".search-suggestions";
const RECENT_KEY = "arlet.search.recent";
const SEEK = 'input[aria-label="Playback position"]';
const VOLUME = 'input[aria-label="Volume"]';
const LIVE_TEXT = ".player-track-links .live-metadata-text";
const POP_STATION_URL =
  "https://music.apple.com/us/station/pop-station-one/ra.genre-pop-1";
const BROWSE_SONGS = 'section[aria-labelledby="browse-songs-heading"]';

const q = (value) => JSON.stringify(value);
const at = (hash) => `location.hash === ${q(hash)}`;
const heroIs = (title) =>
  `document.querySelector("section.library-detail-hero h1")?.textContent?.trim() === ${q(title)}`;
const sectionFor = (title) =>
  `[...document.querySelectorAll("section")].find((node) => node.querySelector("h2")?.textContent?.trim() === ${q(title)})`;
const pathOnly = (item) => String(item.path).split("?")[0];
const pathsOf = (items) => items.map((item) => item.path);
const snapshot = (page) => fixtureCall(page, "snapshot");
const requestCount = async (page) => (await snapshot(page)).requests.length;
const sinceOf = (snap, index) => snap.requests.slice(index);
const sameList = (left, right) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

/** Runs one group; a throw becomes one failed check instead of a lost run. */
async function group(check, name, body) {
  try {
    await body();
  } catch (error) {
    check(`${name} completes`, false, String(error?.message ?? error));
  }
}

/** Visible text of every node a selector matches, in document order. */
const textOf = (page, selector) =>
  page.evaluate(
    `return [...document.querySelectorAll(${q(selector)})].map((node) => node.textContent.trim());`,
  );

async function openHash(page, hash, ready, timeoutMs = 12_000) {
  await page.evaluate(`location.hash = ${q(hash)}; return true;`);
  return waitFor(page, ready, timeoutMs);
}

async function home(page) {
  await page.evaluate(`location.hash = "#/home"; return true;`);
  await sleep(300);
}

/** Replaces the field's text: the selection is typed over, as a user would. */
async function typeInto(page, selector, text) {
  await page.evaluate(
    `const input = document.querySelector(${q(selector)}); if (!input) return false; input.focus(); input.select(); return true;`,
  );
  await page.send("Input.insertText", { text });
}

async function pressKey(page, key, code, keyCode, text) {
  const common = { key, code, windowsVirtualKeyCode: keyCode };
  await page.send("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    text,
    ...common,
  });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

async function setSelect(page, selector, value) {
  return page.evaluate(
    `const select = document.querySelector(${q(selector)}); if (!select) return null; select.value = ${q(value)}; select.dispatchEvent(new Event("change", { bubbles: true })); return select.value;`,
  );
}

/** Clicks the first button whose text matches, and reports whether it did. */
const clickByText = (page, selector, text) =>
  page.evaluate(
    `const node = [...document.querySelectorAll(${q(selector)})].find((item) => item.textContent.trim() === ${q(text)}); if (!node) return false; node.click(); return true;`,
  );

/** Clicks "Load more" until it is gone or the rows stop growing. */
async function loadAll(page, moreSelector, rowSelector, maxRounds = 6) {
  for (let round = 0; round < maxRounds; round += 1) {
    const before = await page.evaluate(
      `return document.querySelectorAll(${q(rowSelector)}).length;`,
    );
    const clicked = await page.evaluate(
      `const button = document.querySelector(${q(moreSelector)}); if (!button) return false; button.click(); return true;`,
    );
    if (!clicked) break;
    await waitFor(
      page,
      `document.querySelectorAll(${q(rowSelector)}).length > ${before} || !document.querySelector(${q(moreSelector)})`,
      8000,
    );
  }
}

/** Saved volume in settings.json, polled until it matches or time runs out. */
async function waitForSavedVolume(file, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(fs.readFileSync(file, "utf8")).volume;
      if (typeof last === "number" && Math.abs(last - expected) < 0.01) {
        return { saved: true, last };
      }
    } catch {
      // The file is written by the app; a missing or partial read is retried.
    }
    await sleep(100);
  }
  return { saved: false, last };
}

async function artistPage(page, check) {
  await fixtureCall(page, "reset");
  await home(page);
  const ready = await openHash(
    page,
    ARTIST_HASH,
    `${heroIs("Discovery Artist")} && document.querySelectorAll(".artist-albums .library-card").length >= 30`,
    20_000,
  );
  const snap = await snapshot(page);
  const artistRequests = snap.requests.filter(
    (item) => pathOnly(item) === ARTIST_PATH,
  );
  const views = String(artistRequests[0]?.query?.views ?? "")
    .split(",")
    .sort();
  const extend = String(artistRequests[0]?.query?.extend ?? "")
    .split(",")
    .sort();
  const refetched = snap.requests.filter(
    (item) =>
      pathOnly(item).endsWith("/albums") ||
      item.path.startsWith(`${ARTIST_PATH}/view/top-songs`),
  );
  check(
    "artist page makes one artist request when views succeed",
    ready &&
      artistRequests.length === 1 &&
      sameList(views, [...ARTIST_VIEWS].sort()) &&
      sameList(extend, ["editorialArtwork", "editorialNotes"]) &&
      refetched.length === 0,
    {
      ready,
      artistRequests: artistRequests.length,
      views,
      extend,
      refetched: pathsOf(refetched),
      paths: pathsOf(snap.requests),
    },
  );

  const names = await textOf(page, ".artist-albums .library-card-copy strong");
  const albumPages = snap.requests.filter((item) =>
    item.path.includes("/view/full-albums"),
  );
  check(
    "artist albums fill from the views with one next page and no duplicates",
    names.length === 30 &&
      new Set(names).size === 30 &&
      albumPages.length === 1 &&
      albumPages[0].path.includes("offset=25"),
    {
      albums: names.length,
      unique: new Set(names).size,
      pages: pathsOf(albumPages),
    },
  );

  const topSongs = await textOf(
    page,
    ".artist-top-songs .library-row-copy strong",
  );
  check(
    "artist top songs show the five inline songs, each once",
    topSongs.length === 5 && new Set(topSongs).size === 5,
    { topSongs },
  );

  const bio = await page.evaluate(`
    const notes = document.querySelector(".artist-bio .library-detail-notes");
    return {
      present: Boolean(notes),
      text: notes?.textContent ?? "",
      markupElements: notes ? notes.querySelectorAll("b, a, i, script").length : -1,
      scripts: document.querySelectorAll(".artist-bio script").length,
      scriptFlag: window.__ARLET_DISCOVERY_XSS__ === true,
    };
  `);
  check(
    "artist bio shows its markup as text and runs no script",
    bio.present &&
      bio.text.includes("markup") &&
      bio.markupElements === 0 &&
      bio.scripts === 0 &&
      !bio.scriptFlag,
    bio,
  );

  const banner = await page.evaluate(`
    const image = document.querySelector("img.artist-hero-banner, img.artist-hero-backdrop");
    return { className: image?.className ?? null, src: image?.getAttribute("src") ?? null };
  `);
  check(
    "artist banner comes from the editorial artwork",
    String(banner.src ?? "").includes("artist-views"),
    banner,
  );
}

async function artistFallback(page, check) {
  // Leave the views artist first, so its detail is read again with the
  // rejection in place rather than reused from memory.
  await fixtureCall(page, "reset");
  await home(page);
  await openHash(
    page,
    "#/artist/artist-views-sparse?source=catalog",
    heroIs("Sparse Discovery Artist"),
    20_000,
  );
  await fixtureCall(page, "reset");
  await fixtureCall(page, "configure", [{ rejectQueryKeys: ["views"] }]);
  try {
    const ready = await openHash(
      page,
      ARTIST_HASH,
      `${heroIs("Discovery Artist")} && document.querySelectorAll(".artist-albums .library-card").length >= 30 && document.querySelectorAll(".artist-top-songs .library-row-copy").length >= 5`,
      20_000,
    );
    // Each request must finish before the snapshot: the rejected views read,
    // the plain artist read, the albums page and the top-songs read.
    const settled = await waitFor(
      page,
      `(() => {
        const requests = window.__ARLET_E2E_MUSIC__.snapshot().requests;
        const done = (match) =>
          requests.some((item) => match(item) && (item.completedAt || item.error));
        const pathOf = (item) => item.path.split("?")[0];
        return (
          done((item) => item.error && item.query?.views !== undefined) &&
          done((item) => pathOf(item) === "/v1/catalog/us/artists/artist-views" && item.query?.views === undefined) &&
          done((item) => pathOf(item).endsWith("/artist-views/albums")) &&
          done((item) => pathOf(item).endsWith("/view/top-songs"))
        );
      })()`,
      20_000,
    );
    const snap = await snapshot(page);
    const rejected = snap.requests.filter(
      (item) => item.error && item.query?.views !== undefined,
    );
    const plain = snap.requests.filter(
      (item) =>
        pathOnly(item) === ARTIST_PATH &&
        item.query?.views === undefined &&
        item.completedAt,
    );
    check(
      "artist page falls back to its separate requests when views fail",
      ready &&
        settled &&
        rejected.length >= 1 &&
        plain.length >= 1 &&
        snap.requests.some(
          (item) => pathOnly(item) === `${ARTIST_PATH}/albums`,
        ) &&
        snap.requests.some((item) =>
          item.path.startsWith(`${ARTIST_PATH}/view/top-songs`),
        ),
      {
        ready,
        settled,
        rejected: rejected.length,
        plain: plain.length,
        paths: pathsOf(snap.requests),
      },
    );
  } finally {
    await fixtureCall(page, "configure", [{ rejectQueryKeys: [] }]);
  }
}

async function sparseArtist(page, check) {
  await fixtureCall(page, "reset");
  await home(page);
  // artistFallback visited this artist just before, so its hero can paint
  // from memory before any request goes out. Wait for a request that this
  // visit sent and finished, so the shelves are read from a fresh response.
  const ready = await openHash(
    page,
    "#/artist/artist-views-sparse?source=catalog",
    `${heroIs("Sparse Discovery Artist")} && document.querySelectorAll(".artist-albums .library-card").length >= 2`,
    20_000,
  );
  const fresh = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().requests.some((item) => item.path.split("?")[0] === "/v1/catalog/us/artists/artist-views-sparse" && item.completedAt)`,
    20_000,
  );
  const shelves = await page.evaluate(`
    return ["#artist-latest", "#artist-live", "#artist-singles", "#artist-compilations", "#artist-appears-on", "#artist-essentials", "#artist-similar"]
      .map((id) => [id, Boolean(document.querySelector(id))]);
  `);
  const bio = await page.evaluate(
    `return Boolean(document.querySelector(".artist-bio"));`,
  );
  const banner = await page.evaluate(
    `return Boolean(document.querySelector("img.artist-hero-banner"));`,
  );
  const snap = await snapshot(page);
  const requested = snap.requests.find(
    (item) => pathOnly(item) === "/v1/catalog/us/artists/artist-views-sparse",
  );
  check(
    "sparse artist hides the shelves Apple left out, along with its bio and banner",
    ready &&
      fresh &&
      shelves.every(([, present]) => present === false) &&
      bio === false &&
      banner === false &&
      requested?.query?.views?.includes("live-albums") === true,
    { ready, fresh, shelves, bio, banner, views: requested?.query?.views },
  );
}

async function libraryArtist(page, check) {
  await fixtureCall(page, "reset");
  await home(page);
  const ready = await openHash(
    page,
    "#/artist/library-artist-views",
    `${heroIs("Discovery Artist")} && document.querySelectorAll(".artist-albums .library-card").length >= 30`,
    20_000,
  );
  const snap = await snapshot(page);
  const library = snap.requests.filter(
    (item) => pathOnly(item) === "/v1/me/library/artists/library-artist-views",
  );
  const catalog = snap.requests.filter(
    (item) => pathOnly(item) === ARTIST_PATH,
  );
  check(
    "library artist reads its catalog twin, then the catalog views",
    ready &&
      library.some((item) => item.query?.include === "catalog") &&
      catalog.length === 1 &&
      String(catalog[0].query?.views ?? "").includes("full-albums"),
    { ready, library: pathsOf(library), catalog: pathsOf(catalog) },
  );
}

async function albumShelves(page, check) {
  await fixtureCall(page, "reset");
  await home(page);
  const ready = await openHash(
    page,
    "#/album/album-discover?source=catalog",
    `${at("#/album/album-discover?source=catalog")} && ${heroIs("Fixture Discovery Album")} && Boolean(document.getElementById("album-related"))`,
    20_000,
  );
  const rows = await textOf(page, "button.library-track-row");
  const shelves = await page.evaluate(`
    return ["album-other-versions", "album-related", "album-more-by"]
      .map((id) => [id, Boolean(document.getElementById(id))]);
  `);
  check(
    "album shelves keep all four tracks and hide the empty more-by-artist shelf",
    ready &&
      rows.length === 4 &&
      rows.every((text) => text.includes("Discovery Album Track")) &&
      shelves[0][1] === true &&
      shelves[1][1] === true &&
      shelves[2][1] === false,
    { ready, rows, shelves },
  );

  await fixtureCall(page, "reset");
  await home(page);
  const libraryReady = await openHash(
    page,
    "#/album/library-album-discover",
    `${at("#/album/library-album-discover")} && Boolean(document.getElementById("album-other-versions"))`,
    20_000,
  );
  const libraryRows = await textOf(page, "button.library-track-row");
  const snap = await snapshot(page);
  const catalogViews = snap.requests.find(
    (item) =>
      pathOnly(item) === "/v1/catalog/us/albums/album-discover" &&
      item.query?.views !== undefined,
  );
  check(
    "a library album keeps its tracks and loads the catalog album views",
    libraryReady && libraryRows.length === 4 && Boolean(catalogViews),
    {
      libraryReady,
      rows: libraryRows.length,
      views: catalogViews?.query?.views ?? null,
    },
  );
}

async function searchSuggestions(page, check) {
  await fixtureCall(page, "reset");
  await home(page);
  const ready = await openHash(
    page,
    "#/search",
    `Boolean(document.querySelector(${q(SEARCH_INPUT)}))`,
  );

  const sinceOne = await requestCount(page);
  await typeInto(page, SEARCH_INPUT, "p");
  await sleep(700);
  const oneChar = sinceOf(await snapshot(page), sinceOne).filter((item) =>
    pathOnly(item).endsWith("/search/suggestions"),
  );
  check(
    "a one-character term sends no suggestion request",
    ready && oneChar.length === 0,
    { suggestions: pathsOf(oneChar) },
  );

  await typeInto(page, SEARCH_INPUT, "pol");
  const shown = await waitFor(
    page,
    `document.querySelectorAll(${q(SUGGESTION_OPTIONS)}).length >= 3`,
    6000,
  );
  const labels = await textOf(page, SUGGESTION_OPTIONS);
  const openBefore = await page.evaluate(
    `return !document.querySelector(${q(SUGGESTION_POPUP)})?.hidden;`,
  );
  await pressKey(page, "Escape", "Escape", 27);
  const closed = await waitFor(
    page,
    `document.querySelector(${q(SUGGESTION_POPUP)})?.hidden === true`,
    3000,
  );
  check(
    "suggestions list terms and a top result, and Escape closes them",
    shown &&
      labels.some((label) => label.includes("Polish Fixture")) &&
      labels.some((label) => label.includes("Polka")) &&
      openBefore &&
      closed,
    { shown, labels, openBefore, closed },
  );

  await typeInto(page, SEARCH_INPUT, "pol");
  await waitFor(
    page,
    `document.querySelectorAll(${q(SUGGESTION_OPTIONS)}).length >= 3`,
    6000,
  );
  await pressKey(page, "Tab", "Tab", 9);
  const focus = await page.evaluate(`
    const active = document.activeElement;
    return {
      insideList: Boolean(active?.closest?.(".search-suggestions")),
      tag: active?.tagName ?? null,
      id: active?.id ?? null,
    };
  `);
  check(
    "Tab leaves the suggestion list instead of holding focus",
    !focus.insideList,
    focus,
  );
}

async function searchSuggestionOrder(page, check) {
  await fixtureCall(page, "reset");
  await fixtureCall(page, "configure", [{ delayTerms: { pol: 1200 } }]);
  try {
    await home(page);
    await openHash(
      page,
      "#/search",
      `Boolean(document.querySelector(${q(SEARCH_INPUT)}))`,
    );
    await typeInto(page, SEARCH_INPUT, "pol");
    const polStarted = await waitFor(
      page,
      `${FIXTURE}.snapshot().requests.some((item) => item.path.split("?")[0].endsWith("/search/suggestions") && item.query?.term === "pol")`,
      6000,
    );
    await typeInto(page, SEARCH_INPUT, "fix");
    const newer = await waitFor(
      page,
      `[...document.querySelectorAll(${q(SUGGESTION_OPTIONS)})].some((node) => node.textContent.includes("Fixture Discovery"))`,
      6000,
    );
    // The slow "pol" reply lands after 1200 ms; wait past it before judging.
    await sleep(1600);
    const after = await textOf(page, SUGGESTION_OPTIONS);
    const input = await page.evaluate(
      `return document.querySelector(${q(SEARCH_INPUT)})?.value ?? null;`,
    );
    check(
      "a late suggestion reply never replaces a newer one",
      polStarted &&
        newer &&
        input === "fix" &&
        after.some((label) => label.includes("Fixture Discovery")) &&
        !after.some(
          (label) => label.includes("Polka") || label.includes("Polish"),
        ),
      { polStarted, newer, input, after },
    );
  } finally {
    await fixtureCall(page, "configure", [{ delayTerms: {} }]);
  }
}

async function searchSuggestionPick(page, check) {
  await fixtureCall(page, "reset");
  await home(page);
  await openHash(
    page,
    "#/search",
    `Boolean(document.querySelector(${q(SEARCH_INPUT)}))`,
  );
  await typeInto(page, SEARCH_INPUT, "pol");
  await waitFor(
    page,
    `document.querySelectorAll(${q(SUGGESTION_OPTIONS)}).length >= 3`,
    6000,
  );
  const since = await requestCount(page);
  await pressKey(page, "ArrowDown", "ArrowDown", 40);
  await pressKey(page, "Enter", "Enter", 13, "\r");
  const searched = await waitFor(
    page,
    `${FIXTURE}.snapshot().requests.some((item) => item.path.split("?")[0] === "/v1/catalog/us/search" && item.query?.term === "polish fixture")`,
    8000,
  );
  const requests = sinceOf(await snapshot(page), since);
  check("picking a suggested term runs that search", searched, {
    searches: requests
      .filter((item) => pathOnly(item) === "/v1/catalog/us/search")
      .map((item) => item.query?.term ?? null),
  });
}

async function searchResults(page, check) {
  await fixtureCall(page, "reset");
  await home(page);
  const overviewReady = await openHash(
    page,
    "#/search?q=discovery",
    `Boolean(document.querySelector(".search-top-section .search-tile-featured")) && Boolean(document.getElementById("search-albums-heading"))`,
    15_000,
  );
  const snap = await snapshot(page);
  const overview = snap.requests.find(
    (item) =>
      pathOnly(item) === "/v1/catalog/us/search" &&
      item.query?.term === "discovery" &&
      item.query?.with === "topResults",
  );
  check(
    "overview search asks every group with topResults and a limit of 10",
    overviewReady &&
      String(overview?.query?.types) ===
        "songs,albums,artists,playlists,stations,apple-curators" &&
      String(overview?.query?.limit) === "10",
    { ready: overviewReady, query: overview?.query ?? null },
  );

  const sinceSeeAll = await requestCount(page);
  const seeAllClicked = await page.evaluate(
    `const button = document.querySelector('button.search-see-all[aria-label="See all albums"]'); if (!button) return false; button.click(); return true;`,
  );
  const seeAllOpen = await waitFor(
    page,
    `Boolean(document.querySelector(".search-see-all-view"))`,
    8000,
  );
  // Albums render as ResourceCard tiles (home-discovery-card) in See all.
  await loadAll(
    page,
    ".search-see-all-view .search-see-all-more button",
    ".search-see-all-view .home-discovery-card",
  );
  const titles = await textOf(
    page,
    ".search-see-all-view .home-discovery-card strong",
  );
  const albumRequests = sinceOf(await snapshot(page), sinceSeeAll).filter(
    (item) =>
      pathOnly(item) === "/v1/catalog/us/search" &&
      item.query?.types === "albums",
  );
  const offsets = albumRequests.map((item) => Number(item.query?.offset ?? 0));
  check(
    "See all albums pages through all 60 with no duplicate pages or albums",
    seeAllClicked &&
      seeAllOpen &&
      titles.length === 60 &&
      new Set(titles).size === 60 &&
      new Set(offsets).size === offsets.length &&
      albumRequests.every((item) => String(item.query?.limit) === "25"),
    {
      seeAllOpen,
      titles: titles.length,
      unique: new Set(titles).size,
      offsets,
      limits: albumRequests.map((item) => item.query?.limit ?? null),
    },
  );

  await page.evaluate(
    `document.querySelector(".search-see-all-view .secondary-button")?.click(); return true;`,
  );
  await home(page);
  await openHash(
    page,
    "#/search?q=discovery",
    `Boolean(document.getElementById("search-curators-heading")) && Boolean(document.getElementById("search-stations-heading"))`,
    15_000,
  );
  const curatorSection = await page.evaluate(`
    const section = document.getElementById("search-curators-heading")?.closest("section");
    const albums = document.getElementById("search-albums-heading")?.closest("section");
    return {
      curatorsHaveCurator: Boolean(section?.textContent.includes("Apple Discovery Editors")),
      albumsHaveCurator: Boolean(albums?.textContent.includes("Apple Discovery Editors")),
    };
  `);
  const tiled = await page.evaluate(
    `const tile = [...document.querySelectorAll(".search-tile")].find((node) => node.textContent.includes("Apple Discovery Editors")); if (!tile) return false; tile.click(); return true;`,
  );
  const curatorOpened = await waitFor(
    page,
    `location.hash.startsWith("#/curator/apple.discovery-fixture?kind=apple")`,
    8000,
  );
  check(
    "stations and curators get their own sections, and a curator tile opens its page",
    curatorSection.curatorsHaveCurator &&
      !curatorSection.albumsHaveCurator &&
      tiled &&
      curatorOpened,
    {
      ...curatorSection,
      tiled,
      hash: await page.evaluate("return location.hash"),
    },
  );
}

async function browseCharts(page, check) {
  await fixtureCall(page, "reset");
  await home(page);
  const ready = await openHash(
    page,
    "#/browse",
    `Boolean(document.querySelector("#browse-genre")) && document.querySelectorAll(${q(`${BROWSE_SONGS} .library-track-row`)}).length > 0`,
    15_000,
  );
  const songsInclude = (text) =>
    `[...document.querySelectorAll(${q(`${BROWSE_SONGS} .library-track-row`)})].some((node) => node.textContent.includes(${q(text)}))`;

  const sinceGenre = await requestCount(page);
  const selected = await setSelect(page, "#browse-genre", "14");
  const pop = await waitFor(page, songsInclude("Pop Chart Song 1"), 10_000);
  const chartRequests = sinceOf(await snapshot(page), sinceGenre).filter(
    (item) => pathOnly(item) === "/v1/catalog/us/charts",
  );
  check(
    "choosing Pop sends genre 14 to charts and shows its songs",
    ready &&
      pop &&
      chartRequests.some((item) => String(item.query?.genre) === "14"),
    {
      ready,
      selected,
      pop,
      genres: chartRequests.map((item) => item.query?.genre ?? null),
    },
  );

  const shelves = `({
    city: Boolean(document.getElementById("browse-city-heading")),
    daily: Boolean(document.getElementById("browse-daily-heading")),
    songs: Boolean(document.getElementById("browse-songs-heading")),
  })`;
  await setSelect(page, "#browse-genre", "21");
  await waitFor(page, songsInclude("Rock Chart Song 1"), 10_000);
  const rock = await page.evaluate(`return ${shelves};`);
  await setSelect(page, "#browse-genre", "");
  await waitFor(
    page,
    `Boolean(document.getElementById("browse-city-heading")) && Boolean(document.getElementById("browse-daily-heading"))`,
    10_000,
  );
  const all = await page.evaluate(`return ${shelves};`);
  check(
    "city and daily shelves hide only where the genre has none; Top Songs stays",
    rock.songs && !rock.city && !rock.daily && all.city && all.daily,
    { rock, all },
  );

  await setSelect(page, "#browse-genre", "");
  await waitFor(page, songsInclude("Chart Song 1"), 10_000);
  const sinceSeeAll = await requestCount(page);
  const seeAll = await page.evaluate(
    `const button = document.querySelector('section[aria-labelledby="browse-songs-heading"] button[aria-label="See all top songs"]'); if (!button) return false; button.click(); return true;`,
  );
  const open = await waitFor(
    page,
    `Boolean(document.querySelector(".browse-see-all-view"))`,
    8000,
  );
  await loadAll(
    page,
    ".browse-see-all-view .browse-see-all-more button",
    ".browse-see-all-view .library-track-row",
  );
  const rows = await textOf(page, ".browse-see-all-view .library-track-row");
  const chartPaths = sinceOf(await snapshot(page), sinceSeeAll)
    .filter((item) => pathOnly(item) === "/v1/catalog/us/charts")
    .map((item) => item.path);
  check(
    "Top Songs See all pages through 30 songs with no duplicates, via the chart's next link",
    seeAll &&
      open &&
      rows.length === 30 &&
      new Set(rows).size === 30 &&
      chartPaths.some((item) => item.includes("offset=20")) &&
      chartPaths.every((item) => item.startsWith("/v1/catalog/us/charts")),
    { seeAll, open, rows: rows.length, unique: new Set(rows).size, chartPaths },
  );
  await page.evaluate(
    `document.querySelector(".browse-see-all-view .secondary-button")?.click(); return true;`,
  );
}

async function radioStations(page, check) {
  await fixtureCall(page, "reset");
  await home(page);
  const ready = await openHash(
    page,
    "#/radio",
    `document.querySelectorAll('[role="group"][aria-labelledby="radio-genres-heading"] .browse-chip').length >= 2`,
    15_000,
  );
  const sinceChip = await requestCount(page);
  const chipClicked = await clickByText(page, ".browse-chip", "Pop");
  const shelf = await waitFor(
    page,
    `Boolean(${sectionFor("Pop Stations")})`,
    8000,
  );
  const cards = await textOf(page, ".home-discovery-card");
  const stationRequests = sinceOf(await snapshot(page), sinceChip).filter(
    (item) =>
      pathOnly(item) === "/v1/catalog/us/station-genres/sg-pop/stations",
  );
  check(
    "a genre chip opens its station shelf from station-genres",
    ready &&
      chipClicked &&
      shelf &&
      cards.some((text) => text.includes("Pop Station One")) &&
      cards.some((text) => text.includes("Pop Station Two")) &&
      stationRequests.length >= 1,
    { ready, chipClicked, shelf, cards, requests: pathsOf(stationRequests) },
  );

  await fixtureCall(page, "reset");
  const played = await page.evaluate(
    `const card = [...document.querySelectorAll(".home-discovery-card")].find((node) => node.textContent.includes("Pop Station One")); if (!card) return false; card.click(); return true;`,
  );
  const queued = await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.some((item) => item.type === "setQueue" && (item.options?.url === ${q(POP_STATION_URL)} || item.options?.station === "ra.genre-pop-1"))`,
    8000,
  );
  const withoutUrl = await page.evaluate(`
    const card = [...document.querySelectorAll(".home-discovery-card")].find((node) => node.textContent.includes("Pop Station Two"));
    return { found: Boolean(card), disabled: card ? card.disabled === true : null };
  `);
  const snap = await snapshot(page);
  check(
    "a station with a URL plays from its card, and one without has no Play",
    played && queued && withoutUrl.found && withoutUrl.disabled === true,
    {
      played,
      queued,
      withoutUrl,
      setQueue: snap.transitions
        .filter((item) => item.type === "setQueue")
        .at(-1),
    },
  );
}

async function liveText(page, check) {
  await fixtureCall(page, "reset");
  await home(page);
  await fixtureCall(page, "setCurrentTrack", ["song-a"]);
  await waitFor(
    page,
    `Boolean(document.querySelector(".player-track-links"))`,
    8000,
  );
  await fixtureCall(page, "setLive", [true]);
  await fixtureCall(page, "emitTimedMetadata", [
    { title: "Live Show", artist: "DJ Live" },
  ]);
  const shown = await waitFor(
    page,
    `[...document.querySelectorAll(${q(LIVE_TEXT)})].some((node) => node.textContent.includes("Live Show"))`,
    8000,
  );
  const politeness = await page.evaluate(
    `return document.querySelector(${q(LIVE_TEXT)})?.getAttribute("aria-live") ?? null;`,
  );
  await fixtureCall(page, "setCurrentTrack", ["song-c"]);
  const cleared = await waitFor(
    page,
    `!document.querySelector(${q(LIVE_TEXT)})`,
    8000,
  );
  check(
    "live radio text shows for a live item and clears when the item changes",
    shown && politeness === "polite" && cleared,
    { shown, politeness, cleared },
  );
}

async function curatorPages(page, check) {
  await fixtureCall(page, "reset");
  await home(page);
  const groupsOf = `[...document.querySelectorAll('[data-curator-shelf="group"]')].map((shelf) => ({
    heading: shelf.querySelector("h2")?.textContent?.trim() ?? null,
    tiles: [...shelf.querySelectorAll(".library-card-copy strong")].map((node) => node.textContent.trim()),
  }))`;

  const appleReady = await openHash(
    page,
    "#/curator/apple.discovery-fixture?kind=apple",
    `document.querySelector(".curator-header h1")?.textContent?.trim() === "Apple Discovery Editors" && document.querySelectorAll('[data-curator-shelf="group"]').length === 1`,
    15_000,
  );
  const apple = await page.evaluate(`
    return { groups: ${groupsOf}, kind: document.querySelector(".curator-page")?.getAttribute("data-curator-kind") ?? null };
  `);
  const appleBatch = (await snapshot(page)).requests.filter(
    (item) => pathOnly(item) === "/v1/catalog/us/playlists",
  );
  check(
    "an Apple curator shows its editorial group, resolved through the playlists batch",
    appleReady &&
      apple.kind === "apple" &&
      apple.groups.length === 1 &&
      apple.groups[0].heading === "Editors' Picks" &&
      apple.groups[0].tiles.includes("Discovery Editors Pick") &&
      appleBatch.some((item) =>
        String(item.query?.ids).includes("pl.discovery-apple-1"),
      ),
    {
      appleReady,
      apple,
      batches: appleBatch.map((item) => item.query?.ids ?? null),
    },
  );

  await fixtureCall(page, "reset");
  await home(page);
  // A non-Apple curator has no grouped view: its playlists are one flat shelf.
  const curatorReady = await openHash(
    page,
    "#/curator/cur.discovery-fixture?kind=curator",
    `document.querySelector(".curator-header h1")?.textContent?.trim() === "Discovery Curator" && document.querySelectorAll('[data-curator-shelf="playlists"] .library-card').length === 3`,
    15_000,
  );
  const flat = await textOf(
    page,
    '[data-curator-shelf="playlists"] .library-card-copy strong',
  );
  const batches = (await snapshot(page)).requests.filter(
    (item) => pathOnly(item) === "/v1/catalog/us/playlists",
  );
  const batchIds = batches.flatMap((item) =>
    String(item.query?.ids ?? "")
      .split(",")
      .filter(Boolean),
  );
  check(
    "a curator's flat playlist shelf lists its three playlists, and batches stay at 25 ids or fewer",
    curatorReady &&
      sameList(flat, [
        "Discovery Mix One",
        "Discovery Mix Two",
        "Discovery Featured One",
      ]) &&
      batches.every(
        (item) => String(item.query?.ids).split(",").length <= 25,
      ) &&
      [
        "pl.discovery-curated-1",
        "pl.discovery-curated-2",
        "pl.discovery-featured-1",
      ].every((id) => batchIds.includes(id)),
    {
      curatorReady,
      flat,
      batchSizes: batches.map(
        (item) => String(item.query?.ids).split(",").length,
      ),
    },
  );

  const tileClicked = await page.evaluate(
    `const card = [...document.querySelectorAll('[data-curator-shelf] .library-card')].find((node) => node.textContent.includes("Discovery Mix One")); if (!card) return false; card.click(); return true;`,
  );
  const playlistOpen = await waitFor(
    page,
    `location.hash.startsWith("#/playlist/pl.discovery-curated-1") && document.querySelectorAll("button.library-track-row").length === 2`,
    12_000,
  );
  const playlistRows = await textOf(page, "button.library-track-row");
  check(
    "a curator's playlist opens and lists its tracks (no dead link)",
    tileClicked &&
      playlistOpen &&
      playlistRows.every((text) => text.includes("Discovery Mix One Track")),
    {
      tileClicked,
      playlistOpen,
      rows: playlistRows,
      hash: await page.evaluate("return location.hash"),
    },
  );

  await fixtureCall(page, "reset");
  await home(page);
  const linkReady = await openHash(
    page,
    "#/playlist/pl.discovery-apple-1?source=catalog",
    `Boolean(document.querySelector(".library-detail-meta .curator-link"))`,
    15_000,
  );
  const linkText = await page.evaluate(
    `return document.querySelector(".library-detail-meta .curator-link")?.textContent.trim() ?? null;`,
  );
  const linkClicked = await page.evaluate(
    `const link = document.querySelector(".library-detail-meta .curator-link"); if (!link) return false; link.click(); return true;`,
  );
  const linkOpened = await waitFor(
    page,
    `location.hash.startsWith("#/curator/apple.discovery-fixture?kind=apple")`,
    8000,
  );
  check(
    "a playlist's curator link opens the curator page",
    linkReady &&
      linkText === "Curated by Apple Discovery Editors" &&
      linkClicked &&
      linkOpened,
    { linkReady, linkText, linkClicked, linkOpened },
  );
}

async function homeLists(page, check) {
  await fixtureCall(page, "reset");
  const ready = await openHash(
    page,
    "#/home",
    `Boolean(${sectionFor("Recently Played")})`,
    15_000,
  );
  // Home loads once per session, so Refresh is what reads the fixture again.
  await fixtureCall(page, "reset");
  await page.evaluate(
    `document.querySelector('button[aria-label="Refresh Home"]')?.click(); return true;`,
  );
  const reloaded = await waitFor(
    page,
    `(() => {
      const requests = window.__ARLET_E2E_MUSIC__.snapshot().requests.filter(
        (item) => item.path.split("?")[0] === "/v1/me/recent/played",
      );
      return requests.length >= 2 && requests.every((item) => item.completedAt || item.error);
    })() && document.querySelectorAll("section.home-recommendation-group h3").length >= 3`,
    15_000,
  );
  const recent = await page.evaluate(`
    const section = ${sectionFor("Recently Played")};
    if (!section) return null;
    const cards = [...section.querySelectorAll(".home-discovery-card")].map((card) => ({
      text: card.textContent.trim(),
      play: Boolean(card.closest(".card-shell")?.querySelector(".card-action-play")),
      menu: Boolean(card.closest(".card-shell")?.querySelector(".card-action-more")),
    }));
    return { cards, recentPlaylists: Boolean(${sectionFor("Recent Playlists")}) };
  `);
  const snap = await snapshot(page);
  const recentRequests = snap.requests.filter(
    (item) => pathOnly(item) === "/v1/me/recent/played",
  );
  const stationCards = (recent?.cards ?? []).filter((card) =>
    card.text.includes("Discovery Station One"),
  );
  check(
    "Home shows Recently Played with albums and stations, and station cards have no menu",
    ready &&
      reloaded &&
      recent !== null &&
      (recent.cards ?? []).some((card) =>
        card.text.includes("Fixture Discovery Album"),
      ) &&
      stationCards.length === 1 &&
      stationCards.every((card) => card.play === true && card.menu === false) &&
      recent.recentPlaylists === false &&
      recentRequests.length === 2 &&
      recentRequests.some((item) => item.path.includes("offset=4")),
    {
      ready,
      cards: recent?.cards?.map((card) => card.text),
      recentPlaylists: recent?.recentPlaylists,
      recentRequests: pathsOf(recentRequests),
    },
  );

  const heavy = await page.evaluate(`
    const section = ${sectionFor("Heavy Rotation")};
    return section ? [...section.querySelectorAll(".home-discovery-card")].map((card) => card.textContent.trim()) : null;
  `);
  check(
    "Heavy Rotation keeps stations, albums and playlists unfiltered",
    heavy !== null &&
      heavy.some((text) => text.includes("Pop Station One")) &&
      heavy.some((text) => text.includes("Heavy Rotation Album")) &&
      heavy.some((text) => text.includes("Discovery Featured One")),
    { heavy },
  );

  const groups = await page.evaluate(`
    return [...document.querySelectorAll("section.home-recommendation-group")].map((node) => ({
      heading: node.querySelector("h3")?.textContent?.trim() ?? null,
      text: node.textContent,
    }));
  `);
  const byHeading = (title) => groups.find((group) => group.heading === title);
  const nested = byHeading("Nested Picks");
  const mixed = byHeading("Mixed Picks");
  check(
    "a nested recommendation group becomes its own titled shelf",
    ["Discovery Albums", "Mixed Picks", "Nested Picks"].every((title) =>
      Boolean(byHeading(title)),
    ) &&
      Boolean(nested?.text.includes("Nested Album Three")) &&
      mixed?.text.includes("Discovery Station One") === true &&
      mixed?.text.includes("Nested Album Three") === false,
    { headings: groups.map((group) => group.heading) },
  );
}

async function playbackEvents(page, check, dataDir) {
  await fixtureCall(page, "reset");
  await home(page);
  await fixtureCall(page, "setCurrentTrack", ["song-a"]);
  await waitFor(page, `Boolean(document.querySelector(${q(SEEK)}))`, 8000);

  await fixtureCall(page, "emitPlaybackTime", [0, 0]);
  const late = await waitFor(
    page,
    `document.querySelector(${q(SEEK)})?.disabled === true`,
    4000,
  );
  await fixtureCall(page, "emitPlaybackDuration", [240]);
  const enabled = await waitFor(
    page,
    `Boolean(document.querySelector(${q(SEEK)})) && document.querySelector(${q(SEEK)}).disabled === false`,
    4000,
  );
  const seekText = await page.evaluate(
    `return document.querySelector(${q(SEEK)})?.getAttribute("aria-valuetext") ?? null;`,
  );
  check(
    "a late duration enables seek and shows the total",
    late && enabled && String(seekText).includes("4:00"),
    { late, enabled, seekText },
  );

  const before = (await snapshot(page)).transitions.filter(
    (item) => item.type === "volume",
  ).length;
  await fixtureCall(page, "emitPlaybackVolume", [0.4]);
  const shown = await waitFor(
    page,
    `document.querySelector(${q(VOLUME)})?.getAttribute("aria-valuetext") === "40%"`,
    4000,
  );
  const saved = await waitForSavedVolume(
    path.join(dataDir, "settings.json"),
    0.4,
    4000,
  );
  await sleep(600);
  const writes =
    (await snapshot(page)).transitions.filter((item) => item.type === "volume")
      .length - before;
  check(
    "an external volume change shows, saves to settings, and does not loop",
    shown && saved.saved && writes === 1,
    { shown, saved, writes },
  );
}

async function externalSignOut(page, check) {
  try {
    await fixtureCall(page, "reset");
    // Recent searches are saved on submit, so the term is typed and submitted.
    await home(page);
    await openHash(
      page,
      "#/search",
      `Boolean(document.querySelector(${q(SEARCH_INPUT)}))`,
    );
    await typeInto(page, SEARCH_INPUT, "discovery");
    await pressKey(page, "Enter", "Enter", 13, "\r");
    await waitFor(
      page,
      `Boolean(document.querySelector(".search-top-section .search-tile-featured"))`,
      15_000,
    );
    const recentBefore = await page.evaluate(
      `return localStorage.getItem(${q(RECENT_KEY)});`,
    );
    await home(page);
    await fixtureCall(page, "emitAuthorizationStatus", [false]);
    // MusicKit no longer authorizes the session: the banner asks for a new
    // sign-in and nothing local is deleted yet.
    const banner = await waitFor(
      page,
      `Boolean(document.querySelector(".session-expired-notice"))`,
      10_000,
    );
    const recentKept = await page.evaluate(
      `return localStorage.getItem(${q(RECENT_KEY)});`,
    );
    // Signing out through the banner is what runs the local cleanup.
    const clicked = await clickByText(
      page,
      ".session-expired-notice button",
      "Sign out",
    );
    // "#/library" alone is Home; a library section is the real route.
    const signedOut = await openHash(
      page,
      "#/library/recent",
      `document.body.innerText.includes("Sign in to view your library")`,
      10_000,
    );
    const recentAfter = await page.evaluate(
      `return localStorage.getItem(${q(RECENT_KEY)});`,
    );
    const authorized = (await snapshot(page)).authorized;
    const recentCleared =
      recentAfter === null || JSON.parse(recentAfter).length === 0;
    check(
      "external sign-out shows the sign-in banner, keeps data, then Sign out runs local cleanup",
      String(recentBefore).includes("discovery") &&
        banner &&
        recentKept === recentBefore &&
        clicked &&
        signedOut &&
        recentCleared &&
        authorized === false,
      {
        recentBefore,
        recentKept,
        banner,
        clicked,
        recentAfter,
        signedOut,
        authorized,
      },
    );
  } finally {
    await fixtureCall(page, "emitAuthorizationStatus", [true]);
    await fixtureCall(page, "reset");
  }
}

/** Runs the Apple Music discovery checks. Called with `{ page, check, dataDir }`. */
export async function runDiscovery({ page, check, dataDir }) {
  await group(check, "artist page", () => artistPage(page, check));
  await group(check, "artist fallback", () => artistFallback(page, check));
  await group(check, "sparse artist", () => sparseArtist(page, check));
  await group(check, "library artist", () => libraryArtist(page, check));
  await group(check, "album shelves", () => albumShelves(page, check));
  await group(check, "search suggestions", () =>
    searchSuggestions(page, check),
  );
  await group(check, "suggestion order", () =>
    searchSuggestionOrder(page, check),
  );
  await group(check, "suggestion pick", () =>
    searchSuggestionPick(page, check),
  );
  await group(check, "search results", () => searchResults(page, check));
  await group(check, "browse charts", () => browseCharts(page, check));
  await group(check, "radio stations", () => radioStations(page, check));
  await group(check, "live radio text", () => liveText(page, check));
  await group(check, "curator pages", () => curatorPages(page, check));
  await group(check, "home lists", () => homeLists(page, check));
  await group(check, "playback events", () =>
    playbackEvents(page, check, dataDir),
  );
  // Last: it signs out, and restores the account in its finally block.
  await group(check, "external sign-out", () => externalSignOut(page, check));
}
