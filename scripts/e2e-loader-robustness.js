// Library loader hardening: a failed later detail page must not collapse a
// cached long playlist or overwrite its cache, and a failed favorites lookup
// must leave "Checking favorites…" instead of waiting forever.

import { fixtureCall, sleep, waitFor } from "./e2e-helpers.js";

const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const CACHE_SCOPE = "current-account";
const BIG_SECTION = "playlist:playlist-big";
const BIG_ITEM_COUNT = 1201;
const PLAY_LIMIT = 1200;
const ROAD_PLAYLISTS = 60;
const FAILED_PAGE_PATH = "playlist-big/tracks?offset=300";
const FAVORITES = {
  "library-albums:lib-library-albums-00003": 1,
  "library-albums:lib-library-albums-00044": 1,
};

const q = (value) => JSON.stringify(value);
const snapshot = (page) => fixtureCall(page, "snapshot");

// Scrolls the song list to the end and returns its last row number.
const lastRowNumber = `(() => {
  const scroller = document.querySelector(".content-scroll");
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  const numbers = [...document.querySelectorAll(".library-row-number")];
  return numbers.at(-1)?.textContent?.trim() ?? null;
})()`;

const toolbarStatus = `document.querySelector("[data-library-loading-all]")?.textContent?.trim() ?? null`;
const resultCount = `document.querySelector(".library-result-count")?.textContent?.trim() ?? null`;

async function cacheCount(page, section) {
  return page.evaluate(`
    const cached = await window.__TAURI_INTERNALS__.invoke(
      "library_cache_read_section",
      { scope: ${q(CACHE_SCOPE)}, section: ${q(section)} },
    );
    return cached?.items?.length ?? 0;`);
}

async function waitCacheCount(page, section, count, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await cacheCount(page, section)) === count) return true;
    await sleep(50);
  }
  return false;
}

async function toggleFavorites(page) {
  await page.evaluate(
    `document.querySelector("button[data-library-favorites]")?.click(); return true;`,
  );
}

async function dismissToasts(page) {
  await page.evaluate(`
    for (const button of document.querySelectorAll(".action-toast button")) button.click();
    return true;`);
}

async function runDetailPaging(page, check) {
  await page.evaluate(
    `location.hash = "#/playlist/playlist-big"; return true;`,
  );
  const opened = await waitFor(
    page,
    `document.querySelector(".library-detail-hero h1")?.textContent?.startsWith("Big Playlist")`,
    15_000,
  );
  const fullLoaded =
    opened &&
    (await waitFor(page, `${lastRowNumber} === "${PLAY_LIMIT}"`, 20_000));
  const fullCached = await waitCacheCount(
    page,
    BIG_SECTION,
    BIG_ITEM_COUNT,
    15_000,
  );
  check(
    "a long playlist opens with every page and a complete cache entry",
    opened && fullLoaded && fullCached,
    { opened, fullLoaded, fullCached },
  );

  await page.evaluate(`location.hash = "#/library/playlists"; return true;`);
  await sleep(200);
  const before = (await snapshot(page)).requests.length;
  await fixtureCall(page, "configure", [
    { failNextLibraryPage: { path: FAILED_PAGE_PATH } },
  ]);
  await page.evaluate(
    `location.hash = "#/playlist/playlist-big"; return true;`,
  );
  const failed = await waitFor(
    page,
    `${FIXTURE}.snapshot().requests.slice(${before}).some((request) => request.failedPage === true)`,
    15_000,
  );
  const noteShown = await waitFor(
    page,
    `[...document.querySelectorAll(".library-stale-note")].some((node) => node.textContent.includes("Refresh failed"))`,
    10_000,
  );
  // The hook is one-shot, so an unexpected second page failure is a bug.
  const failedOnce =
    (await snapshot(page)).requests.filter(
      (request) => request.failedPage === true,
    ).length === 1;

  const stillFull = await waitFor(
    page,
    `${lastRowNumber} === "${PLAY_LIMIT}"`,
    5_000,
  );
  const lastRow = await page.evaluate(`return ${lastRowNumber};`);
  await sleep(300);
  const cacheKept = (await cacheCount(page, BIG_SECTION)) === BIG_ITEM_COUNT;
  check(
    "a failed later page keeps the cached full list and does not rewrite its cache",
    failed && noteShown && failedOnce && stillFull && cacheKept,
    { failed, noteShown, failedOnce, stillFull, lastRow, cacheKept },
  );

  await page.evaluate(`location.hash = "#/library/playlists"; return true;`);
  await sleep(200);
  await page.evaluate(
    `location.hash = "#/playlist/playlist-big"; return true;`,
  );
  const reopenedFull = await waitFor(
    page,
    `${lastRowNumber} === "${PLAY_LIMIT}"`,
    15_000,
  );
  const reopenedCache = await waitCacheCount(
    page,
    BIG_SECTION,
    BIG_ITEM_COUNT,
    10_000,
  );
  check(
    "reopening the playlist after the failed page still shows the full list",
    reopenedFull && reopenedCache,
    { reopenedFull, reopenedCache },
  );

  const refreshMark = (await snapshot(page)).requests.length;
  await fixtureCall(page, "configure", [
    { failNextLibraryPage: { path: FAILED_PAGE_PATH } },
  ]);
  await page.evaluate(
    `document.querySelector('button[aria-label="Refresh details"]')?.click(); return true;`,
  );
  const refreshFailed = await waitFor(
    page,
    `${FIXTURE}.snapshot().requests.slice(${refreshMark}).some((request) => request.failedPage === true)`,
    15_000,
  );
  const refreshNote = await waitFor(
    page,
    `[...document.querySelectorAll(".library-stale-note")].some((node) => node.textContent.includes("Refresh failed"))`,
    10_000,
  );
  const refreshFull = await waitFor(
    page,
    `${lastRowNumber} === "${PLAY_LIMIT}"`,
    5_000,
  );
  const lastAfterRefresh = await page.evaluate(`return ${lastRowNumber};`);
  const cacheAfterRefresh = await cacheCount(page, BIG_SECTION);
  check(
    "an explicit refresh that fails on a later page keeps the full list and cache",
    refreshFailed &&
      refreshNote &&
      refreshFull &&
      cacheAfterRefresh === BIG_ITEM_COUNT,
    {
      refreshFailed,
      refreshNote,
      refreshFull,
      lastAfterRefresh,
      cacheAfterRefresh,
    },
  );
}

async function runFavoritesFailure(page, check) {
  const ratings = FAVORITES;
  await fixtureCall(page, "configure", [
    { librarySize: ROAD_PLAYLISTS, ratings },
  ]);
  await page.evaluate(`location.hash = "#/library/albums"; return true;`);
  const refreshReady = await waitFor(
    page,
    `(() => {
      const button = document.querySelector('button[aria-label="Refresh library"]');
      return Boolean(button) && !button.disabled;
    })()`,
    10_000,
  );
  if (refreshReady) {
    await page.evaluate(
      `document.querySelector('button[aria-label="Refresh library"]')?.click(); return true;`,
    );
  }
  const albumsShown = await waitFor(
    page,
    `document.querySelectorAll(".library-card").length === ${ROAD_PLAYLISTS}`,
    10_000,
  );
  const before = (await snapshot(page)).requests.length;
  await fixtureCall(page, "configure", [
    { rejectPaths: ["/v1/me/ratings/library-albums"] },
  ]);
  await toggleFavorites(page);
  const lookupFailed = await waitFor(
    page,
    `${FIXTURE}.snapshot().requests.slice(${before}).some((request) => request.path.includes("/v1/me/ratings/library-albums") && request.error)`,
    10_000,
  );
  const unblocked = await waitFor(
    page,
    `!(${toolbarStatus} ?? "").includes("Checking favorites")`,
    10_000,
  );
  const failedView = await page.evaluate(`
    return {
      status: ${toolbarStatus},
      count: ${resultCount},
      emptyTitle: document.querySelector(".empty-state h2")?.textContent ?? null,
      checking: document.body.textContent.includes("Checking favorites"),
    };`);
  check(
    "a failed favorites lookup leaves the spinner and shows a settled state",
    lookupFailed &&
      albumsShown &&
      unblocked &&
      failedView.status === "Could not check favorites" &&
      failedView.count === `0 of ${ROAD_PLAYLISTS}` &&
      failedView.emptyTitle === "No matches" &&
      !failedView.checking,
    { lookupFailed, unblocked, ...failedView },
  );

  await fixtureCall(page, "configure", [{ rejectPaths: [] }]);
  await toggleFavorites(page);
  await waitFor(
    page,
    `document.querySelector("button[data-library-favorites]")?.getAttribute("aria-pressed") === "false"`,
    5_000,
  );
  await toggleFavorites(page);
  const favoritesBack = await waitFor(
    page,
    `${resultCount} === "2 of ${ROAD_PLAYLISTS}"`,
    10_000,
  );
  await sleep(200);
  const favoriteTitles = await page.evaluate(`
    return [...document.querySelectorAll(".library-card-copy strong")]
      .map((node) => node.textContent);`);
  check(
    "favorites work again once the ratings lookup succeeds",
    favoritesBack &&
      favoriteTitles.length === 2 &&
      favoriteTitles.includes("Library Album 4") &&
      favoriteTitles.includes("Library Album 45"),
    { favoritesBack, favoriteTitles },
  );
}

export async function runLoaderRobustness({ page, check }) {
  try {
    await fixtureCall(page, "reset");
    await dismissToasts(page);
    await runDetailPaging(page, check);
    await fixtureCall(page, "reset");
    await dismissToasts(page);
    await runFavoritesFailure(page, check);
  } finally {
    await fixtureCall(page, "reset");
    await fixtureCall(page, "configure", [
      { failNextLibraryPage: null, rejectPaths: [] },
    ]);
    await page.evaluate(`
      await window.__TAURI_INTERNALS__.invoke("library_cache_clear_section", {
        scope: ${q(CACHE_SCOPE)},
        section: ${q(BIG_SECTION)},
      });
      return true;`);
    await dismissToasts(page);
  }
}
