// Failure modes this scenario guards. Each one has a check named below.

// 1. Sort applies only to the loaded first page, so a page-3 item is missing
//    or misplaced. Checked by "title-desc" (page-3 album leads), by the text
//    filter that reaches a page-3 album, and by the page-3 favorite.
// 2. Z-A is the reverse of A-Z, so tied titles come out in reverse Apple order.
//    Checked by "Z-A keeps Apple order for tied titles" (Écho and echo).

// 3. Numeric collation is wrong, so "Album 10" sorts before "Album 2".
//    Checked by "title-asc is numeric" against the reference order.
// 4. Missing dateAdded breaks the added sorts, or ties are not stable.
//    Checked by the added-desc and added-asc tail checks, and by the
//    songs and playlists added-desc checks.

// 5. Favorites shows unrated or disliked items, or ratings stop after the
//    first 100 ids, so a rated page-3 album is missing. Checked by the album,
//    song and playlist favorites checks.
// 6. Explicit/clean filter is wrong for albums or songs. Checked by the
//    album and song content checks (counts and rendered ids).
// 7. Text filter is case- or diacritic-sensitive. Checked by "ÉCHO" and
//    "echo" against the same 10 albums, and by the song "orchard" check.
// 8. No "No matches" state, or the clear button leaves filters set. Checked
//    by "no-match state and clear".

// 9. Playlist folders dropped, folders sorted after playlists, or folders
//    with no matching playlist kept under a filter. Checked by the playlist
//    layout checks.
// 10. A choice is not persisted after reload, or one section's choice bleeds
//    into another. Checked by the persistence checks after the reload.

// 11. Auto-load loops forever after a page error, or Load more stays visible
//    while auto-loading. Checked by the bounded request count and the
//    Load more checks.

import fs from "node:fs";
import path from "node:path";
import { fixtureCall, sleep, waitFor } from "./e2e-helpers.js";

const STORAGE_KEY = "arlet.library.view.v1";
const ALBUM_COUNT = 250;
const SONG_COUNT = 120;
const TOTAL = {
  albums: ALBUM_COUNT,
  artists: ALBUM_COUNT,
  songs: SONG_COUNT,
  playlists: 6,
};
const ROOTS = {
  albums: 'section[aria-label="Albums"]',
  artists: 'section[aria-label="Artists"]',
  songs: ".library-track-list",
  playlists: ".playlist-tree",
};
const LIST_PATHS = {
  albums: "/v1/me/library/albums",
  artists: "/v1/me/library/artists",
  songs: "/v1/me/library/songs",
  playlists: "/v1/me/library/playlists",
};
// Collation the app uses for sorting; the reference order is built with it.
const COLLATOR = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});
const FOLDER_ID = "lv-folder-road";
const FOLDER_MEMBERS = ["lv-pl-01", "lv-pl-06"];
const ALBUM_FAVORITES = [3, 230];
const ALBUM_DISLIKED = [150];
const SONG_FAVORITES = [2, 105];
const PLAYLIST_FAVORITES = ["lv-pl-01", "lv-pl-06"];

const albumId = (index) =>
  `lib-library-albums-${String(index).padStart(5, "0")}`;
const songId = (index) => `lv-song-${String(index).padStart(5, "0")}`;
const RATINGS = {
  ...Object.fromEntries(
    ALBUM_FAVORITES.map((index) => [`library-albums:${albumId(index)}`, 1]),
  ),
  ...Object.fromEntries(
    ALBUM_DISLIKED.map((index) => [`library-albums:${albumId(index)}`, -1]),
  ),
  ...Object.fromEntries(
    SONG_FAVORITES.map((index) => [`library-songs:${songId(index)}`, 1]),
  ),
  ...Object.fromEntries(
    PLAYLIST_FAVORITES.map((id) => [`library-playlists:${id}`, 1]),
  ),
};

const q = (value) => JSON.stringify(value);
const snapshot = (page) =>
  page.evaluate("return window.__ARLET_E2E_MUSIC__.snapshot();");

function favoriteIds(section) {
  if (section === "albums") return ALBUM_FAVORITES.map(albumId);
  if (section === "songs") return SONG_FAVORITES.map(songId);
  if (section === "playlists") return PLAYLIST_FAVORITES;
  return [];
}

// Reads the rendered section: ids in DOM order, with each playlist's folder.
function viewScript(selector) {
  return `(() => {
    const root = document.querySelector(${q(selector)});
    const field = (query) => document.querySelector(query);
    const items = root
      ? [...root.querySelectorAll("[data-context-id]")].map((node) => {
          const owner = node.closest(".playlist-folder-content")?.parentElement;
          const heading = owner?.querySelector(":scope > .playlist-folder-heading");
          return {
            id: node.getAttribute("data-context-id"),
            kind: node.getAttribute("data-context-kind"),
            folder: heading?.getAttribute("data-context-id") ?? null,
          };
        })
      : [];
    return {
      toolbar: Boolean(field(".library-toolbar")),
      sort: field("select[data-library-sort]")?.value ?? null,
      text: field("input[data-library-filter]")?.value ?? null,
      favorites: field("button[data-library-favorites]")?.getAttribute("aria-pressed") ?? null,
      content: field("select[data-library-content]")?.value ?? null,
      count: field(".library-result-count")?.textContent.trim() ?? null,
      loadingAll: Boolean(field("[data-library-loading-all]")),
      loadMore: Boolean(field(".library-load-more")),
      clearVisible: Boolean(field("[data-library-clear]")),
      noMatches: document.body.textContent.includes("No matches"),
      items,
    };
  })()`;
}

function scrollEdgeScript(selector, edge) {
  return `(() => {
    let node = document.querySelector(${q(selector)});
    while (node && node.scrollHeight <= node.clientHeight) node = node.parentElement;
    if (!node) return false;
    node.scrollTop = ${edge === "end" ? "node.scrollHeight" : "0"};
    return true;
  })()`;
}

const readView = (page, section) =>
  page.evaluate(`return ${viewScript(ROOTS[section])};`);

// Sets a control's value and fires the events the app listens for.
function setControl(page, selector, value) {
  return page.evaluate(`
    const el = document.querySelector(${q(selector)});
    if (!el) return false;
    el.value = ${q(value)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  `);
}

async function applyControls(page, controls) {
  await setControl(
    page,
    "select[data-library-sort]",
    controls.sort ?? "default",
  );
  await setControl(page, "input[data-library-filter]", controls.text ?? "");
  await setControl(
    page,
    "select[data-library-content]",
    controls.content ?? "all",
  );
  const pressed = await page.evaluate(
    "return document.querySelector('button[data-library-favorites]')?.getAttribute('aria-pressed') ?? null;",
  );
  if (
    pressed !== null &&
    (pressed === "true") !== Boolean(controls.favorites)
  ) {
    await page.evaluate(
      "document.querySelector('button[data-library-favorites]')?.click(); return true;",
    );
  }
}

// Items the fixture answered for one list path, in Apple order. Ids are
// deduplicated, so a refreshed page is not counted twice.
async function appleItems(page, section) {
  const { requests } = await snapshot(page);
  const seen = new Set();
  const items = [];
  for (const request of requests) {
    if (
      request.path.split("?")[0] !== LIST_PATHS[section] ||
      request.path.includes("ids=") ||
      request.query?.ids !== undefined ||
      !request.response
    ) {
      continue;
    }
    for (const raw of request.response.data ?? []) {
      if (seen.has(raw.id)) continue;
      seen.add(raw.id);
      const attributes = raw.attributes ?? {};
      items.push({
        id: raw.id,
        title: attributes.name ?? "",
        artist: attributes.artistName,
        album: attributes.albumName,
        added: attributes.dateAdded
          ? Date.parse(attributes.dateAdded)
          : undefined,
        contentRating: attributes.contentRating,
      });
    }
  }
  return items;
}

function compareAdded(a, b, direction) {
  if (a.added === undefined || b.added === undefined) {
    if (a.added === undefined && b.added === undefined) return 0;
    return a.added === undefined ? 1 : -1;
  }
  return direction === "desc" ? b.added - a.added : a.added - b.added;
}

const COMPARE = {
  default: () => 0,
  "title-asc": (a, b) => COLLATOR.compare(a.title, b.title),
  "title-desc": (a, b) => COLLATOR.compare(b.title, a.title),
  "added-desc": (a, b) => compareAdded(a, b, "desc"),
  "added-asc": (a, b) => compareAdded(a, b, "asc"),
};

// Stable: ties keep the order they had in Apple's list.
function ordered(items, sort) {
  const compare = COMPARE[sort];
  return items
    .map((item, index) => ({ item, index }))
    .sort((x, y) => compare(x.item, y.item) || x.index - y.index)
    .map(({ item }) => item);
}

const fold = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

function filtered(section, items, controls) {
  const needle = fold(controls.text ?? "");
  const favorites = favoriteIds(section);
  return items.filter((item) => {
    if (
      needle &&
      ![item.title, item.artist, item.album].some((value) =>
        fold(value).includes(needle),
      )
    ) {
      return false;
    }
    if (controls.favorites && !favorites.includes(item.id)) return false;
    if (controls.content === "explicit" && item.contentRating !== "explicit") {
      return false;
    }
    if (controls.content === "clean" && item.contentRating === "explicit") {
      return false;
    }
    return true;
  });
}

// The reference for a view. Playlists give a layout (root and folder rows);
// the other sections give an id list.
function expectation(section, items, controls) {
  const sort = controls.sort ?? "default";
  const visible = filtered(section, items, controls);
  if (section !== "playlists") {
    return ordered(visible, sort).map((item) => item.id);
  }
  const rootItems = visible.filter((item) => !FOLDER_MEMBERS.includes(item.id));
  const folderItems = visible.filter((item) =>
    FOLDER_MEMBERS.includes(item.id),
  );
  return {
    root: [
      ...(folderItems.length ? [`folder:${FOLDER_ID}`] : []),
      ...ordered(rootItems, sort).map((item) => item.id),
    ],
    folder: ordered(folderItems, sort).map((item) => item.id),
  };
}

function layoutOf(items) {
  return {
    root: items
      .filter((item) => item.folder === null)
      .map((item) => (item.kind === "folder" ? `folder:${item.id}` : item.id)),
    folder: items
      .filter((item) => item.folder === FOLDER_ID && item.kind !== "folder")
      .map((item) => item.id),
  };
}

const sameList = (a, b) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function prefixMatches(rendered, expected, minimum = 12) {
  return (
    rendered.length <= expected.length &&
    rendered.length >= Math.min(expected.length, minimum) &&
    rendered.every((id, index) => id === expected[index])
  );
}

function viewMatches(section, view, expected, controls) {
  if (view.loadingAll) return false;
  if (view.sort !== (controls.sort ?? "default")) return false;
  if (view.text !== (controls.text ?? "")) return false;
  if (
    view.favorites !== null &&
    view.favorites !== String(Boolean(controls.favorites))
  ) {
    return false;
  }
  if (view.content !== null && view.content !== (controls.content ?? "all")) {
    return false;
  }
  if (section === "playlists") {
    const layout = layoutOf(view.items);
    return (
      sameList(layout.root, expected.root) &&
      sameList(layout.folder, expected.folder)
    );
  }
  const ids = view.items.map((item) => item.id);
  if (!prefixMatches(ids, expected)) return false;
  if (section === "albums" || section === "songs") {
    return view.count === `${expected.length} of ${TOTAL[section]}`;
  }
  return true;
}

function summarize(section, view, expected, apple, controls) {
  const rendered =
    section === "playlists"
      ? layoutOf(view.items)
      : view.items.map((item) => item.id).slice(0, 15);
  const reference = section === "playlists" ? expected : expected.slice(0, 15);
  return {
    controls,
    loaded: apple.length,
    count: view.count,
    sort: view.sort,
    text: view.text,
    favorites: view.favorites,
    content: view.content,
    loadingAll: view.loadingAll,
    loadMore: view.loadMore,
    rendered,
    expected: reference,
  };
}

// Applies the controls, then waits until the whole list is loaded and the
// rendered view matches the reference order. Returns what was seen.
async function expectView(page, section, controls) {
  await applyControls(page, controls);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const apple = await appleItems(page, section);
    const view = await readView(page, section);
    const expected = expectation(section, apple, controls);
    const ok =
      apple.length === TOTAL[section] &&
      viewMatches(section, view, expected, controls);
    if (ok || Date.now() >= deadline) {
      return {
        ok,
        view,
        expected,
        apple,
        summary: summarize(section, view, expected, apple, controls),
      };
    }
    await sleep(150);
  }
}

// Scrolls to the end of the list and compares the last rendered rows with
// the reference's last rows. Virtualized lists only render what is visible.
async function tailMatches(page, section, controls) {
  const result = await expectView(page, section, controls);
  const expected = result.expected;
  const length = Math.min(8, expected.length);
  let rendered = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.evaluate(`return ${scrollEdgeScript(ROOTS[section], "end")};`);
    await sleep(250);
    rendered = (await readView(page, section)).items.map((item) => item.id);
    if (rendered.slice(-length).join() === expected.slice(-length).join()) {
      break;
    }
  }
  const tail = {
    expected: expected.slice(-length),
    rendered: rendered.slice(-length),
  };
  await page.evaluate(`return ${scrollEdgeScript(ROOTS[section], "start")};`);
  await sleep(200);
  return {
    ok:
      result.ok &&
      tail.rendered.length === tail.expected.length &&
      tail.rendered.every((id, index) => id === tail.expected[index]),
    tail,
    summary: result.summary,
  };
}

async function openSection(page, section) {
  await page.evaluate(
    `location.hash = ${q(`#/library/${section}`)}; return true;`,
  );
  return waitFor(
    page,
    `document.querySelector(${q(ROOTS[section])}) && document.querySelector('.library-toolbar, .playlist-tree')`,
    15_000,
  );
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

async function startFixture(page, extra = {}) {
  await fixtureCall(page, "reset");
  await fixtureCall(page, "configure", [
    { librarySize: ALBUM_COUNT, libraryView: true, ratings: RATINGS, ...extra },
  ]);
}

const readStorage = (page) =>
  page.evaluate(`return localStorage.getItem(${q(STORAGE_KEY)});`);

/** Library view: sort, text, favorites and content on the four sections, with auto-load. */
export async function runLibraryView({ page, check, artifactDir }) {
  const results = [];
  const record = (name, passed, details) => {
    const ok = Boolean(passed);
    results.push({ name, passed: ok, details });
    check(name, ok, details);
  };

  try {
    await reloadApp(page);
    await startFixture(page);
    await page.evaluate(
      `localStorage.removeItem(${q(STORAGE_KEY)}); return true;`,
    );

    // Albums: first page, then the sorted and filtered views.
    await openSection(page, "albums");
    await waitFor(page, "document.querySelector('[data-context-id]')", 15_000);
    const firstPage = await readView(page, "albums");
    const applePartial = await appleItems(page, "albums");
    record(
      "albums default: first page in Apple order, Load more shown",
      prefixMatches(
        firstPage.items.map((item) => item.id),
        applePartial.map((item) => item.id),
      ) &&
        firstPage.sort === "default" &&
        firstPage.loadMore,
      {
        loaded: applePartial.length,
        rendered: firstPage.items.map((item) => item.id).slice(0, 12),
        loadMore: firstPage.loadMore,
      },
    );

    await openSection(page, "artists");
    await waitFor(page, "document.querySelector('.library-toolbar')", 15_000);
    const artistOptions = await page.evaluate(
      "return [...document.querySelectorAll('select[data-library-sort] option')].map((option) => option.value);",
    );
    const artistControls = await page.evaluate(
      "return { favorites: Boolean(document.querySelector('[data-library-favorites]')), content: Boolean(document.querySelector('[data-library-content]')) };",
    );
    record(
      "artists toolbar has title sorts only, no added sorts, favorites or content",
      artistOptions.includes("title-desc") &&
        !artistOptions.some((value) => value.startsWith("added-")) &&
        !artistControls.favorites &&
        !artistControls.content,
      { artistOptions, artistControls },
    );
    const artistDesc = await expectView(page, "artists", {
      sort: "title-desc",
    });
    record(
      "artists title-desc: auto-loads all 250 and lists the page-3 artist first",
      artistDesc.ok &&
        artistDesc.view.items[0]?.id === "lib-library-artists-00249",
      artistDesc.summary,
    );
    await applyControls(page, {});

    // Albums: Load more is hidden and the status shows while auto-loading.
    await openSection(page, "albums");
    await waitFor(page, "document.querySelector('[data-context-id]')", 15_000);
    await fixtureCall(page, "configure", [
      { delayPaths: ["offset=100"], delayMs: 1500 },
    ]);
    await applyControls(page, { sort: "title-desc" });
    const loadingShown = await waitFor(
      page,
      "document.querySelector('[data-library-loading-all][role=\"status\"]')",
      4000,
    );
    const during = await readView(page, "albums");
    record(
      "albums auto-load: status shows and Load more is hidden while pages load",
      loadingShown && during.loadingAll && !during.loadMore,
      {
        loadingShown,
        loadingAll: during.loadingAll,
        loadMore: during.loadMore,
      },
    );
    await fixtureCall(page, "configure", [{ delayPaths: [] }]);

    const albumDesc = await expectView(page, "albums", { sort: "title-desc" });
    record(
      "albums title-desc: auto-loads every page and lists the page-3 album first",
      albumDesc.ok &&
        albumDesc.view.items[0]?.id === albumId(249) &&
        albumDesc.apple.length === ALBUM_COUNT,
      albumDesc.summary,
    );

    const albumAsc = await expectView(page, "albums", { sort: "title-asc" });
    record(
      "title-asc is numeric: Library Album 2 before Library Album 10, Écho first",
      albumAsc.ok,
      albumAsc.summary,
    );

    const tieDesc = await expectView(page, "albums", {
      sort: "title-desc",
      text: "echo",
    });
    record(
      "Z-A keeps Apple order for tied titles (Écho and echo, 10 albums)",
      tieDesc.ok && tieDesc.expected.length === 10,
      tieDesc.summary,
    );

    const upperCase = await expectView(page, "albums", {
      sort: "title-asc",
      text: "ÉCHO",
    });
    const lowerCase = await expectView(page, "albums", {
      sort: "title-asc",
      text: "echo",
    });
    record(
      "text filter ignores case and diacritics (ÉCHO and echo both find 10)",
      upperCase.ok && lowerCase.ok,
      { upper: upperCase.summary, lower: lowerCase.summary },
    );

    const addedDesc = await tailMatches(page, "albums", {
      sort: "added-desc",
    });
    record(
      "albums added-desc: ties keep Apple order and undated albums end the list",
      addedDesc.ok,
      { ...addedDesc.summary, tail: addedDesc.tail },
    );
    const addedAsc = await tailMatches(page, "albums", { sort: "added-asc" });
    record("albums added-asc: undated albums end the list", addedAsc.ok, {
      ...addedAsc.summary,
      tail: addedAsc.tail,
    });

    const explicit = await expectView(page, "albums", {
      sort: "default",
      content: "explicit",
    });
    record(
      "albums explicit filter lists only explicit albums (50 of 250)",
      explicit.ok && explicit.expected.length === 50,
      explicit.summary,
    );
    const clean = await expectView(page, "albums", {
      sort: "default",
      content: "clean",
    });
    record(
      "albums clean filter lists every other album (200 of 250)",
      clean.ok && clean.expected.length === 200,
      clean.summary,
    );

    const favorites = await expectView(page, "albums", {
      sort: "title-desc",
      favorites: true,
    });
    record(
      "albums favorites show only rated 1, including the page-3 album, not the disliked one",
      favorites.ok &&
        sameList(
          favorites.view.items.map((item) => item.id),
          [albumId(230), albumId(3)],
        ),
      favorites.summary,
    );

    await applyControls(page, {
      sort: "title-desc",
      favorites: true,
      content: "explicit",
      text: "zzqx",
    });
    const noMatches = await waitFor(
      page,
      "document.body.textContent.includes('No matches')",
      8000,
    );
    const emptyView = await readView(page, "albums");
    await page.evaluate(
      "document.querySelector('[data-library-clear]')?.click(); return true;",
    );
    const cleared = await waitFor(
      page,
      `(() => {
        const state = {
          text: document.querySelector('input[data-library-filter]')?.value,
          favorites: document.querySelector('button[data-library-favorites]')?.getAttribute('aria-pressed'),
          content: document.querySelector('select[data-library-content]')?.value,
        };
        return state.text === '' && state.favorites === 'false' && state.content === 'all' && document.querySelectorAll('[data-context-id]').length > 0;
      })()`,
      8000,
    );
    record(
      "no-match state and clear: clear resets text, favorites and content",
      noMatches && emptyView.clearVisible && cleared,
      { noMatches, clearVisible: emptyView.clearVisible, cleared },
    );

    const page3Text = await expectView(page, "albums", {
      sort: "default",
      text: "Library Album 250",
    });
    record(
      "text filter reaches the page-3 album",
      page3Text.ok &&
        sameList(
          page3Text.view.items.map((item) => item.id),
          [albumId(249)],
        ),
      page3Text.summary,
    );
    await applyControls(page, {});

    // Songs.
    await openSection(page, "songs");
    await waitFor(
      page,
      "document.querySelector('.library-track-list [data-context-id]')",
      15_000,
    );
    const songControls = await page.evaluate(
      `return {
        sort: Boolean(document.querySelector('select[data-library-sort]')),
        text: Boolean(document.querySelector('input[data-library-filter]')),
        favorites: Boolean(document.querySelector('button[data-library-favorites]')),
        content: Boolean(document.querySelector('select[data-library-content]')),
      };`,
    );
    record(
      "songs toolbar has sort, text, favorites and content controls",
      Object.values(songControls).every(Boolean),
      songControls,
    );

    const songAsc = await expectView(page, "songs", { sort: "title-asc" });
    record(
      "songs title-asc is numeric and folds Écho titles in with Echo",
      songAsc.ok,
      songAsc.summary,
    );
    const songDesc = await expectView(page, "songs", { sort: "title-desc" });
    record(
      "songs title-desc lists the page-2 song first",
      songDesc.ok && songDesc.view.items[0]?.id === songId(119),
      songDesc.summary,
    );
    const songAdded = await tailMatches(page, "songs", { sort: "added-desc" });
    record(
      "songs added-desc: ties keep Apple order and undated songs end the list",
      songAdded.ok,
      { ...songAdded.summary, tail: songAdded.tail },
    );
    const songExplicit = await expectView(page, "songs", {
      sort: "default",
      content: "explicit",
    });
    record(
      "songs explicit filter lists 30 of 120",
      songExplicit.ok && songExplicit.expected.length === 30,
      songExplicit.summary,
    );
    const songClean = await expectView(page, "songs", {
      sort: "default",
      content: "clean",
    });
    record(
      "songs clean filter lists the other 90 of 120",
      songClean.ok && songClean.expected.length === 90,
      songClean.summary,
    );
    const songFavorites = await expectView(page, "songs", {
      sort: "default",
      favorites: true,
    });
    record(
      "songs favorites show the two rated songs, one from page 2",
      songFavorites.ok &&
        sameList(
          songFavorites.view.items.map((item) => item.id),
          [songId(2), songId(105)],
        ),
      songFavorites.summary,
    );
    const orchard = await expectView(page, "songs", {
      sort: "default",
      text: "orchard",
    });
    record(
      "songs text filter matches album titles and reaches page-2 songs (20 of 120)",
      orchard.ok &&
        orchard.expected.length === 20 &&
        orchard.expected.includes(songId(100)),
      orchard.summary,
    );
    await applyControls(page, {});

    // Playlists: folder layout under each sort and filter.
    await openSection(page, "playlists");
    await waitFor(
      page,
      "document.querySelector('.playlist-folder-heading')",
      15_000,
    );
    const playlistDefault = await expectView(page, "playlists", {
      sort: "default",
    });
    record(
      "playlists default: the Road Trip folder holds its two playlists and sorts first",
      playlistDefault.ok,
      playlistDefault.summary,
    );
    const playlistAsc = await expectView(page, "playlists", {
      sort: "title-asc",
    });
    record(
      "playlists title-asc: folders first at the root, sorted inside each level",
      playlistAsc.ok,
      playlistAsc.summary,
    );
    const playlistDesc = await expectView(page, "playlists", {
      sort: "title-desc",
    });
    record(
      "playlists title-desc: tied Sunday Drive playlists keep Apple order",
      playlistDesc.ok,
      playlistDesc.summary,
    );
    const playlistAdded = await expectView(page, "playlists", {
      sort: "added-desc",
    });
    record(
      "playlists added-desc: an undated playlist ends its level",
      playlistAdded.ok,
      playlistAdded.summary,
    );
    const playlistFavorites = await expectView(page, "playlists", {
      sort: "added-desc",
      favorites: true,
    });
    record(
      "playlists favorites hide unrated root playlists and keep the folder",
      playlistFavorites.ok,
      playlistFavorites.summary,
    );
    const playlistNoFolder = await expectView(page, "playlists", {
      sort: "default",
      text: "afterglow",
    });
    record(
      "playlists text filter hides a folder with no matching playlist",
      playlistNoFolder.ok &&
        playlistNoFolder.view.items.every((item) => item.kind !== "folder"),
      playlistNoFolder.summary,
    );
    const playlistFolder = await expectView(page, "playlists", {
      sort: "default",
      text: "bravo",
    });
    record(
      "playlists text filter keeps a folder whose playlist matches",
      playlistFolder.ok,
      playlistFolder.summary,
    );
    await applyControls(page, {});

    // Auto-load after a page error: the request count stays bounded and the
    // status and Load more settle (reload first, so the list loads afresh).
    await reloadApp(page);
    await startFixture(page, { rejectPaths: ["offset=200"] });
    await page.evaluate(
      `localStorage.setItem(${q(STORAGE_KEY)}, JSON.stringify({ albums: { sort: "title-desc", favorites: false, content: "all" } })); return true;`,
    );
    await openSection(page, "albums");
    await waitFor(
      page,
      `window.__ARLET_E2E_MUSIC__.snapshot().requests.some((r) => r.path.includes("offset=200"))`,
      15_000,
    );
    await sleep(2500);
    const attemptsEarly = await snapshot(page).then(
      ({ requests }) =>
        requests.filter((request) => request.path.includes("offset=200"))
          .length,
    );
    await sleep(2000);
    const errorView = await readView(page, "albums");
    const attemptsLate = await snapshot(page).then(
      ({ requests }) =>
        requests.filter((request) => request.path.includes("offset=200"))
          .length,
    );
    record(
      "auto-load after a failed page stops: bounded requests, no Load more, status settles",
      attemptsEarly >= 1 &&
        attemptsLate <= 3 &&
        attemptsLate === attemptsEarly &&
        !errorView.loadingAll &&
        !errorView.loadMore,
      {
        attemptsEarly,
        attemptsLate,
        loadingAll: errorView.loadingAll,
        loadMore: errorView.loadMore,
      },
    );

    // Persistence: choices survive a reload and stay per section.
    await reloadApp(page);
    await startFixture(page);
    await openSection(page, "albums");
    await expectView(page, "albums", { sort: "title-desc", favorites: true });
    await openSection(page, "songs");
    await waitFor(
      page,
      "document.querySelector('.library-track-list [data-context-id]')",
      15_000,
    );
    await applyControls(page, { sort: "added-desc" });
    await openSection(page, "playlists");
    await waitFor(page, "document.querySelector('.playlist-tree')", 15_000);
    await applyControls(page, { sort: "title-desc" });
    await openSection(page, "albums");
    await waitFor(page, "document.querySelector('[data-context-id]')", 15_000);
    await sleep(500);
    const stored = JSON.parse((await readStorage(page)) ?? "null") ?? {};
    record(
      "choices are stored per section in arlet.library.view.v1",
      stored.albums?.sort === "title-desc" &&
        Boolean(stored.albums?.favorites) &&
        stored.songs?.sort === "added-desc" &&
        stored.playlists?.sort === "title-desc" &&
        !stored.songs?.favorites,
      stored,
    );

    await reloadApp(page);
    await startFixture(page);
    await openSection(page, "albums");
    const restoredAlbums = await waitFor(
      page,
      `(() => {
        const sort = document.querySelector('select[data-library-sort]')?.value;
        const pressed = document.querySelector('button[data-library-favorites]')?.getAttribute('aria-pressed');
        return sort === 'title-desc' && pressed === 'true' && document.querySelector('.library-result-count')?.textContent.trim() === '2 of 250';
      })()`,
      15_000,
    );
    record(
      "albums choice (Z-A and favorites) is restored after reload",
      restoredAlbums,
      await readView(page, "albums").then((view) => view.count),
    );

    await openSection(page, "songs");
    await waitFor(
      page,
      "document.querySelector('.library-track-list [data-context-id]')",
      15_000,
    );
    // Read before any control is applied, so this is the restored state.
    const songsRestored = await readView(page, "songs");
    record(
      "songs keep their own choice after reload and do not take albums' favorites",
      songsRestored.sort === "added-desc" &&
        songsRestored.favorites === "false" &&
        songsRestored.content === "all",
      {
        sort: songsRestored.sort,
        favorites: songsRestored.favorites,
        content: songsRestored.content,
      },
    );

    for (const hash of ["#/library/recent", "#/library/history"]) {
      await page.evaluate(`location.hash = ${q(hash)}; return true;`);
      await waitFor(
        page,
        "document.querySelector('.library-heading h1')",
        15_000,
      );
      const hasToolbar = await page.evaluate(
        "return Boolean(document.querySelector('.library-toolbar'));",
      );
      record(
        `${hash.replace("#/library/", "")} has no library toolbar`,
        !hasToolbar,
        { hasToolbar },
      );
    }
  } finally {
    await page.evaluate(
      `localStorage.removeItem(${q(STORAGE_KEY)}); return true;`,
    );
    await fixtureCall(page, "reset");
    await page.evaluate("location.hash = '#/home'; return true;");
    fs.writeFileSync(
      path.join(artifactDir, "library-view-results.json"),
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
}
