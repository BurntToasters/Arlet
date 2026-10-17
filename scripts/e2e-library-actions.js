#!/usr/bin/env node

import { sleep, waitFor as pollFor } from "./e2e-helpers.js";

const LIBRARY_SONG = "song-a";
const CATALOG_SONG = "catalog-song";
const LIBRARY_SONG_PATH = `/v1/me/ratings/library-songs/${LIBRARY_SONG}`;
const CATALOG_SONG_PATH = `/v1/me/ratings/songs/${CATALOG_SONG}`;

// The now-playing heart is the only Love/Unlove button in the player bar.
const HEART = `[...document.querySelectorAll('.player-bar button')].find((button) => ['Love', 'Unlove'].includes(button.getAttribute('aria-label')))`;

const waitFor = (page, expression, timeoutMs = 10_000) =>
  pollFor(page, expression, timeoutMs, 100);

async function snapshot(page) {
  return page.evaluate("return window.__ARLET_E2E_MUSIC__.snapshot();");
}

function mutationsAt(requests, path) {
  return requests.filter(
    (request) => request.method !== "GET" && request.path === path,
  );
}

function heartIs(label, pressed) {
  return `(${HEART})?.getAttribute('aria-label') === '${label}' && (${HEART})?.getAttribute('aria-pressed') === '${pressed}'`;
}

function toastIncludes(text) {
  return `[...document.querySelectorAll('.action-toast-message')].some((node) => node.textContent.includes(${JSON.stringify(text)}))`;
}

async function openMenu(page, id) {
  await page.evaluate(
    `window.__ARLET_E2E_MUSIC__.selectContext(${JSON.stringify(id)}); return true;`,
  );
  return waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item="love"]')`,
  );
}

function menuLabel(page, item) {
  return page.evaluate(
    `return document.querySelector('.context-menu [data-menu-item="${item}"] span')?.textContent ?? null;`,
  );
}

function menuHas(page, item) {
  return page.evaluate(
    `return Boolean(document.querySelector('.context-menu [data-menu-item="${item}"]'));`,
  );
}

function clickMenu(page, item) {
  return page.evaluate(
    `document.querySelector('.context-menu [data-menu-item="${item}"]')?.click(); return true;`,
  );
}

/** Love, Dislike, Add to Library, and rollback against the injected MusicKit fixture. */
export async function runLibraryActions({ page, check }) {
  await page.evaluate(`
    const fixture = window.__ARLET_E2E_MUSIC__;
    fixture.reset();
    fixture.setCurrentTrack("${LIBRARY_SONG}");
    return true;
  `);
  const ratingLoaded = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().requests.some((r) => r.method === "GET" && r.path === "/v1/me/ratings/library-songs")`,
  );
  const heartReady = await waitFor(page, heartIs("Love", "false"));
  const loaded = await snapshot(page);
  const loadRequest = loaded.requests.find(
    (request) => request.path === "/v1/me/ratings/library-songs",
  );
  check(
    "now-playing track loads its rating from the library-songs path",
    ratingLoaded &&
      heartReady &&
      loadRequest?.method === "GET" &&
      loadRequest.query?.ids === LIBRARY_SONG,
    { requests: loaded.requests },
  );

  await page.evaluate(`${HEART}?.click(); return true;`);
  const loved = await waitFor(page, heartIs("Unlove", "true"));

  const libraryMenuOpen = await openMenu(page, LIBRARY_SONG);
  const libraryMenu = {
    love: await menuLabel(page, "love"),
    dislike: await menuLabel(page, "dislike"),
    addToLibrary: await menuHas(page, "add-to-library"),
  };
  check(
    "library song menu shows Unlove and Dislike but no Add to Library",
    libraryMenuOpen &&
      libraryMenu.love === "Unlove" &&
      libraryMenu.dislike === "Dislike" &&
      libraryMenu.addToLibrary === false,
    libraryMenu,
  );
  await clickMenu(page, "dislike");

  await openMenu(page, LIBRARY_SONG);
  const dislikeLabel = await menuLabel(page, "dislike");
  await clickMenu(page, "dislike");
  const cleared = await waitFor(page, heartIs("Love", "false"));

  const afterClear = await snapshot(page);
  const songMutations = mutationsAt(afterClear.requests, LIBRARY_SONG_PATH);
  check(
    "Love, Dislike, then clear send PUT, PUT, DELETE to library-songs and never to songs",
    loved &&
      dislikeLabel === "Remove dislike" &&
      cleared &&
      JSON.stringify(songMutations.map((r) => r.method)) ===
        JSON.stringify(["PUT", "PUT", "DELETE"]) &&
      songMutations[0]?.body?.attributes?.value === 1 &&
      songMutations[1]?.body?.attributes?.value === -1 &&
      !afterClear.requests.some(
        (r) => r.method !== "GET" && r.path.startsWith("/v1/me/ratings/songs/"),
      ),
    {
      dislikeLabel,
      mutations: songMutations.map((r) => ({
        method: r.method,
        path: r.path,
        body: r.body,
      })),
    },
  );

  await openMenu(page, CATALOG_SONG);
  const catalogMenuLove = await menuLabel(page, "love");
  const catalogAddVisible = await menuHas(page, "add-to-library");
  await clickMenu(page, "love");
  const catalogLoved = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().requests.some((r) => r.method === "PUT" && r.path === "${CATALOG_SONG_PATH}")`,
  );
  check(
    "catalog song Love sends PUT to the plain songs path",
    catalogMenuLove === "Love" && catalogAddVisible && catalogLoved,
    { menuLove: catalogMenuLove, addVisible: catalogAddVisible },
  );

  await openMenu(page, CATALOG_SONG);
  await clickMenu(page, "add-to-library");
  const addRequested = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().requests.some((r) => r.method === "POST" && r.path === "/v1/me/library")`,
  );
  const afterAdd = await snapshot(page);
  const adds = afterAdd.requests.filter(
    (r) => r.method === "POST" && r.path === "/v1/me/library",
  );
  check(
    "Add to Library sends exactly one POST with ids[songs]",
    addRequested &&
      adds.length === 1 &&
      adds[0].query?.["ids[songs]"] === CATALOG_SONG,
    { adds: adds.map((r) => ({ query: r.query, method: r.method })) },
  );

  // A rejected change must roll back to the server value and report a toast.
  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.configure({ rejectPaths: ["${CATALOG_SONG_PATH}"] });
    return true;
  `);
  // Count only the mutations this click sends, so each check stands alone.
  const catalogBefore = mutationsAt(
    (await snapshot(page)).requests,
    CATALOG_SONG_PATH,
  ).length;
  await openMenu(page, CATALOG_SONG);
  await clickMenu(page, "love");
  const catalogToast = await waitFor(
    page,
    toastIncludes(`Fixture request rejected: ${CATALOG_SONG_PATH}`),
  );
  await openMenu(page, CATALOG_SONG);
  const rolledBackLabel = await menuLabel(page, "love");
  const afterCatalogReject = await snapshot(page);
  const catalogSent = mutationsAt(
    afterCatalogReject.requests,
    CATALOG_SONG_PATH,
  ).slice(catalogBefore);
  check(
    "rejected catalog rating rolls back, reports a toast, and is not retried",
    catalogToast &&
      rolledBackLabel === "Unlove" &&
      catalogSent.length === 1 &&
      catalogSent[0].method === "DELETE",
    {
      rolledBackLabel,
      sent: catalogSent.map((r) => ({ method: r.method, error: r.error })),
    },
  );

  const heartBefore = mutationsAt(
    (await snapshot(page)).requests,
    LIBRARY_SONG_PATH,
  ).length;
  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.configure({ rejectPaths: ["${LIBRARY_SONG_PATH}"] });
    return true;
  `);
  await page.evaluate(`${HEART}?.click(); return true;`);
  const heartToast = await waitFor(
    page,
    toastIncludes(`Fixture request rejected: ${LIBRARY_SONG_PATH}`),
  );
  const heartRolledBack = await waitFor(page, heartIs("Love", "false"));
  const afterHeartReject = await snapshot(page);
  const heartSent = mutationsAt(
    afterHeartReject.requests,
    LIBRARY_SONG_PATH,
  ).slice(heartBefore);
  check(
    "rejected heart Love rolls back the toggle and sends one PUT",
    heartToast &&
      heartRolledBack &&
      heartSent.length === 1 &&
      heartSent[0].method === "PUT",
    { sent: heartSent.map((r) => ({ method: r.method, error: r.error })) },
  );

  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.configure({ rejectPaths: [] });
    return true;
  `);

  // MusicKit reports library playlist songs with a library type but a
  // catalog ID. Lookups must follow the ID, not the type.
  const MIXED_ID = "1456789835";
  await page.evaluate(`
    const fixture = window.__ARLET_E2E_MUSIC__;
    fixture.reset();
    fixture.setCurrentTrack("${MIXED_ID}");
    return true;
  `);
  const mixedRated = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().requests.some((r) => r.method === "GET" && r.path.startsWith("/v1/me/ratings/"))`,
  );
  await sleep(600);
  const mixed = await snapshot(page);
  const ratingPaths = mixed.requests
    .filter((r) => r.path.startsWith("/v1/me/ratings/"))
    .map((r) => r.path);
  check(
    "a song with a library type and a catalog ID is looked up as a catalog song",
    mixedRated &&
      ratingPaths.every((path) => path === "/v1/me/ratings/songs") &&
      !mixed.requests.some((r) =>
        r.path.startsWith(`/v1/me/library/songs/${MIXED_ID}`),
      ),
    { requests: mixed.requests.map((r) => r.path) },
  );

  // Apple names neither artist and the lookup fails: show the song's own
  // artist text, never "Artist 1, Artist 2".
  await page.evaluate(`
    const fixture = window.__ARLET_E2E_MUSIC__;
    fixture.reset();
    fixture.configure({ rejectPaths: ["/songs/nav-unnamed"] });
    fixture.setCurrentTrack("nav-unnamed");
    return true;
  `);
  const unnamedShown = await waitFor(
    page,
    `document.querySelector(".player-bar .player-track-copy strong")?.textContent === "Navigation Unnamed Artists"`,
  );
  await sleep(800);
  const artistText = await page.evaluate(
    `return document.querySelector(".player-bar .player-track-links")?.textContent ?? null;`,
  );
  check(
    "artists Apple did not name show as the song's artist text",
    unnamedShown &&
      artistText === "Fixture Artist" &&
      !/Artist \d/u.test(String(artistText)),
    { artistText },
  );
  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.configure({ rejectPaths: [] });
    return true;
  `);
}
