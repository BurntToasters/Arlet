/* UI polish and accessibility checks. Each check names the failure mode it
 * guards in docs/TESTING.md ("UI polish and accessibility"). Browser code runs
 * as strings inside the page, as in the other native scenarios. */

import { fixtureCall, sleep, waitFor } from "./e2e-helpers.js";

const ALBUM = {
  id: "album-polish",
  title: "Polish Fixture Album",
  url: "https://music.apple.com/us/album/polish-fixture-album/album-polish",
  ratingPath: "/v1/me/ratings/albums/album-polish",
  tracks: ["polish-d1-t1", "polish-d1-t2", "polish-d2-t1", "polish-d2-t2"],
  // 703 s; formatRuntime rounds to whole minutes, so this reads 12 min.
  meta: ["2019", "4 songs", "12 min", "Alternative"],
};
const DOT = " · ";
const ELLIPSIS = "…";
// Apple's bgColor for the album-polish artwork in the fixture, with '#'.
const TINT = "#1c2b3a";
const ARTWORK_TEMPLATE =
  "https://is1-ssl.mzstatic.com/image/thumb/Music/e2e/{id}/{w}x{h}bb.jpg";
const REDUCED_MOTION = [{ name: "prefers-reduced-motion", value: "reduce" }];
const KEY_CODES = {
  Tab: 9,
  Enter: 13,
  Escape: 27,
  Home: 36,
  End: 35,
  ArrowLeft: 37,
  ArrowRight: 39,
  ArrowDown: 40,
  F11: 122,
  r: 82,
};

const q = (value) => JSON.stringify(value);

/** Sends one key through CDP. `text` makes it a typed key (Enter needs "\r"). */
async function pressKey(page, key, { modifiers = 0, text } = {}) {
  const common = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    windowsVirtualKeyCode: KEY_CODES[key],
    modifiers,
  };
  await page.send("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    text,
    unmodifiedText: text,
    ...common,
  });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

/** Runs one group; a throw becomes one failed check instead of a lost run. */
async function group(check, name, body) {
  try {
    await body();
  } catch (error) {
    check(`${name} completes`, false, String(error?.message ?? error));
  }
}

const snapshot = (page) =>
  page.evaluate("return window.__ARLET_E2E_MUSIC__.snapshot();");

/** Mutating requests to one path; each check counts only its own clicks. */
const writesTo = (snap, path) =>
  snap.requests.filter(
    (request) => request.method !== "GET" && request.path === path,
  );

const heroReady = (title, rows) =>
  `document.querySelector("section.library-detail-hero h1")?.textContent === ${q(title)} && document.querySelectorAll("button.library-track-row").length >= ${rows}`;

async function openRoute(page, hash, expression, timeoutMs = 12_000) {
  await page.evaluate(`location.hash = ${q(hash)}; return true;`);
  return waitFor(page, expression, timeoutMs);
}

// Only success toasts carry a class (action-toast-success); an error toast is
// any action-toast that is not a success.
const TOAST_SELECTOR = {
  success: ".action-toast.action-toast-success",
  error: ".action-toast:not(.action-toast-success)",
};
const toastHas = (kind, text) =>
  `[...document.querySelectorAll(${q(TOAST_SELECTOR[kind])} + " .action-toast-message")].some((node) => node.textContent.includes(${q(text)}))`;

// Favorite is the header button whose text is exactly "Favorite".
const HERO_FAVORITE = `[...document.querySelectorAll("section.library-detail-hero .library-detail-actions button")].find((node) => node.textContent.trim() === "Favorite")`;
const HERO_PIN = `[...document.querySelectorAll("section.library-detail-hero .library-detail-actions button")].find((node) => ["Pin", "Unpin"].includes(node.textContent.trim()))`;
const MORE_STATE = `const toggle = document.querySelector("button.library-detail-more-toggle"); const panel = document.getElementById("library-detail-more-panel"); return { expanded: toggle?.getAttribute("aria-expanded") ?? null, controls: toggle?.getAttribute("aria-controls") ?? null, hidden: panel ? panel.hidden : null };`;
const NOTES_STATE = `const node = document.querySelector("p.library-detail-notes"); return { text: node?.textContent ?? null, elements: node ? node.children.length : null, unsafeNodes: document.querySelectorAll("main .library-detail-notes :is(i, b, br, img, script)").length, scriptsInMain: document.querySelectorAll("main script").length, flag: window.__ARLET_POLISH_XSS__ === true, facts: [...document.querySelectorAll("dl.library-detail-facts > *")].map((item) => item.textContent) };`;
const MENU_SHAPE = `return [...document.querySelectorAll(".context-menu > *")].map((node) => node.classList.contains("context-menu-separator") ? "|" : (node.getAttribute("data-menu-item") ?? node.textContent.trim()));`;
const ALBUM_CARD = `[...document.querySelectorAll(".card-shell")].find((shell) => shell.querySelector(".home-discovery-card strong")?.textContent === ${q(ALBUM.title)})`;
const TOGGLE_QUEUE = `[...document.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === "Toggle Playing Next")`;
const VOLUME = `document.querySelector('.now-playing input[aria-label="Volume"]')`;
const SEEK = `document.querySelector('.now-playing input[aria-label="Playback position"]')`;
const NP_FULLSCREEN = `[...document.querySelectorAll(".now-playing button")].find((node) => (node.getAttribute("aria-label") ?? "").endsWith("full screen"))`;
const FULLSCREEN_GEOMETRY =
  "window.outerWidth >= screen.width - 2 && window.outerHeight >= screen.height - 2";
const DRAWER_CONTROLS = `[...document.querySelectorAll("aside.sidebar button, aside.sidebar input")].filter((node) => !node.matches(":disabled, [aria-disabled='true']"))`;
const TINT_STATE = `const dialog = document.querySelector(".now-playing"); return { classed: dialog ? dialog.classList.contains("has-artwork-tint") : null, value: dialog ? dialog.style.getPropertyValue("--now-playing-tint") : null };`;
const TAB_STATE = `const tabs = [...document.querySelectorAll('[role="tab"]')]; const selected = tabs.find((tab) => tab.getAttribute("aria-selected") === "true"); return { selected: selected?.id.replace("search-source-tab-", "") ?? null, focused: document.activeElement?.id.replace("search-source-tab-", "") ?? null, panelLabelledBy: document.getElementById("search-source-panel")?.getAttribute("aria-labelledby") ?? null };`;
const WINDOW_STATE = `return { outer: [window.outerWidth, window.outerHeight], screen: [screen.width, screen.height] };`;

/** Opens Now Playing from its artwork button, then reads its animations as it mounts. */
const OPEN_NOW_PLAYING = `
  const opener = document.querySelector("button.player-artwork-button");
  opener.focus();
  opener.click();
  const deadline = Date.now() + 2000;
  while (!document.querySelector(".now-playing") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  const dialog = document.querySelector(".now-playing");
  return {
    opened: Boolean(dialog),
    animations: dialog?.getAnimations().map((animation) => ({
      name: animation.animationName,
      transform: Boolean(animation.effect?.getKeyframes().some((frame) => "transform" in frame)),
    })) ?? [],
  };
`;

const queueIs = (ids, index) =>
  `(() => { const queue = window.__ARLET_E2E_MUSIC__.snapshot().queue; return queue.items.map((item) => item.id).join(",") === ${q(ids.join(","))} && queue.index === ${index}; })()`;

async function closeNowPlaying(page) {
  await page.evaluate(
    `document.querySelector('.now-playing button[aria-label="Close Now Playing"]')?.click(); return true;`,
  );
  return waitFor(page, `!document.querySelector(".now-playing")`, 3000);
}

function separatorProblems(shape) {
  const problems = [];
  if (shape[0] === "|") problems.push("leading separator");
  if (shape.at(-1) === "|") problems.push("trailing separator");
  shape.forEach((entry, index) => {
    if (entry === "|" && shape[index + 1] === "|") {
      problems.push(`double separator at ${index}`);
    }
  });
  return problems;
}

async function moreToggle(page, check) {
  const start = await page.evaluate(MORE_STATE);
  await page.evaluate(
    `document.querySelector("button.library-detail-more-toggle")?.click(); return true;`,
  );
  await waitFor(
    page,
    `document.querySelector("button.library-detail-more-toggle")?.getAttribute("aria-expanded") === "true"`,
    3000,
  );
  const open = await page.evaluate(MORE_STATE);
  const notes = await page.evaluate(NOTES_STATE);
  await page.evaluate(
    `document.querySelector("button.library-detail-more-toggle")?.click(); return true;`,
  );
  await waitFor(
    page,
    `document.querySelector("button.library-detail-more-toggle")?.getAttribute("aria-expanded") === "false"`,
    3000,
  );
  const shut = await page.evaluate(MORE_STATE);
  check(
    "More toggle expands and collapses, with aria-expanded matching the panel",
    start.expanded === "false" &&
      start.hidden === true &&
      start.controls === "library-detail-more-panel" &&
      open.expanded === "true" &&
      open.hidden === false &&
      shut.expanded === "false" &&
      shut.hidden === true,
    { start, open, shut },
  );
  check(
    "editorial notes are plain text: no markup element, no script ran",
    notes.text?.includes("Bold & notes") === true &&
      notes.elements === 0 &&
      notes.unsafeNodes === 0 &&
      notes.scriptsInMain === 0 &&
      notes.flag === false &&
      !notes.text.includes("<i>"),
    notes,
  );
  check(
    "record label and copyright appear under More",
    JSON.stringify(notes.facts) ===
      JSON.stringify([
        "Label",
        "Fixture Records",
        "Copyright",
        "℗ 2019 Fixture Records",
      ]),
    { facts: notes.facts },
  );
}

async function discs(page, check) {
  const groups =
    await page.evaluate(`return [...document.querySelectorAll("div.library-disc-groups > section.library-disc")].map((section) => ({
    heading: section.querySelector("h2.library-disc-heading")?.textContent.trim() ?? null,
    rows: [...section.querySelectorAll("button.library-track-row")].map((row) => ({
      number: row.querySelector(".library-row-number")?.textContent.trim() ?? null,
      title: row.querySelector("strong")?.textContent.trim() ?? null,
    })),
  }));`);
  const headings = groups.map((group) => group.heading);
  const titles = groups.map((group) => group.rows.map((row) => row.title));
  check(
    "Disc 1 and Disc 2 headings group the four tracks in album order",
    JSON.stringify(headings) === JSON.stringify(["Disc 1", "Disc 2"]) &&
      JSON.stringify(titles) ===
        JSON.stringify([
          ["Polish Disc One Track One", "Polish Disc One Track Two"],
          ["Polish Disc Two Track One", "Polish Disc Two Track Two"],
        ]),
    { headings, titles },
  );
  const numbers = groups.map((group) => group.rows.map((row) => row.number));
  check(
    "rows show per-disc track numbers (Disc 2 restarts at 01)",
    JSON.stringify(numbers) ===
      JSON.stringify([
        ["01", "02"],
        ["01", "02"],
      ]),
    {
      numbers,
      note: "LibraryTrackRow does not pass SongRow's discTrackNumbers, so rows use album-wide positions",
    },
  );
  // A mid-list start gives MusicKit the batch from the clicked song; the songs
  // before it are kept as history for Previous (queue-window.ts startWindow).
  const mark = (await snapshot(page)).transitions.length;
  const clickedAt = await page.evaluate(`
    const clickedAt = Date.now();
    const section = [...document.querySelectorAll("section.library-disc")].find((node) => node.querySelector("h2")?.textContent.trim() === "Disc 2");
    section?.querySelector("button.library-track-row")?.click();
    return clickedAt;
  `);
  const started = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().transitions.slice(${mark}).some((item) => item.type === "play")`,
    8000,
  );
  const afterClick = await snapshot(page);
  const batchSet = afterClick.transitions
    .slice(mark)
    .find((item) => item.type === "setQueue");
  const batch = ["polish-d2-t1", "polish-d2-t2"];
  check(
    "clicking the first row of Disc 2 starts MusicKit's queue at that song: [d2 t1, d2 t2] at index 0",
    started &&
      JSON.stringify(afterClick.queue.items.map((item) => item.id)) ===
        JSON.stringify(batch) &&
      afterClick.queue.index === 0 &&
      afterClick.queue.activeId === "polish-d2-t1" &&
      JSON.stringify(batchSet?.ids) === JSON.stringify(batch) &&
      batchSet?.options?.startWith === 0,
    {
      activeId: afterClick.queue.activeId,
      index: afterClick.queue.index,
      ids: afterClick.queue.items.map((item) => item.id),
      setQueueIds: batchSet?.ids,
      startWith: batchSet?.options?.startWith,
    },
  );

  // The page already shows all four songs, so Play fetches no track pages.
  const refetched = afterClick.requests.filter(
    (request) =>
      request.startedAt >= clickedAt &&
      String(request.path).includes("/albums/album-polish"),
  ).length;
  check(
    "the Disc 2 Play was given the whole album from the page: no track pages fetched",
    refetched === 0,
    { refetched },
  );

  // Previous steps back into Disc 1, which proves the earlier songs were kept.
  const previousMark = afterClick.transitions.length;
  await page.evaluate(`
    document.querySelector('button[aria-label="Previous track"]')?.click();
    return true;
  `);
  const steppedBack = await waitFor(
    page,
    `document.querySelector(".player-bar .player-track-copy strong")?.textContent === "Polish Disc One Track Two"`,
    8000,
  );
  const back = await snapshot(page);
  const backSet = back.transitions
    .slice(previousMark)
    .find((item) => item.type === "setQueue");
  check(
    "Previous from Disc 2 track 1 plays Disc 1 track 2 (the album's earlier songs are kept)",
    steppedBack && backSet?.ids?.[0] === "polish-d1-t2",
    {
      setQueueIds: backSet?.ids,
      transitions: back.transitions.slice(previousMark),
    },
  );
}

async function favorite(page, check) {
  const ready = await waitFor(
    page,
    `Boolean((${HERO_FAVORITE})?.hasAttribute("aria-pressed"))`,
    8000,
  );
  const pressedStart = await page.evaluate(
    `return (${HERO_FAVORITE})?.getAttribute("aria-pressed") ?? null;`,
  );
  const writesStart = writesTo(await snapshot(page), ALBUM.ratingPath).length;
  await page.evaluate(`(${HERO_FAVORITE})?.click(); return true;`);
  const pressedOn = await waitFor(
    page,
    `(${HERO_FAVORITE})?.getAttribute("aria-pressed") === "true"`,
    4000,
  );
  await sleep(300);
  await page.evaluate(`(${HERO_FAVORITE})?.click(); return true;`);
  const pressedOff = await waitFor(
    page,
    `(${HERO_FAVORITE})?.getAttribute("aria-pressed") === "false"`,
    4000,
  );
  await sleep(300);
  const writes = writesTo(await snapshot(page), ALBUM.ratingPath).slice(
    writesStart,
  );
  const methods = writes.map((request) => request.method);
  check(
    "header Favorite toggles once per click, sending one PUT then one DELETE",
    ready &&
      pressedStart === "false" &&
      pressedOn &&
      pressedOff &&
      JSON.stringify(methods) === JSON.stringify(["PUT", "DELETE"]) &&
      writes[0]?.body?.attributes?.value === 1,
    {
      pressedStart,
      methods,
      firstBody: writes[0]?.body,
      path: ALBUM.ratingPath,
    },
  );
}

async function albumDetail(page, check) {
  const meta = await page.evaluate(
    `return document.querySelector("section.library-detail-hero p.library-detail-meta")?.textContent.trim() ?? null;`,
  );
  check(
    "album metadata: year, song count, runtime from 703 s, genre",
    meta === ALBUM.meta.join(DOT),
    { expected: ALBUM.meta.join(DOT), actual: meta },
  );
  await moreToggle(page, check);
  await discs(page, check);
  await favorite(page, check);
}

async function albumMenu(page, check) {
  await page.evaluate(
    `document.querySelector('section.library-detail-hero button[aria-label="More actions for ${ALBUM.title}"]')?.click(); return true;`,
  );
  const open = await waitFor(
    page,
    `document.querySelector('.context-menu[role="menu"]')`,
    4000,
  );
  const target = await page.evaluate(
    `const hero = document.querySelector("section.library-detail-hero"); return { kind: hero?.dataset.contextKind ?? null, id: hero?.dataset.contextId ?? null };`,
  );
  // The menu focuses its first item in an effect after it renders.
  await sleep(150);
  const shape = await page.evaluate(MENU_SHAPE);
  const items = shape.filter((entry) => entry !== "|");
  check(
    "More actions opens the album menu and its target is the album",
    open && target.kind === "album" && target.id === ALBUM.id,
    { target, items },
  );
  check(
    "context menu has no leading, trailing or double separators",
    separatorProblems(shape).length === 0,
    { shape, problems: separatorProblems(shape) },
  );
  const first = await page.evaluate(
    `return document.activeElement?.getAttribute("data-menu-item") ?? null;`,
  );
  const visited = [];
  for (let step = 0; step < items.length; step += 1) {
    await pressKey(page, "ArrowDown");
    visited.push(
      await page.evaluate(
        `return document.activeElement?.getAttribute("data-menu-item") ?? document.activeElement?.tagName ?? null;`,
      ),
    );
  }
  check(
    "ArrowDown visits each menu item once, wraps, and never lands on a separator",
    new Set(visited).size === items.length &&
      items.every((item) => visited.includes(item)) &&
      visited.at(-1) === first,
    { first, visited, items },
  );
  check(
    "album header menu offers Copy Apple Music link for the album",
    items.includes("copy-link"),
    {
      items,
      note: "the hero has no data-context-catalog-url, so the copy-link item is absent",
    },
  );
  await pressKey(page, "Escape");
  const closed = await waitFor(
    page,
    `!document.querySelector(".context-menu")`,
    3000,
  );
  const focusBack = await page.evaluate(
    `return document.activeElement?.getAttribute("aria-label") ?? null;`,
  );
  check(
    "Escape closes the album menu and returns focus to its More button",
    closed && focusBack === `More actions for ${ALBUM.title}`,
    { closed, focusBack },
  );
}

async function otherDetails(page, check) {
  await openRoute(
    page,
    "#/album/album-polish-sparse?source=catalog",
    heroReady("Polish Sparse Album", 1),
  );
  const sparse = await page.evaluate(
    `return { meta: document.querySelector("section.library-detail-hero p.library-detail-meta")?.textContent.trim() ?? null, toggle: Boolean(document.querySelector("button.library-detail-more-toggle")), more: Boolean(document.querySelector("section.library-detail-more")), hero: document.querySelector("section.library-detail-hero")?.textContent ?? "" };`,
  );
  check(
    "sparse album shows only its song count: no invented year, runtime, genre or More",
    sparse.meta === "1 song" &&
      !sparse.toggle &&
      !sparse.more &&
      !/NaN|0 min/u.test(sparse.hero),
    sparse,
  );

  await openRoute(page, "#/album/album-1", heroReady("Fixture Album", 1));
  const singleDisc = await page.evaluate(
    `return { headings: document.querySelectorAll("h2.library-disc-heading").length, groups: document.querySelectorAll("div.library-disc-groups").length };`,
  );
  check(
    "a single-disc album shows no Disc heading",
    singleDisc.headings === 0 && singleDisc.groups === 0,
    singleDisc,
  );

  await openRoute(
    page,
    "#/playlist/pl.polish-fixture?source=catalog",
    heroReady("Polish Fixture Playlist", 2),
  );
  const playlistMeta = await page.evaluate(
    `return document.querySelector("section.library-detail-hero p.library-detail-meta")?.textContent.trim() ?? null;`,
  );
  const expectedPlaylistMeta = [
    "2 songs",
    "6 min",
    "Curated by Apple Music",
  ].join(DOT);
  check(
    "playlist metadata: song count, runtime from 385 s, curator",
    playlistMeta === expectedPlaylistMeta,
    { expected: expectedPlaylistMeta, actual: playlistMeta },
  );
  await page.evaluate(
    `document.querySelector("button.library-detail-more-toggle")?.click(); return true;`,
  );
  await waitFor(
    page,
    `document.querySelector("button.library-detail-more-toggle")?.getAttribute("aria-expanded") === "true"`,
    3000,
  );
  const playlistNotes = await page.evaluate(NOTES_STATE);
  check(
    "playlist description renders as plain text, with its image tag and script inert",
    playlistNotes.text === "Plain text & a" &&
      playlistNotes.elements === 0 &&
      playlistNotes.unsafeNodes === 0 &&
      playlistNotes.flag === false,
    playlistNotes,
  );
  const pinLabel = await page.evaluate(
    `return (${HERO_PIN})?.textContent.trim() ?? null;`,
  );
  await page.evaluate(`(${HERO_PIN})?.click(); return true;`);
  const pinnedLabel = await waitFor(
    page,
    `(${HERO_PIN})?.textContent.trim() === ${q(pinLabel === "Pin" ? "Unpin" : "Pin")}`,
    4000,
  );
  const afterPin = await page.evaluate(
    `return (${HERO_PIN})?.textContent.trim() ?? null;`,
  );
  await page.evaluate(`(${HERO_PIN})?.click(); return true;`);
  const restored = await waitFor(
    page,
    `(${HERO_PIN})?.textContent.trim() === ${q(pinLabel)}`,
    4000,
  );
  check(
    "Pin and Unpin flip the playlist header label both ways",
    pinLabel !== null && pinnedLabel && afterPin !== pinLabel && restored,
    { pinLabel, afterPin },
  );
}

async function searchCards(page, check) {
  await openRoute(page, "#/search?q=polish", `Boolean(${ALBUM_CARD})`, 12_000);
  const card = await page.evaluate(
    `const shell = ${ALBUM_CARD}; return shell ? { kind: shell.dataset.contextKind ?? null, catalogUrl: shell.dataset.contextCatalogUrl ?? null } : null;`,
  );
  check(
    "album card carries its Apple Music link on the card shell",
    card?.kind === "album" && card.catalogUrl === ALBUM.url,
    { card, expected: ALBUM.url },
  );

  await page.evaluate(
    `${ALBUM_CARD}.querySelector(".home-discovery-card").focus(); return true;`,
  );
  const tabs = [];
  for (let step = 0; step < 2; step += 1) {
    await pressKey(page, "Tab");
    tabs.push(
      await page.evaluate(
        `const node = document.activeElement; const style = node ? getComputedStyle(node) : null; return { label: node?.getAttribute("aria-label") ?? node?.tagName ?? null, visible: style ? style.visibility !== "hidden" && style.display !== "none" : false };`,
      ),
    );
  }
  check(
    "keyboard Tab from the card reaches its Play button, then its More actions button",
    tabs[0].label === `Play ${ALBUM.title}` &&
      tabs[1].label === `More actions for ${ALBUM.title}` &&
      tabs[1].visible,
    tabs,
  );

  await pressKey(page, "Enter", { text: "\r" });
  const menuOpen = await waitFor(
    page,
    `document.querySelector('.context-menu[role="menu"]')`,
    4000,
  );
  const shape = await page.evaluate(MENU_SHAPE);
  check(
    "card menu offers Copy Apple Music link and has clean separators",
    menuOpen &&
      shape.includes("copy-link") &&
      separatorProblems(shape).length === 0,
    { shape, problems: separatorProblems(shape) },
  );

  await page.evaluate(
    `document.querySelector('.context-menu [data-menu-item="copy-link"]')?.click(); return true;`,
  );
  const toast = await waitFor(page, toastHas("success", "Link copied."), 5000);
  const wrongKind = await page.evaluate(
    `return ${toastHas("error", "Link copied.")};`,
  );
  check(
    "copy-link shows the success toast, not the error style",
    toast && wrongKind === false,
    { toast, errorStyled: wrongKind },
  );
  await page.evaluate(
    `${ALBUM_CARD}.querySelector(".card-action-play")?.click(); return true;`,
  );
  const played = await waitFor(page, queueIs(ALBUM.tracks, 0), 8000);
  const queue = (await snapshot(page)).queue;
  check(
    "card Play starts the album from its first track",
    played && queue.activeId === ALBUM.tracks[0],
    { ids: queue.items.map((item) => item.id), index: queue.index },
  );
}

async function searchTabs(page, check) {
  await openRoute(
    page,
    "#/search?q=polish",
    `Boolean(document.getElementById("search-source-tab-catalog"))`,
  );
  await page.evaluate(
    `document.getElementById("search-source-tab-catalog").focus(); return true;`,
  );
  const steps = [
    ["Home", "catalog"],
    ["ArrowRight", "library"],
    ["ArrowRight", "catalog"],
    ["End", "library"],
    ["ArrowLeft", "catalog"],
  ];
  const seen = [];
  for (const [key, expected] of steps) {
    await pressKey(page, key);
    const state = await page.evaluate(TAB_STATE);
    seen.push({ key, expected, ...state });
  }
  check(
    "Arrow, Home and End keys move selection, focus and the tabpanel label together",
    seen.every(
      (step) =>
        step.selected === step.expected &&
        step.focused === step.expected &&
        step.panelLabelledBy === `search-source-tab-${step.expected}`,
    ),
    seen,
  );
  await pressKey(page, "Home");
}

async function nowPlaying(page, check) {
  await fixtureCall(page, "setCurrentTrack", [ALBUM.tracks[0]]);
  await waitFor(
    page,
    `document.querySelector("button.player-artwork-button")?.disabled === false`,
    8000,
  );
  // Baseline first: the open animation must move the dialog when motion is allowed.
  const baseline = await page.evaluate(OPEN_NOW_PLAYING);
  check(
    "open animation moves the dialog when motion is allowed (baseline)",
    baseline.opened && baseline.animations.some((item) => item.transform),
    baseline,
  );

  const labels = await page.evaluate(
    `return [...document.querySelectorAll(".now-playing button")].map((node) => node.getAttribute("aria-label")).filter(Boolean);`,
  );
  const required = [
    /^(Favorite|Undo Favorite)$/u,
    /^(Dislike|Remove dislike)$/u,
    /^Toggle shuffle$/u,
    /^Repeat (off|songs|one)$/u,
    /^(Mute|Unmute)$/u,
    /full screen$/u,
    /^Close Now Playing$/u,
  ];
  const missing = required
    .filter((pattern) => !labels.some((label) => pattern.test(label)))
    .map(String);
  check("Now Playing controls carry their state labels", missing.length === 0, {
    labels,
    missing,
  });

  const volumeStart = await page.evaluate(
    `return ${VOLUME}?.getAttribute("aria-valuetext") ?? null;`,
  );
  await page.evaluate(`
    const input = ${VOLUME};
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setValue.call(input, "0.6");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  const volumeReached = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().volume === 0.6`,
    4000,
  );
  const volumeText = await page.evaluate(
    `return ${VOLUME}?.getAttribute("aria-valuetext") ?? null;`,
  );
  check(
    "volume slider reads a percentage and reaches the player",
    volumeReached && volumeText === "60%" && /^\d{1,3}%$/u.test(volumeStart),
    { volumeStart, volumeText },
  );

  await fixtureCall(page, "emitPlaybackTime", [83]);
  const seekReady = await waitFor(
    page,
    `${SEEK}?.getAttribute("aria-valuetext") === "1:23 of 3:00"`,
    4000,
  );
  const seekText = await page.evaluate(
    `return ${SEEK}?.getAttribute("aria-valuetext") ?? null;`,
  );
  check("seek slider reads m:ss of m:ss, not a raw number", seekReady, {
    seekText,
    note: "the fixture reports a fixed 180 s duration, so the total is 3:00",
  });

  const tinted = await page.evaluate(TINT_STATE);
  check(
    "artwork bgColor tints Now Playing through --now-playing-tint",
    tinted.classed === true && tinted.value === TINT,
    tinted,
  );
  await fixtureCall(page, "setCurrentTrack", ["song-a"]);
  const plainTitle = await waitFor(
    page,
    `document.querySelector(".now-playing h2")?.textContent === "Track A"`,
    4000,
  );
  const plain = await page.evaluate(TINT_STATE);
  check(
    "a track without bgColor keeps the plain surface (no tint class or property)",
    plainTitle && plain.classed === false && plain.value === "",
    { plainTitle, ...plain },
  );

  await page.evaluate(
    `document.querySelector("button.player-artwork-button")?.focus(); return true;`,
  );
  const closed = await closeNowPlaying(page);
  const focusBack = await waitFor(
    page,
    `document.activeElement === document.querySelector("button.player-artwork-button")`,
    3000,
  );
  check(
    "closing Now Playing returns focus to the artwork button and unmounts it",
    closed && focusBack,
    { closed, focusBack },
  );

  await page.send("Emulation.setEmulatedMedia", { features: REDUCED_MOTION });
  try {
    const reduced = await page.evaluate(OPEN_NOW_PLAYING);
    check(
      "reduced motion: opening Now Playing runs no transform animation",
      reduced.opened && !reduced.animations.some((item) => item.transform),
      reduced,
    );
    // Reduced motion unmounts at once; no exit transition is waited for.
    await page.evaluate(
      `document.querySelector('.now-playing button[aria-label="Close Now Playing"]')?.click(); return true;`,
    );
    const unmounted = await waitFor(
      page,
      `!document.querySelector(".now-playing")`,
      400,
    );
    check(
      "reduced motion: closing Now Playing unmounts within 400 ms",
      unmounted,
      { unmounted },
    );
  } finally {
    await page.send("Emulation.setEmulatedMedia", { features: [] });
  }
}

async function queueDrawer(page, check) {
  await page.evaluate(
    `(${TOGGLE_QUEUE})?.focus(); (${TOGGLE_QUEUE})?.click(); return true;`,
  );
  const open = await waitFor(
    page,
    `document.querySelector('aside.queue-drawer[data-state="open"]')`,
    4000,
  );
  const focus = await page.evaluate(
    `const node = document.activeElement; return { tag: node?.tagName ?? null, text: node?.textContent.trim() ?? null, inDrawer: Boolean(node?.closest("aside.queue-drawer")) };`,
  );
  check(
    "opening Playing Next moves focus to its heading",
    open &&
      focus.tag === "H2" &&
      focus.text === "Playing Next" &&
      focus.inDrawer,
    focus,
  );
  await pressKey(page, "Escape");
  const focusBack = await waitFor(
    page,
    `document.activeElement === (${TOGGLE_QUEUE})`,
    3000,
  );
  const gone = await waitFor(
    page,
    `!document.querySelector("aside.queue-drawer")`,
    3000,
  );
  check(
    "Escape closes Playing Next and returns focus to its toggle",
    focusBack && gone,
    { focusBack, gone },
  );
}

async function errorToast(page, check) {
  await fixtureCall(page, "configure", [{ rejectPaths: [ALBUM.ratingPath] }]);
  try {
    await openRoute(
      page,
      `#/album/${ALBUM.id}?source=catalog`,
      heroReady(ALBUM.title, 4),
    );
    await waitFor(
      page,
      `Boolean((${HERO_FAVORITE})?.hasAttribute("aria-pressed"))`,
      8000,
    );
    await page.evaluate(`(${HERO_FAVORITE})?.click(); return true;`);
    const error = await waitFor(
      page,
      toastHas("error", "Fixture request rejected"),
      5000,
    );
    const successStyled = await page.evaluate(
      `return ${toastHas("success", "Fixture request rejected")};`,
    );
    const pressed = await page.evaluate(
      `return (${HERO_FAVORITE})?.getAttribute("aria-pressed") ?? null;`,
    );
    check(
      "a rejected rating shows the error style and rolls Favorite back",
      error && successStyled === false && pressed === "false",
      { error, successStyled, pressed },
    );
  } finally {
    await fixtureCall(page, "configure", [{ rejectPaths: [] }]);
  }
}

async function skeletons(page, check) {
  // Radio, not Albums: earlier scenarios may have cached the library lists.
  await fixtureCall(page, "configure", [
    { delayPaths: ["/v1/catalog/us/stations"], delayMs: 1500 },
  ]);
  await page.evaluate(`location.hash = "#/radio"; return true;`);
  const seen = await waitFor(
    page,
    `document.querySelector('.skeleton-status[role="status"]')`,
    4000,
  );
  const label = await page.evaluate(
    `return document.querySelector('.skeleton-status[role="status"] .sr-only')?.textContent ?? null;`,
  );
  const gone = await waitFor(
    page,
    `!document.querySelector(".skeleton-status")`,
    8000,
  );
  check(
    `radio first load shows a labelled role=status skeleton, removed once data renders`,
    seen && label === `Loading Radio${ELLIPSIS}` && gone,
    { seen, label, gone },
  );

  await fixtureCall(page, "configure", [
    { delayPaths: [], rejectPaths: ["/v1/catalog/us/stations"] },
  ]);
  await page.evaluate(`location.hash = "#/settings"; return true;`);
  await page.evaluate(`location.hash = "#/radio"; return true;`);
  await sleep(2500);
  const stuck = await page.evaluate(
    `return Boolean(document.querySelector(".skeleton-status"));`,
  );
  check("a failed first load ends the skeleton instead of keeping it", !stuck, {
    stuck,
  });
  await fixtureCall(page, "configure", [{ rejectPaths: [] }]);

  // Refresh with cards already on screen must keep them, not swap in a skeleton.
  await fixtureCall(page, "configure", [
    { delayPaths: [], rejectPaths: [], librarySize: 12 },
  ]);
  await openRoute(
    page,
    "#/library/albums",
    `document.querySelectorAll(".library-card").length > 0`,
    10_000,
  );
  await fixtureCall(page, "configure", [
    { delayPaths: ["/v1/me/library/albums"], delayMs: 1500 },
  ]);
  const albumReads = async () =>
    (await snapshot(page)).requests.filter((request) =>
      request.path.startsWith("/v1/me/library/albums"),
    ).length;
  const readsBefore = await albumReads();
  await pressKey(page, "r", { modifiers: 2 });
  await sleep(400);
  const during = await page.evaluate(
    `return { cards: document.querySelectorAll(".library-card").length, skeletons: document.querySelectorAll(".skeleton-status").length };`,
  );
  const issued = (await albumReads()) - readsBefore;
  check(
    "Ctrl+R refresh keeps album cards on screen and shows no skeleton",
    issued > 0 && during.cards > 0 && during.skeletons === 0,
    { issued, during },
  );
  await sleep(1800);
  await fixtureCall(page, "configure", [{ delayPaths: [], librarySize: 0 }]);
}

async function aboutLinks(page, check) {
  await openRoute(
    page,
    "#/settings",
    `document.querySelectorAll('.settings-section[aria-labelledby="about-heading"] button.about-link').length === 3`,
    12_000,
  );
  // Not clicked: each link runs ShellExecuteW on the tester's machine. Only the
  // rendered markup is checked; the command's arguments are not observed.
  const labels = ["Project page", "Release notes", "License"];
  const releaseReady = await waitFor(
    page,
    `(() => { const button = [...document.querySelectorAll('.settings-section[aria-labelledby="about-heading"] button.about-link')].find((node) => node.querySelector("span")?.textContent.trim() === "Release notes"); return Boolean(button) && !button.disabled; })()`,
    8000,
  );
  const links = await page.evaluate(
    `return [...document.querySelectorAll('.settings-section[aria-labelledby="about-heading"] button.about-link')].map((node) => ({ label: node.querySelector("span")?.textContent.trim() ?? null, type: node.getAttribute("type"), href: node.hasAttribute("href"), target: node.hasAttribute("target"), disabled: node.disabled }));`,
  );
  const anchors = await page.evaluate(
    `return document.querySelectorAll('.settings-section[aria-labelledby="about-heading"] a[href]').length;`,
  );
  check(
    "About links are enabled type=button elements labelled Project page, Release notes and License, with no href or target (not clicked)",
    releaseReady &&
      anchors === 0 &&
      JSON.stringify(links.map((link) => link.label)) ===
        JSON.stringify(labels) &&
      links.every(
        (link) =>
          link.type === "button" &&
          !link.href &&
          !link.target &&
          !link.disabled,
      ),
    { links, anchors, releaseReady },
  );
}

async function compactShell(page, check) {
  const focused = await openRoute(
    page,
    "#/browse",
    `document.activeElement?.tagName === "H1"`,
    6000,
  );
  check("a route change moves focus to the page h1", focused, {
    active: await page.evaluate(
      `return document.activeElement?.tagName ?? null;`,
    ),
  });

  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 640,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  try {
    const compact = await waitFor(
      page,
      `window.matchMedia("(max-width: 720px)").matches`,
      3000,
    );
    check(
      "viewport override switches the shell to the compact layout (720 px)",
      compact,
      { compact, window: await page.evaluate(WINDOW_STATE) },
    );
    if (!compact) return;

    await page.evaluate(
      `document.querySelector(".mobile-menu-button")?.click(); return true;`,
    );
    const opened = await waitFor(
      page,
      `document.querySelector("aside.sidebar")?.classList.contains("is-open")`,
      3000,
    );
    const focusInside = await page.evaluate(
      `return Boolean(document.querySelector("aside.sidebar")?.contains(document.activeElement));`,
    );
    check(
      "opening the compact drawer moves focus into it",
      opened && focusInside,
      { opened, focusInside },
    );

    await pressKey(page, "Escape");
    const closed = await waitFor(
      page,
      `!document.querySelector("aside.sidebar")?.classList.contains("is-open")`,
      3000,
    );
    const back = await waitFor(
      page,
      `document.activeElement === document.querySelector(".mobile-menu-button")`,
      3000,
    );
    check(
      "Escape closes the compact drawer and focuses the menu button",
      closed && back,
      { closed, back },
    );

    await page.evaluate(
      `document.querySelector(".mobile-menu-button")?.click(); return true;`,
    );
    await waitFor(
      page,
      `document.querySelector("aside.sidebar")?.classList.contains("is-open")`,
      3000,
    );
    await page.evaluate(
      `const controls = ${DRAWER_CONTROLS}; controls.at(-1)?.focus(); return true;`,
    );
    await pressKey(page, "Tab");
    const wrapped = await page.evaluate(
      `const controls = ${DRAWER_CONTROLS}; return { first: controls[0]?.getAttribute("aria-label") ?? controls[0]?.className ?? null, active: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.className ?? null, atFirst: document.activeElement === controls[0] };`,
    );
    check(
      "Tab on the last drawer control wraps to the first one",
      wrapped.atFirst === true,
      wrapped,
    );
    await pressKey(page, "Escape");
  } finally {
    await page.send("Emulation.clearDeviceMetricsOverride", {});
  }
}

async function fullscreen(page, check) {
  await fixtureCall(page, "setCurrentTrack", [ALBUM.tracks[0]]);
  await page.evaluate(OPEN_NOW_PLAYING);
  const before = await page.evaluate(WINDOW_STATE);
  await pressKey(page, "F11");
  const labelFlipped = await waitFor(
    page,
    `(${NP_FULLSCREEN})?.getAttribute("aria-label") === "Exit full screen"`,
    4000,
  );
  const covered = await waitFor(page, FULLSCREEN_GEOMETRY, 4000);
  const during = await page.evaluate(WINDOW_STATE);
  check(
    "F11 enters window fullscreen; the Now Playing button then reads Exit full screen",
    labelFlipped && covered,
    {
      before,
      during,
      note: "window fullscreen is read from the window size against the screen, since the app uses window fullscreen, not DOM fullscreen",
    },
  );
  await pressKey(page, "Escape");
  const closed = await waitFor(
    page,
    `!document.querySelector(".now-playing")`,
    4000,
  );
  const left = await waitFor(page, `!(${FULLSCREEN_GEOMETRY})`, 4000);
  const after = await page.evaluate(WINDOW_STATE);
  check(
    "Escape in Now Playing closes it and leaves fullscreen",
    closed && left,
    {
      closed,
      left,
      after,
    },
  );
}

async function cleanup(page) {
  await page.evaluate(`
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.querySelector('aside.queue-drawer button[aria-label="Close Playing Next"]')?.click();
    return true;
  `);
  await page.send("Emulation.clearDeviceMetricsOverride", {});
  await page.send("Emulation.setEmulatedMedia", { features: [] });
  if (await page.evaluate(`return ${FULLSCREEN_GEOMETRY};`)) {
    await pressKey(page, "F11");
    await waitFor(page, `!(${FULLSCREEN_GEOMETRY})`, 4000);
  }
  await fixtureCall(page, "reset");
  await page.evaluate(`location.hash = "#/home"; return true;`);
}

/**
 * Runs the UI polish checks against the native WebView2 fixture. Called with
 * `{ page, check, dataDir }`; the data directory is not needed here.
 */
export async function runPolish({ page, check }) {
  await fixtureCall(page, "reset");
  // Queue items read their top-level artwork only with this template set; the
  // polish tracks then carry Apple's bgColor into Now Playing.
  await fixtureCall(page, "configure", [{ artworkTemplate: ARTWORK_TEMPLATE }]);
  const rendered = await openRoute(
    page,
    `#/album/${ALBUM.id}?source=catalog`,
    `document.querySelector("main.content-area")?.textContent.includes(${q(ALBUM.title)})`,
    10_000,
  );
  const detail = rendered
    ? undefined
    : await page.evaluate(`return {
        hash: location.hash,
        text: document.querySelector("main.content-area")?.textContent.slice(0, 200) ?? null,
      };`);
  check("polish fixture data reachable", rendered, detail);

  try {
    await group(check, "album detail", () => albumDetail(page, check));
    await group(check, "album header menu", () => albumMenu(page, check));
    await group(check, "sparse, single-disc and playlist detail", () =>
      otherDetails(page, check),
    );
    await group(check, "search cards", () => searchCards(page, check));
    await group(check, "search source tabs", () => searchTabs(page, check));
    await group(check, "now playing", () => nowPlaying(page, check));
    await group(check, "queue drawer", () => queueDrawer(page, check));
    await group(check, "rating error toast", () => errorToast(page, check));
    await group(check, "skeletons", () => skeletons(page, check));
    await group(check, "about links", () => aboutLinks(page, check));
    await group(check, "compact shell", () => compactShell(page, check));
    await group(check, "fullscreen", () => fullscreen(page, check));
  } finally {
    await cleanup(page);
  }
}
