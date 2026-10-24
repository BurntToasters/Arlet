/* UI polish and accessibility checks. Each check names the failure mode it
 * guards in docs/TESTING.md ("UI polish and accessibility"). Browser code runs
 * as strings inside the page, as in the other native scenarios. */

import { fixtureCall, sleep, waitFor } from "./e2e-helpers.js";
import fs from "node:fs";
import path from "node:path";

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
const BLOOM_FIXTURES = [
  {
    label: "blue",
    id: "polish-bloom-blue",
    colors: ["#0756d8", "#12d5ff", "#061b69"],
  },
  {
    label: "orange",
    id: "polish-bloom-orange",
    colors: ["#f04400", "#ffc247", "#6f1905"],
  },
  {
    label: "dark",
    id: "polish-bloom-dark",
    colors: ["#080a10", "#323944", "#15171c"],
  },
  {
    label: "pale",
    id: "polish-bloom-pale",
    colors: ["#fff8e8", "#e7d9c5", "#fbfaf6"],
  },
  { label: "missing", id: "song-no-art" },
];
const BLOOM_VIEWPORTS = [
  { label: "desktop", width: 1280, height: 850 },
  { label: "narrow", width: 390, height: 1200 },
];
const BLOOM_THEMES = ["dark", "light"];
const BLOOM_QUEUE_IDS = [
  ...BLOOM_FIXTURES.filter((fixture) => fixture.colors).map(
    (fixture) => fixture.id,
  ),
];
/** A little longer than the 200 ms `.now-playing` exit transition. */
const CLOSE_SETTLE_MS = 300;
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
  Space: 32,
};

const q = (value) => JSON.stringify(value);

/** Sends one key through CDP. `text` makes it a typed key (Enter needs "\r"). */
async function pressKey(page, key, { modifiers = 0, text } = {}) {
  const common = {
    key,
    code:
      key === " "
        ? "Space"
        : key.length === 1
          ? `Key${key.toUpperCase()}`
          : key,
    windowsVirtualKeyCode: key === " " ? KEY_CODES.Space : KEY_CODES[key],
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
// The two bloom layers read from the same artwork URL; their play state must
// follow playback without the dialog remounting.
const BLOOM_STATE = `const dialog = document.querySelector(".now-playing"); const backdrop = dialog?.querySelector("img.now-playing-backdrop"); const halo = dialog?.querySelector("img.now-playing-artwork-bloom"); const playState = (node) => node ? getComputedStyle(node).animationPlayState : null; const animationName = (node) => node ? getComputedStyle(node).animationName : null; return { classed: dialog?.classList.contains("has-artwork-bloom") ?? null, playing: dialog?.classList.contains("is-playing") ?? null, backdrop: Boolean(backdrop), halo: Boolean(halo), backdropAlt: backdrop?.getAttribute("alt") ?? null, backdropHidden: backdrop?.getAttribute("aria-hidden") ?? null, backdropUrl: backdrop?.getAttribute("src") ?? null, haloUrl: halo?.getAttribute("src") ?? null, backdropPlayState: playState(backdrop), haloPlayState: playState(halo), backdropAnimation: animationName(backdrop), haloAnimation: animationName(halo) };`;
const BLOOM_SVG = (colors) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors[0]}"/><stop offset=".56" stop-color="${colors[1]}"/><stop offset="1" stop-color="${colors[2]}"/></linearGradient><radialGradient id="r"><stop stop-color="${colors[1]}" stop-opacity=".9"/><stop offset="1" stop-color="${colors[0]}" stop-opacity="0"/></radialGradient></defs><rect width="640" height="640" fill="url(#g)"/><circle cx="200" cy="210" r="280" fill="url(#r)"/><path d="M0 500 640 260v380H0Z" fill="${colors[2]}" opacity=".45"/><circle cx="465" cy="120" r="94" fill="${colors[1]}" opacity=".42"/></svg>`,
  )}`;
// Floating surfaces blur what is behind them; an opaque background hides the
// blur and lets underlying text clash.
const GLASS_STATE = (selector) => `
  const node = document.querySelector(${q(selector)});
  if (!node) return null;
  const style = getComputedStyle(node);
  const color = style.backgroundColor;
  const alphaMatch =
    color.match(/\\/\\s*([\\d.]+)\\s*\\)/u) ??
    color.match(/rgba\\([^)]*,\\s*([\\d.]+)\\)/u);
  return {
    backdropFilter: style.backdropFilter,
    background: color,
    alpha: alphaMatch ? Number(alphaMatch[1]) : 1,
  };
`;
/** True when the surface blurs and stays see-through. */
const frosted = (state) =>
  Boolean(state) &&
  state.backdropFilter !== "none" &&
  state.alpha > 0 &&
  state.alpha < 1;
// The detail header must glow without moving its copy or actions.
const DETAIL_HERO_STATE = `const hero = document.querySelector("section.library-detail-hero, header.library-detail-hero"); const image = hero?.querySelector("img.detail-hero-backdrop"); const heroBox = hero?.getBoundingClientRect(); const copy = hero?.querySelector(".library-detail-copy")?.getBoundingClientRect(); const actions = hero?.querySelector(".library-detail-actions")?.getBoundingClientRect(); return { present: Boolean(image), classed: hero?.classList.contains("has-hero-backdrop") ?? null, alt: image?.getAttribute("alt") ?? null, hidden: image?.getAttribute("aria-hidden") ?? null, src: image?.getAttribute("src") ?? null, artistImages: document.querySelectorAll("img.artist-hero-backdrop, img.artist-hero-banner").length, insideHero: Boolean(heroBox && copy && actions) ? copy.right <= heroBox.right + 1 && actions.right <= heroBox.right + 1 : null, pageOverflowX: document.documentElement.scrollWidth - window.innerWidth };`;
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
    // Says whether a failing read caught the dialog closing again.
    className: dialog?.className ?? null,
    dialogs: document.querySelectorAll(".now-playing").length,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
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
  const gone = await waitFor(
    page,
    `!document.querySelector(".now-playing")`,
    3000,
  );
  if (!gone) return false;
  // The dialog unmounts for one render before `useDialogPresence` remounts it
  // for the exit animation, so a single absent poll is not enough.
  await sleep(CLOSE_SETTLE_MS);
  return page.evaluate(`return !document.querySelector(".now-playing");`);
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
  const hero = await page.evaluate(DETAIL_HERO_STATE);
  check(
    "album header blooms its artwork behind a right-side reading scrim",
    hero.present &&
      hero.classed === true &&
      hero.alt === "" &&
      hero.hidden === "true" &&
      hero.src?.includes("/64x64bb.jpg") === true &&
      hero.artistImages === 0 &&
      hero.insideHero === true &&
      hero.pageOverflowX <= 0,
    hero,
  );
  await moreToggle(page, check);
  await discs(page, check);
  await favorite(page, check);

  // Ctrl+click two rows to raise the multi-select bar, then Escape clears it.
  const selected = await page.evaluate(`
    const rows = [...document.querySelectorAll("button.library-track-row")].slice(0, 2);
    for (const row of rows) {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    }
    return rows.length;
  `);
  const barShown = await waitFor(
    page,
    `Boolean(document.querySelector(".selection-bar"))`,
    3000,
  );
  const barGlass = barShown
    ? await page.evaluate(GLASS_STATE(".selection-bar"))
    : null;
  await page.evaluate(
    `document.querySelector("button.library-track-row")?.focus(); return true;`,
  );
  await pressKey(page, "Escape");
  const barCleared = await waitFor(
    page,
    `!document.querySelector(".selection-bar")`,
    3000,
  );
  check(
    "the selection bar is a translucent frosted surface",
    selected === 2 && frosted(barGlass) && barCleared,
    { selected, barGlass, barCleared },
  );
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
  const menuGlass = await page.evaluate(GLASS_STATE(".context-menu"));
  check(
    "the context menu is a translucent frosted surface",
    frosted(menuGlass),
    menuGlass,
  );
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
  const playlistHero = await page.evaluate(DETAIL_HERO_STATE);
  check(
    "playlist header blooms its artwork behind a right-side reading scrim",
    playlistHero.present &&
      playlistHero.classed === true &&
      playlistHero.alt === "" &&
      playlistHero.hidden === "true" &&
      playlistHero.src?.includes("/64x64bb.jpg") === true &&
      playlistHero.artistImages === 0 &&
      playlistHero.insideHero === true &&
      playlistHero.pageOverflowX <= 0,
    playlistHero,
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

async function searchSuggestions(page, check) {
  await openRoute(
    page,
    "#/search",
    `Boolean(document.querySelector('.search-form input[role="combobox"]'))`,
    12_000,
  );
  const typed = await page.evaluate(
    `const input = document.querySelector('.search-form input[role="combobox"]'); if (!input) return false; input.focus(); input.select(); return true;`,
  );
  if (typed) await page.send("Input.insertText", { text: "polish" });
  const suggestion = await waitFor(
    page,
    `[...document.querySelectorAll(".search-suggestions li[role=option]")].some((node) => node.querySelector(".search-suggestion-art"))`,
    8000,
  );
  const rows = await page.evaluate(`
    return [...document.querySelectorAll(".search-suggestions li[role='option']")].map((node) => {
      const art = node.querySelector(".search-suggestion-art");
      const box = art?.getBoundingClientRect();
      return {
        label: node.querySelector(".search-suggestion-copy > span")?.textContent ?? null,
        detail: node.querySelector(".search-suggestion-copy > small")?.textContent ?? null,
        art: Boolean(art),
        alt: art?.querySelector("img")?.getAttribute("alt") ?? null,
        src: art?.querySelector("img")?.getAttribute("src") ?? null,
        size: box ? [Math.round(box.width), Math.round(box.height)] : null,
      };
    });
  `);
  const media = rows.find((row) => row.label === ALBUM.title);
  const terms = rows.filter((row) =>
    ["Polish Fixture", "Polka"].includes(row.label),
  );
  check(
    "media suggestions show a 32 px thumbnail and their kind; text completions do not",
    typed &&
      suggestion &&
      media?.art === true &&
      media.alt === "" &&
      media.src?.includes("/image/thumb/Music/e2e/album-polish/") === true &&
      /\/\d+x\d+bb\.jpg$/u.test(media.src ?? "") &&
      media.detail === `Album${DOT}Fixture Artist` &&
      JSON.stringify(media.size) === JSON.stringify([32, 32]) &&
      terms.length === 2 &&
      terms.every((row) => row.art === false),
    { rows, media, terms },
  );
  const suggestionsGlass = await page.evaluate(
    GLASS_STATE(".search-suggestions"),
  );
  check(
    "the search suggestion popup is a translucent frosted surface",
    frosted(suggestionsGlass),
    suggestionsGlass,
  );

  // Submit the term so it becomes a recent search, then reopen on empty text.
  await page.evaluate(
    `document.querySelector(".search-form")?.requestSubmit(); return true;`,
  );
  await waitFor(page, `location.hash.includes("q=polish")`, 4000);
  await page.evaluate(`
    const input = document.querySelector('.search-form input[role="combobox"]');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setValue.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    return true;
  `);
  const recentShown = await waitFor(
    page,
    `document.querySelectorAll(".search-suggestions li[role=option] .search-suggestion-remove").length > 0`,
    4000,
  );
  const recents = await page.evaluate(`
    return [...document.querySelectorAll(".search-suggestions li[role='option']")].map((node) => ({
      label: node.querySelector(".search-suggestion-copy > span")?.textContent ?? null,
      art: Boolean(node.querySelector(".search-suggestion-art")),
      removable: Boolean(node.querySelector(".search-suggestion-remove")),
    }));
  `);
  check(
    "recent searches stay text-only with no thumbnail",
    recentShown &&
      recents.length > 0 &&
      recents.every((row) => row.art === false && row.removable),
    recents,
  );
  await pressKey(page, "Escape");
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

async function captureBloomMatrix(page, check, artifactDir) {
  const originalTheme = await page.evaluate(
    `return document.documentElement.getAttribute("data-theme");`,
  );
  const iconUrl = await page.evaluate(
    `return document.querySelector("img.brand-mark")?.src ?? null;`,
  );
  const screenshotFiles = [];
  const results = [];
  if (iconUrl) {
    await fixtureCall(page, "configure", [
      { artworkTemplate: `${iconUrl}?bloom={id}` },
    ]);
  }

  try {
    await page.evaluate(`
      document.querySelectorAll(".action-toast").forEach((toast) => toast.remove());
      const style = document.createElement("style");
      style.id = "arlet-e2e-bloom-freeze";
      style.textContent = ".arlet-e2e-bloom-freeze .now-playing { animation: none !important; transition: none !important; } .arlet-e2e-bloom-freeze .now-playing-backdrop, .arlet-e2e-bloom-freeze .now-playing-artwork-bloom { animation-delay: -4.5s !important; animation-play-state: paused !important; }";
      document.head.append(style);
      document.documentElement.classList.add("arlet-e2e-bloom-freeze");
      document.activeElement?.blur();
      return true;
    `);

    for (const fixture of BLOOM_FIXTURES) {
      await fixtureCall(page, "setCurrentTrack", [fixture.id]);
      const titleReady = await waitFor(
        page,
        `document.querySelector(".now-playing h2")?.textContent === ${q(fixture.label === "missing" ? "Track Without Artwork" : `Bloom ${fixture.label[0].toUpperCase()}${fixture.label.slice(1)}`)}`,
        4000,
      );
      const queueIds = [
        fixture.id,
        ...BLOOM_QUEUE_IDS.filter((id) => id !== fixture.id),
      ];
      await page.evaluate(`
        await window.MusicKit.getInstance().setQueue({ songs: ${q(queueIds)} });
        return true;
      `);
      const queueReady = await waitFor(
        page,
        `document.querySelectorAll(".now-playing-queue button").length === ${Math.max(0, queueIds.length - 1)}`,
        4000,
      );

      for (const theme of BLOOM_THEMES) {
        await page.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }],
        });
        await page.evaluate(
          `document.documentElement.dataset.theme = ${q(theme)}; return true;`,
        );

        for (const viewport of BLOOM_VIEWPORTS) {
          await page.send("Emulation.setDeviceMetricsOverride", {
            width: viewport.width,
            height: viewport.height,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await sleep(120);
          const imageUrl = fixture.colors ? BLOOM_SVG(fixture.colors) : null;
          if (imageUrl) {
            await page.evaluate(`
              const src = ${q(imageUrl)};
              for (const selector of [
                "img.now-playing-backdrop",
                "img.now-playing-artwork-bloom",
                ".now-playing-artwork-stage .artwork img",
              ]) {
                const image = document.querySelector(selector);
                if (image) image.src = src;
              }
              return true;
            `);
          }
          const imagesReady = fixture.colors
            ? await waitFor(
                page,
                `[...document.querySelectorAll(".now-playing-backdrop, .now-playing-artwork-bloom, .now-playing-artwork-stage .artwork img")].every((image) => image.complete && image.naturalWidth > 0)`,
                4000,
              )
            : true;
          const state = await page.evaluate(`
            const dialog = document.querySelector(".now-playing");
            const stage = document.querySelector(".now-playing-artwork-stage");
            const backdrop = document.querySelector(".now-playing-backdrop");
            const halo = document.querySelector(".now-playing-artwork-bloom");
            const box = (node) => {
              if (!node) return null;
              const rect = node.getBoundingClientRect();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            };
            const hit = (selector) => {
              const target = document.querySelector(selector);
              if (!target) return { present: false, visible: false, reachable: false };
              const rect = target.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;
              const point = x >= 0 && x < innerWidth && y >= 0 && y < innerHeight
                ? document.elementFromPoint(x, y)
                : null;
              return {
                present: true,
                visible: rect.width > 0 && rect.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
                reachable: Boolean(point && (point === target || target.contains(point))),
              };
            };
            const after = getComputedStyle(dialog, "::after");
            const before = getComputedStyle(dialog, "::before");
            const z = (node) => node ? Number(getComputedStyle(node).zIndex) : null;
            const layering = backdrop && halo
              ? z(backdrop) < z(halo) && z(halo) < Number(after.zIndex) && Number(after.zIndex) < Number(before.zIndex) && getComputedStyle(stage).isolation === "auto"
              : !backdrop && !halo && !dialog.classList.contains("has-artwork-bloom");
            const pageOverflowX = Math.max(
              0,
              document.documentElement.scrollWidth - innerWidth,
            );
            const body = document.querySelector(".now-playing-body");
            const bodyOverflowX = Math.max(
              0,
              body.scrollWidth - body.clientWidth,
            );
            return {
              viewport: [innerWidth, innerHeight],
              title: document.querySelector(".now-playing h2")?.textContent ?? null,
              artwork: box(document.querySelector(".now-playing-artwork-stage .artwork")),
              titleBox: box(document.querySelector(".now-playing h2")),
              controlsBox: box(document.querySelector(".now-playing-controls")),
              queueBox: box(document.querySelector(".now-playing-side")),
              queueRows: document.querySelectorAll(".now-playing-queue button").length,
              overflowX: Math.max(pageOverflowX, bodyOverflowX),
              clippedBloomWidth: Math.max(0, dialog.scrollWidth - dialog.clientWidth),
              dialogOverflowX: getComputedStyle(dialog).overflowX,
              bodyOverflowX,
              layering,
              layers: {
                stageIsolation: getComputedStyle(stage).isolation,
                backdropZ: z(backdrop),
                haloZ: z(halo),
                scrimZ: after.zIndex,
                noiseZ: before.zIndex,
                backdropOpacity: backdrop ? getComputedStyle(backdrop).opacity : null,
                haloOpacity: halo ? getComputedStyle(halo).opacity : null,
                backdropFilter: backdrop ? getComputedStyle(backdrop).filter : null,
                haloFilter: halo ? getComputedStyle(halo).filter : null,
                backdropAnimation: backdrop ? getComputedStyle(backdrop).animationPlayState : null,
                haloAnimation: halo ? getComputedStyle(halo).animationPlayState : null,
                scrim: after.backgroundImage,
                noise: before.backgroundImage,
              },
              hits: {
                artwork: hit(".now-playing-artwork-stage .artwork"),
                title: hit(".now-playing h2"),
                play: hit(".now-playing .play-button"),
                favorite: hit('.now-playing button[aria-label="Favorite"]'),
                volume: hit('.now-playing input[aria-label="Volume"]'),
                queue: hit(".now-playing-queue button"),
                station: hit(".now-playing-header .secondary-button"),
                fullscreen: hit('.now-playing-header button[aria-label$="full screen"]'),
                close: hit('.now-playing-header button[aria-label="Close Now Playing"]'),
              },
            };
          `);
          const name = `now-playing-bloom-${fixture.label}-${theme}-${viewport.label}.png`;
          screenshotFiles.push(name);
          if (artifactDir) {
            const screenshot = await page.send("Page.captureScreenshot", {
              format: "png",
            });
            fs.writeFileSync(
              path.join(artifactDir, name),
              Buffer.from(screenshot.data, "base64"),
            );
          }
          results.push({
            fixture: fixture.label,
            theme,
            viewport: viewport.label,
            screenshot: name,
            titleReady,
            queueReady,
            imagesReady,
            ...state,
          });
        }
      }
    }

    const expectedCount =
      BLOOM_FIXTURES.length * BLOOM_THEMES.length * BLOOM_VIEWPORTS.length;
    const layersReady = results.every((result) => result.layering);
    const foregroundReady = results.every(
      (result) =>
        result.titleReady &&
        result.queueReady &&
        result.imagesReady &&
        result.overflowX === 0 &&
        result.dialogOverflowX === "hidden" &&
        Object.values(result.hits).every(
          (hit) => hit.present && hit.visible && hit.reachable,
        ),
    );
    check(
      "Now Playing bloom capture covers artwork variants, themes and widths",
      results.length === expectedCount &&
        screenshotFiles.length === expectedCount,
      { expectedCount, screenshotFiles },
    );
    check(
      "both bloom layers sit under the shared scrim with foreground content above",
      layersReady,
      results.map(({ fixture, theme, viewport, layering, layers }) => ({
        fixture,
        theme,
        viewport,
        layering,
        layers,
      })),
    );
    check(
      "Now Playing has no horizontal overflow and its controls and queue stay reachable",
      foregroundReady,
      results.map(
        ({
          fixture,
          theme,
          viewport,
          overflowX,
          clippedBloomWidth,
          dialogOverflowX,
          bodyOverflowX,
          queueRows,
          hits,
        }) => ({
          fixture,
          theme,
          viewport,
          overflowX,
          clippedBloomWidth,
          dialogOverflowX,
          bodyOverflowX,
          queueRows,
          hits,
        }),
      ),
    );

    if (artifactDir) {
      fs.writeFileSync(
        path.join(artifactDir, "now-playing-bloom-results.json"),
        `${JSON.stringify(
          {
            screenshots: screenshotFiles,
            fixtures: BLOOM_FIXTURES.map(({ label, id, colors }) => ({
              label,
              id,
              colors: colors ?? null,
            })),
            themes: BLOOM_THEMES,
            viewports: BLOOM_VIEWPORTS,
            animations:
              "Frozen at -4.5s for both bloom images before each capture.",
            results,
          },
          null,
          2,
        )}\n`,
      );
    }
  } finally {
    await page.evaluate(`
      document.documentElement.classList.remove("arlet-e2e-bloom-freeze");
      document.getElementById("arlet-e2e-bloom-freeze")?.remove();
      if (${q(originalTheme)} === null) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = ${q(originalTheme)};
      return true;
    `);
    await page.send("Emulation.clearDeviceMetricsOverride", {});
    await page.send("Emulation.setEmulatedMedia", { features: [] });
  }

  await fixtureCall(page, "setCurrentTrack", [BLOOM_FIXTURES[0].id]);
  await waitFor(
    page,
    `document.querySelector(".now-playing h2")?.textContent === "Bloom Blue"`,
    4000,
  );
  await page.send("Emulation.setEmulatedMedia", {
    features: [{ name: "forced-colors", value: "active" }],
  });
  const forcedColors = await page.evaluate(`
    const dialog = document.querySelector(".now-playing");
    const backdrop = document.querySelector(".now-playing-backdrop");
    const halo = document.querySelector(".now-playing-artwork-bloom");
    return {
      backdropDisplay: backdrop ? getComputedStyle(backdrop).display : null,
      haloDisplay: halo ? getComputedStyle(halo).display : null,
      scrimDisplay: getComputedStyle(dialog, "::after").display,
      noiseDisplay: getComputedStyle(dialog, "::before").display,
      text: document.querySelector(".now-playing h2")?.textContent ?? null,
    };
  `);
  check(
    "forced colors hides the bloom decorations and keeps the track visible",
    forcedColors.backdropDisplay === "none" &&
      forcedColors.haloDisplay === "none" &&
      forcedColors.scrimDisplay === "none" &&
      forcedColors.noiseDisplay === "none" &&
      forcedColors.text !== null,
    forcedColors,
  );
  await page.send("Emulation.setEmulatedMedia", { features: [] });
  await fixtureCall(page, "setCurrentTrack", [ALBUM.tracks[0]]);
  await waitFor(
    page,
    `document.querySelector(".now-playing h2")?.textContent === "Polish Disc One Track One"`,
    4000,
  );
}

async function nowPlaying(page, check, artifactDir) {
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

  const bloom = await page.evaluate(BLOOM_STATE);
  check(
    "Now Playing renders its artwork backdrop and cover bloom",
    bloom.classed === true &&
      bloom.backdrop === true &&
      bloom.halo === true &&
      bloom.backdropAlt === "" &&
      bloom.backdropHidden === "true" &&
      bloom.backdropUrl === bloom.haloUrl &&
      bloom.backdropUrl?.includes("/64x64bb.jpg") === true,
    bloom,
  );
  // Pausing playback pauses the ambient drift; resuming restarts it.
  await page.evaluate(
    `document.querySelector(".now-playing .play-button")?.click(); return true;`,
  );
  const paused = await waitFor(
    page,
    `!document.querySelector(".now-playing.is-playing")`,
    4000,
  );
  const pausedBloom = await page.evaluate(BLOOM_STATE);
  check(
    "pausing playback holds the bloom still",
    paused &&
      pausedBloom.backdropPlayState === "paused" &&
      pausedBloom.haloPlayState === "paused",
    pausedBloom,
  );
  await page.evaluate(
    `document.querySelector(".now-playing .play-button")?.click(); return true;`,
  );
  const resumed = await waitFor(
    page,
    `document.querySelector(".now-playing.is-playing")`,
    4000,
  );
  const resumedBloom = await page.evaluate(BLOOM_STATE);
  check(
    "resuming playback runs the bloom again",
    resumed &&
      resumedBloom.backdropPlayState === "running" &&
      resumedBloom.haloPlayState === "running",
    resumedBloom,
  );

  await captureBloomMatrix(page, check, artifactDir);

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

  await fixtureCall(page, "setCurrentTrack", ["song-no-art"]);
  const bareTitle = await waitFor(
    page,
    `document.querySelector(".now-playing h2")?.textContent === "Track Without Artwork"`,
    4000,
  );
  const bloomGone = await waitFor(
    page,
    `!document.querySelector("img.now-playing-backdrop") && !document.querySelector("img.now-playing-artwork-bloom") && document.querySelector(".now-playing")?.classList.contains("has-artwork-bloom") === false`,
    4000,
  );
  const stripped = await page.evaluate(
    `return {
      backdrop: Boolean(document.querySelector("img.now-playing-backdrop")),
      halo: Boolean(document.querySelector("img.now-playing-artwork-bloom")),
      className: document.querySelector(".now-playing")?.className ?? null,
      images: [...document.querySelectorAll(".now-playing img")].map((node) => node.getAttribute("src")),
    };`,
  );
  check(
    "a track without artwork renders no bloom images",
    bareTitle && bloomGone,
    stripped,
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
  // Put artwork back on the current track so the bloom layers exist to check.
  await fixtureCall(page, "setCurrentTrack", [ALBUM.tracks[2]]);
  try {
    const reduced = await page.evaluate(OPEN_NOW_PLAYING);
    check(
      "reduced motion: opening Now Playing runs no transform animation",
      reduced.opened && !reduced.animations.some((item) => item.transform),
      reduced,
    );
    const reducedBloom = await page.evaluate(
      `return [...document.querySelectorAll(".now-playing-backdrop, .now-playing-artwork-bloom")].map((node) => getComputedStyle(node).animationName);`,
    );
    check(
      "reduced motion: the artwork bloom runs no animation",
      reducedBloom.length === 2 &&
        reducedBloom.every((name) => name === "none"),
      { reducedBloom },
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
  // The focus effect runs after the drawer's first paint, so poll for it.
  const focusMoved = await waitFor(
    page,
    `document.activeElement?.tagName === "H2" && Boolean(document.activeElement?.closest("aside.queue-drawer"))`,
    2000,
  );
  // The extra fields say what blocked the drawer when this check fails.
  const focus = await page.evaluate(
    `const node = document.activeElement; return { tag: node?.tagName ?? null, text: node?.textContent.trim() ?? null, label: node?.getAttribute("aria-label") ?? null, inDrawer: Boolean(node?.closest("aside.queue-drawer")), drawerState: document.querySelector("aside.queue-drawer")?.dataset.state ?? null, blockers: [...document.querySelectorAll('[role="dialog"], [role="menu"], dialog[open], .now-playing')].map((item) => item.className || item.tagName) };`,
  );
  check(
    "opening Playing Next moves focus to its heading",
    open &&
      focusMoved &&
      focus.tag === "H2" &&
      focus.text === "Playing Next" &&
      focus.inDrawer,
    { ...focus, open: Boolean(open) },
  );
  const drawerGlass = await page.evaluate(GLASS_STATE(".queue-drawer"));
  check(
    "the queue drawer is a translucent frosted surface",
    frosted(drawerGlass),
    drawerGlass,
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
  const afterEscape = gone
    ? undefined
    : await page.evaluate(
        `return { drawerState: document.querySelector("aside.queue-drawer")?.dataset.state ?? null, label: document.activeElement?.getAttribute("aria-label") ?? null, blockers: [...document.querySelectorAll('[role="dialog"], [role="menu"], dialog[open], .now-playing')].map((item) => item.className || item.tagName) };`,
      );
  check(
    "Escape closes Playing Next and returns focus to its toggle",
    focusBack && gone,
    { focusBack, gone, afterEscape },
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
    const toastGlass = await page.evaluate(GLASS_STATE(".action-toast"));
    check(
      "the action toast is a translucent frosted surface",
      frosted(toastGlass),
      toastGlass,
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

async function aboutLinks(page, check, artifactDir) {
  await openRoute(
    page,
    "#/settings",
    `document.querySelector('.settings-section[aria-labelledby="about-heading"] button[aria-controls="about-details"]') && document.querySelector('.settings-section[aria-labelledby="advanced-heading"] button[aria-controls="advanced-details"]')`,
    12_000,
  );
  const originalTheme = await page.evaluate(
    `return document.querySelector('.settings-section[aria-labelledby="appearance-heading"] select')?.value ?? "system";`,
  );
  const saveScreenshot = async (name, headingId) => {
    const selector = `.settings-section[aria-labelledby="${headingId}"]`;
    const scrolled = await page.evaluate(`
      const section = document.querySelector(${q(selector)});
      section?.scrollIntoView({ block: "start" });
      return Boolean(section);`);
    const visibilityExpression = `(() => {
        const section = document.querySelector(${q(selector)});
        const scroller = document.querySelector(".content-scroll");
        if (!section || !scroller) return false;
        const sectionBox = section.getBoundingClientRect();
        const viewport = scroller.getBoundingClientRect();
        return sectionBox.left >= viewport.left - 1 &&
          sectionBox.right <= viewport.right + 1 &&
          sectionBox.top >= viewport.top - 1 &&
          sectionBox.bottom <= viewport.bottom + 1;
      })()`;
    const visible = await waitFor(page, visibilityExpression, 3000);
    const transitionsSettled = await waitFor(
      page,
      `(() => {
        const section = document.querySelector(${q(selector)});
        const scroller = document.querySelector(".content-scroll");
        const sidebar = document.querySelector(".sidebar");
        const compactDrawerClosed = window.innerWidth > 720 || (
          sidebar &&
          !sidebar.classList.contains("is-open") &&
          !document.querySelector(".sidebar-scrim") &&
          sidebar.getBoundingClientRect().right <= 1
        );
        const animations = [
          ...(section?.getAnimations({ subtree: true }) ?? []),
          ...(scroller?.getAnimations() ?? []),
          ...(sidebar?.getAnimations() ?? []),
        ];
        return compactDrawerClosed && [...animations].every((animation) => animation.playState !== "running");
      })()`,
      3000,
    );
    await sleep(250);
    await page.evaluate(
      `return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));`,
    );
    const visibleAfterSettling = await waitFor(
      page,
      visibilityExpression,
      1000,
    );
    check(
      `screenshot ${name} shows a settled ${headingId} section`,
      scrolled && visible && transitionsSettled && visibleAfterSettling,
      { scrolled, visible, transitionsSettled, visibleAfterSettling },
    );
    const screenshot = await page.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    fs.writeFileSync(
      path.join(artifactDir, name),
      Buffer.from(screenshot.data, "base64"),
    );
  };
  const setTheme = async (theme) => {
    const changed = await page.evaluate(`
      const select = document.querySelector('.settings-section[aria-labelledby="appearance-heading"] select');
      if (!select) return false;
      select.value = ${q(theme)};
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;`);
    if (!changed) return false;
    return waitFor(
      page,
      `document.documentElement.dataset.theme === ${q(theme)}`,
      5000,
    );
  };
  const settleSettingsViewport = async (width) => {
    const viewportReady = await waitFor(
      page,
      `window.innerWidth === ${width} && document.querySelector(".sidebar")`,
      3000,
    );
    const drawerCloseRequested = await page.evaluate(`
      const sidebar = document.querySelector(".sidebar");
      if (sidebar?.classList.contains("is-open")) {
        const scrim = document.querySelector(".sidebar-scrim");
        if (!scrim) return false;
        scrim.click();
      }
      return Boolean(sidebar);`);
    const expression = `(() => {
      const sidebar = document.querySelector(".sidebar");
      return window.innerWidth === ${width} &&
        sidebar &&
        !sidebar.classList.contains("is-open") &&
        !document.querySelector(".sidebar-scrim") &&
        (${width} > 720 || sidebar.getBoundingClientRect().right <= 1) &&
        [...sidebar.getAnimations()].every((animation) => animation.playState !== "running");
    })()`;
    const settled = await waitFor(page, expression, 3000);
    await sleep(250);
    await page.evaluate(
      `return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));`,
    );
    const stillSettled = await waitFor(page, expression, 1000);
    return viewportReady && drawerCloseRequested && settled && stillSettled;
  };
  const aboutToggle = `document.querySelector('.settings-section[aria-labelledby="about-heading"] button[aria-controls="about-details"]')`;
  const advancedToggle = `document.querySelector('.settings-section[aria-labelledby="advanced-heading"] button[aria-controls="advanced-details"]')`;
  try {
    await waitFor(
      page,
      `(() => { const version = [...document.querySelectorAll('.settings-section[aria-labelledby="about-heading"] .settings-field')].find((node) => node.querySelector("span")?.textContent.trim() === "Arlet version"); return Boolean(version) && !version.querySelector("strong")?.textContent.includes("Loading"); })()`,
      8000,
    );
    const initial = await page.evaluate(`
      const about = ${aboutToggle};
      const advanced = ${advancedToggle};
      const section = (id) => document.querySelector('.settings-section[aria-labelledby="' + id + '"]');
      const valueFor = (id, label) => [...section(id).querySelectorAll(".settings-field")].find((node) => node.querySelector("span")?.textContent.trim() === label)?.querySelector("strong")?.textContent.trim() ?? null;
      const hiddenStops = (id, selector) => {
        const panel = document.getElementById(id);
        return !panel || panel.hidden || [...panel.querySelectorAll(selector)].every((node) => node.disabled || node.getClientRects().length === 0);
      };
      return {
        aboutExpanded: about?.getAttribute("aria-expanded"),
        aboutControls: about?.getAttribute("aria-controls"),
        advancedExpanded: advanced?.getAttribute("aria-expanded"),
        advancedControls: advanced?.getAttribute("aria-controls"),
        version: valueFor("about-heading", "Arlet version"),
        channel: valueFor("about-heading", "Update channel in use"),
        aboutHidden: hiddenStops("about-details", "button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])"),
        advancedHidden: hiddenStops("advanced-details", "button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])"),
      };`);
    const validVersion = Boolean(
      initial.version && !["Loading…", "Unknown"].includes(initial.version),
    );
    check(
      "About shows installed version and active channel while both disclosures start collapsed",
      validVersion &&
        Boolean(initial.channel) &&
        initial.aboutExpanded === "false" &&
        initial.aboutControls === "about-details" &&
        initial.advancedExpanded === "false" &&
        initial.advancedControls === "advanced-details" &&
        initial.aboutHidden &&
        initial.advancedHidden,
      initial,
    );

    const lightTheme = await setTheme("light");
    await saveScreenshot("settings-about-collapsed-light.png", "about-heading");
    await saveScreenshot(
      "settings-advanced-collapsed-light.png",
      "advanced-heading",
    );
    // A real button must open by keyboard. About uses Enter; Advanced uses Space.
    await page.evaluate(
      `document.querySelector('.settings-section[aria-labelledby="about-heading"]')?.scrollIntoView({ block: "start" }); return true;`,
    );
    await page.evaluate(`${aboutToggle}?.focus(); return true;`);
    await pressKey(page, "Enter", { text: "\r" });
    const aboutOpened = await waitFor(
      page,
      `${aboutToggle}?.getAttribute("aria-expanded") === "true" && document.getElementById("about-details")`,
      3000,
    );
    const aboutDetails = await page.evaluate(`
      const panel = document.getElementById("about-details");
      const buttons = [...(panel?.querySelectorAll("button.about-link") ?? [])];
      const value = (label) => buttons.find((button) => button.querySelector("span")?.textContent.trim() === label)?.querySelector("strong")?.textContent.trim() ?? null;
      const version = [...document.querySelectorAll('.settings-section[aria-labelledby="about-heading"] .settings-field')].find((node) => node.querySelector("span")?.textContent.trim() === "Arlet version")?.querySelector("strong")?.textContent.trim();
      return {
        visible: Boolean(panel) && !panel.hidden,
        runtime: Boolean([...panel.querySelectorAll(".settings-field")].find((node) => node.querySelector("span")?.textContent.trim() === "WebView2 runtime")),
        labels: buttons.map((button) => button.querySelector("span")?.textContent.trim() ?? null),
        project: value("Project page"),
        releaseNotes: value("Release notes"),
        license: value("License"),
        releaseDisabled: buttons.find((button) => button.querySelector("span")?.textContent.trim() === "Release notes")?.disabled ?? null,
        anchors: panel.querySelectorAll("a[href]").length,
        buttonTypes: buttons.map((button) => button.getAttribute("type")),
        buttonTargets: buttons.map((button) => button.hasAttribute("target")),
        version,
      };`);
    // Not clicked: native link buttons run ShellExecuteW on the tester's machine.
    // Only their rendered labels and button semantics are checked.
    const expectedRelease = validVersion
      ? `Version ${aboutDetails.version}`
      : undefined;
    const releaseAvailable = validVersion
      ? aboutDetails.releaseDisabled === false &&
        aboutDetails.releaseNotes === expectedRelease
      : aboutDetails.releaseDisabled === true &&
        ["Loading…", "Unavailable"].includes(aboutDetails.releaseNotes);
    check(
      "About reveals the runtime and friendly native link buttons without exposing URLs",
      aboutOpened &&
        aboutDetails.visible &&
        aboutDetails.runtime &&
        JSON.stringify(aboutDetails.labels) ===
          JSON.stringify(["Project page", "Release notes", "License"]) &&
        aboutDetails.project === "BurntToasters/Arlet" &&
        releaseAvailable &&
        aboutDetails.license === "GPL-3.0 license" &&
        aboutDetails.anchors === 0 &&
        aboutDetails.buttonTypes.every((type) => type === "button") &&
        aboutDetails.buttonTargets.every((hasTarget) => !hasTarget),
      aboutDetails,
    );
    await saveScreenshot("settings-about-expanded-light.png", "about-heading");

    await page.evaluate(`${advancedToggle}?.focus(); return true;`);
    await pressKey(page, " ", { text: " " });
    const advancedOpened = await waitFor(
      page,
      `${advancedToggle}?.getAttribute("aria-expanded") === "true" && document.getElementById("advanced-details")`,
      3000,
    );
    const bothExpanded = await page.evaluate(`
      const about = ${aboutToggle};
      const advanced = ${advancedToggle};
      const panel = document.getElementById("advanced-details");
      return {
        about: about?.getAttribute("aria-expanded"),
        advanced: advanced?.getAttribute("aria-expanded"),
        debug: Boolean(panel?.querySelector('label.settings-toggle-field input[type="checkbox"]')),
        reset: Boolean([...panel.querySelectorAll("button")].find((button) => button.textContent.trim() === "Reset settings…")),
        positionAfterSupport: sectionOrder(),
      };
      function sectionOrder() {
        const headings = [...document.querySelectorAll(".settings-layout > .settings-section > .settings-section-heading h2")].map((node) => node.textContent.trim());
        return headings.indexOf("Advanced") > headings.indexOf("Support");
      }`);
    check(
      "About and Advanced disclosures toggle independently by keyboard",
      lightTheme &&
        advancedOpened &&
        bothExpanded.about === "true" &&
        bothExpanded.advanced === "true" &&
        bothExpanded.debug &&
        bothExpanded.reset &&
        bothExpanded.positionAfterSupport,
      { lightTheme, advancedOpened, bothExpanded },
    );
    await saveScreenshot(
      "settings-advanced-expanded-light.png",
      "advanced-heading",
    );

    await page.evaluate(`${aboutToggle}?.click(); return true;`);
    const aboutCollapsedIndependently = await waitFor(
      page,
      `${aboutToggle}?.getAttribute("aria-expanded") === "false" && ${advancedToggle}?.getAttribute("aria-expanded") === "true"`,
      3000,
    );
    const aboutHiddenStops = await page.evaluate(`
      const panel = document.getElementById("about-details");
      const stops = [...(panel?.querySelectorAll("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])") ?? [])];
      return !panel || panel.hidden || stops.every((node) => node.disabled || node.getClientRects().length === 0);`);
    await page.evaluate(`${advancedToggle}?.click(); return true;`);
    const advancedCollapsed = await waitFor(
      page,
      `${advancedToggle}?.getAttribute("aria-expanded") === "false"`,
      3000,
    );
    const advancedHiddenStops = await page.evaluate(`
      const panel = document.getElementById("advanced-details");
      const stops = [...(panel?.querySelectorAll("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])") ?? [])];
      return !panel || panel.hidden || stops.every((node) => node.disabled || node.getClientRects().length === 0);`);
    check(
      "collapsed About and Advanced contents leave no visible tab stops",
      aboutCollapsedIndependently &&
        aboutHiddenStops &&
        advancedCollapsed &&
        advancedHiddenStops,
      {
        aboutCollapsedIndependently,
        aboutHiddenStops,
        advancedCollapsed,
        advancedHiddenStops,
      },
    );

    await page.evaluate(
      `${aboutToggle}?.click(); ${advancedToggle}?.click(); return true;`,
    );
    const expandedBeforeRemount = await waitFor(
      page,
      `${aboutToggle}?.getAttribute("aria-expanded") === "true" && ${advancedToggle}?.getAttribute("aria-expanded") === "true"`,
      3000,
    );
    await page.evaluate(`location.hash = "#/home"; return true;`);
    const settingsUnmounted = await waitFor(
      page,
      `!document.querySelector('.settings-section[aria-labelledby="about-heading"]') && !document.querySelector('.settings-section[aria-labelledby="advanced-heading"]')`,
      5000,
    );
    await openRoute(
      page,
      "#/settings",
      `${aboutToggle} && ${advancedToggle}`,
      8000,
    );
    const remountCollapsed = await page.evaluate(`
      return ${aboutToggle}?.getAttribute("aria-expanded") === "false" && ${advancedToggle}?.getAttribute("aria-expanded") === "false";`);
    check(
      "both disclosures reset to collapsed after Settings remounts",
      expandedBeforeRemount && settingsUnmounted && remountCollapsed,
      { expandedBeforeRemount, settingsUnmounted, remountCollapsed },
    );

    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 360,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.evaluate(
      `${aboutToggle}?.click(); ${advancedToggle}?.click(); return true;`,
    );
    const narrowLayout = await waitFor(
      page,
      `${aboutToggle}?.getAttribute("aria-expanded") === "true" && ${advancedToggle}?.getAttribute("aria-expanded") === "true"`,
      3000,
    );
    const narrowViewportSettled = await settleSettingsViewport(360);
    const narrowGeometry = await page.evaluate(`
      const sections = [
        document.querySelector('.settings-section[aria-labelledby="about-heading"]'),
        document.querySelector('.settings-section[aria-labelledby="advanced-heading"]'),
      ].filter(Boolean);
      const scroller = document.querySelector(".content-scroll");
      const rows = sections.flatMap((section) => [...section.querySelectorAll(".settings-field")]);
      const buttons = sections.flatMap((section) => [...section.querySelectorAll("button")]);
      return {
        viewport: window.innerWidth,
        contained: Boolean(scroller) && sections.every((node) => {
          const box = node.getBoundingClientRect();
          const viewport = scroller.getBoundingClientRect();
          return box.left >= viewport.left - 1 && box.right <= viewport.right + 1;
        }),
        cardsFit: sections.every((node) => node.scrollWidth <= node.clientWidth + 2),
        rowsFit: rows.every((node) => node.scrollWidth <= node.clientWidth + 2),
        buttonsFit: buttons.every((node) => node.scrollWidth <= node.clientWidth + 2),
        scrollerBounds: scroller ? (() => {
          const box = scroller.getBoundingClientRect();
          return { left: box.left, right: box.right, width: box.width };
        })() : null,
        sectionBounds: sections.map((node) => {
          const box = node.getBoundingClientRect();
          return {
            heading: node.getAttribute("aria-labelledby"),
            left: box.left,
            right: box.right,
            width: box.width,
          };
        }),
        sidebarBounds: document.querySelector(".sidebar") ? (() => {
          const box = document.querySelector(".sidebar").getBoundingClientRect();
          return { left: box.left, right: box.right, width: box.width };
        })() : null,
        sidebarOpen: document.querySelector(".sidebar")?.classList.contains("is-open") ?? null,
        sidebarScrim: Boolean(document.querySelector(".sidebar-scrim")),
      };`);
    check(
      "About and Advanced wrap within a narrow 360 px layout",
      narrowLayout &&
        narrowViewportSettled &&
        narrowGeometry.contained &&
        narrowGeometry.cardsFit &&
        narrowGeometry.rowsFit &&
        narrowGeometry.buttonsFit,
      { narrowLayout, narrowViewportSettled, narrowGeometry },
    );
    await saveScreenshot(
      "settings-about-expanded-narrow-light.png",
      "about-heading",
    );
    await saveScreenshot(
      "settings-advanced-expanded-narrow-light.png",
      "advanced-heading",
    );

    const darkTheme = await setTheme("dark");
    check(
      "Settings disclosures render with the dark theme",
      darkTheme &&
        (await page.evaluate(
          `return document.documentElement.dataset.theme === "dark";`,
        )),
    );
    await saveScreenshot(
      "settings-about-expanded-narrow-dark.png",
      "about-heading",
    );
    await saveScreenshot(
      "settings-advanced-expanded-narrow-dark.png",
      "advanced-heading",
    );
    await page.send("Emulation.clearDeviceMetricsOverride", {});
    await saveScreenshot("settings-about-expanded-dark.png", "about-heading");
    await saveScreenshot(
      "settings-advanced-expanded-dark.png",
      "advanced-heading",
    );
  } finally {
    await page.send("Emulation.clearDeviceMetricsOverride", {});
    await page.evaluate(`
      const select = document.querySelector('.settings-section[aria-labelledby="appearance-heading"] select');
      if (select && select.value !== ${q(originalTheme)}) {
        select.value = ${q(originalTheme)};
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return true;`);
    await waitFor(
      page,
      `document.querySelector('.settings-section[aria-labelledby="appearance-heading"] select')?.value === ${q(originalTheme)}`,
      5000,
    );
  }
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
export async function runPolish({ page, check, artifactDir }) {
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
    await group(check, "search suggestions", () =>
      searchSuggestions(page, check),
    );
    await group(check, "search source tabs", () => searchTabs(page, check));
    await group(check, "now playing", () =>
      nowPlaying(page, check, artifactDir),
    );
    await group(check, "queue drawer", () => queueDrawer(page, check));
    await group(check, "rating error toast", () => errorToast(page, check));
    await group(check, "skeletons", () => skeletons(page, check));
    await group(check, "about and advanced settings", () =>
      aboutLinks(page, check, artifactDir),
    );
    await group(check, "compact shell", () => compactShell(page, check));
    await group(check, "fullscreen", () => fullscreen(page, check));
  } finally {
    await cleanup(page);
  }
}
