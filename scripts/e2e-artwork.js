/* Artwork sizing checks. Each check names the failure mode it guards in
 * docs/TESTING.md ("Artwork sizing"). Browser code runs as strings inside the
 * page, as in the other native scenarios. The artwork data is served only
 * after configure({ artworkGrid: true }), and its URLs load through the
 * data: SVG template below (scripts/e2e-music-fixture.js). */

import fs from "node:fs";
import path from "node:path";
import { fixtureCall, waitFor } from "./e2e-helpers.js";

const q = (value) => JSON.stringify(value);
const round = (value) => Math.round(value * 10) / 10;

// Titles the fixture serves for this scenario, and the two without artwork.
const LONG_TITLE =
  "An Extraordinarily Long Title That Keeps Going Well Past Any Card Width";
const FIXTURE_TITLES = [
  "Hi",
  "Second Album Title",
  LONG_TITLE,
  "X",
  "Quiet Sleeve",
  "Mix",
  "Playlist Of Medium Length",
  "Q",
  "Art Artist",
  "Al",
  "Quiet Artist",
  "FM",
  "Pop",
];
const BARE_TITLES = ["Quiet Sleeve", "Quiet Artist"];

// The app takes artwork only from http(s) URLs with no unfilled braces, so a
// data: image never reaches an <img>. The titlebar icon is an image the app
// already serves from its own origin (its CSP allows it), so the fixture points
// each artwork URL at that icon with the owning resource ID as a query string.
// The fixture fills {id}; the icon is read from the page before configure.
const artworkTemplate = (iconUrl) => `${iconUrl}?artwork={id}`;

// The views in the order they are visited. `min` is the fewest cards that
// must render; `extra` adds the checks that name one item.
const VIEWS = [
  { label: "home", hash: "#/home", min: 4 },
  {
    label: "library albums",
    hash: "#/library/albums",
    min: 5,
    extra: (cards, check) => {
      const bare = cards.find((card) => card.title === "Quiet Sleeve");
      check(
        "library albums: an album without art shows its initials",
        bare?.kind === "initials" && bare.initials === "QS",
        { card: bare ? compact(bare) : null },
      );
    },
  },
  { label: "library playlists", hash: "#/library/playlists", min: 4 },
  {
    label: "library artists",
    hash: "#/library/artists",
    min: 4,
    extra: (cards, check) => {
      const withArt = cards.find((card) => card.title === "Art Artist");
      check(
        "library artists: a catalog artist's image shows on its tile",
        withArt?.kind === "img" &&
          withArt.loaded === true &&
          String(withArt.src).includes("cat-artist-art-1"),
        { card: withArt ? compact(withArt) : null },
      );
      const bare = cards.find((card) => card.title === "Quiet Artist");
      const square =
        Boolean(bare?.art) &&
        Math.abs(bare.art.w - bare.art.h) <= 1 &&
        Math.abs(bare.art.w - bare.content) <= 1;
      check(
        "library artists: an artist without art shows a square icon",
        bare?.kind === "icon" && square,
        { card: bare ? compact(bare) : null },
      );
    },
  },
  { label: "library recently added", hash: "#/library/recent", min: 6 },
  { label: "radio", hash: "#/radio", min: 3 },
  { label: "search", hash: "#/search?q=artwork", min: 5 },
  {
    label: "artist page",
    hash: "#/artist/lib-artist-art-1",
    min: 3,
    ready: `document.querySelector(".library-detail-hero h1")?.textContent === "Art Artist"`,
    extra: async (cards, check, page) => {
      await waitFor(page, HERO_LOADED, 10_000);
      const hero = await page.evaluate(HERO);
      check(
        "artist page: the hero shows the catalog artist's image",
        hero.loaded === true && String(hero.src).includes("cat-artist-art-1"),
        hero,
      );
    },
  },
];

/**
 * Every `.card-shell` in the content area: its body (the open button, or the
 * static search tile), the body's artwork box, and the Play/More overlay.
 * Rows are keyed by parent and top edge, so one key is one grid row.
 */
const MEASURE = `
  const scroller = document.querySelector(".content-scroll");
  const box = (node) => {
    const r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const parents = new Map();
  const shells = [...document.querySelectorAll(".card-shell")].filter(
    (shell) => !scroller || scroller.contains(shell),
  );
  return shells.map((shell) => {
    const body = shell.firstElementChild;
    const style = getComputedStyle(body);
    const inset = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"]
      .reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0);
    const art = body.querySelector(':scope > .artwork, :scope > [class*="-art-icon"]');
    const img = art ? art.querySelector("img") : null;
    const kind = !art
      ? "none"
      : art.classList.contains("artwork")
        ? img ? "img" : "initials"
        : "icon";
    const overlay = shell.querySelector(":scope > .card-actions");
    if (!parents.has(shell.parentElement)) parents.set(shell.parentElement, parents.size);
    const shellBox = box(shell);
    return {
      title: body.querySelector("strong")?.textContent ?? "",
      kind,
      loaded: img ? img.complete && img.naturalWidth > 0 : null,
      src: img ? img.getAttribute("src") : null,
      initials: kind === "initials" ? art.querySelector("span")?.textContent?.trim() ?? "" : null,
      body: box(body).w,
      content: box(body).w - inset,
      art: art ? box(art) : null,
      overlay: overlay ? box(overlay) : null,
      featured: body.classList.contains("search-tile-featured") || body.classList.contains("artist-featured-card"),
      row: parents.get(shell.parentElement) + ":" + Math.round(shellBox.y),
    };
  });
`;

const HERO = `
  const img = document.querySelector(".artist-hero .library-detail-art img");
  const art = document.querySelector(".artist-hero .library-detail-art");
  const r = art ? art.getBoundingClientRect() : null;
  return {
    present: Boolean(img),
    loaded: Boolean(img && img.complete && img.naturalWidth > 0),
    src: img ? img.getAttribute("src") : null,
    artBox: r ? [Math.round(r.width), Math.round(r.height)] : null,
  };
`;

// Lazy images load near the viewport, so step through the content once.
const SCROLL_THROUGH = `
  const scroller = document.querySelector(".content-scroll");
  if (scroller) {
    const step = Math.max(200, scroller.clientHeight / 2);
    for (let y = 0; y <= scroller.scrollHeight; y += step) {
      scroller.scrollTop = y;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    scroller.scrollTop = 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return true;
`;

const HERO_LOADED = `Boolean(document.querySelector(".artist-hero .library-detail-art img")?.complete && document.querySelector(".artist-hero .library-detail-art img").naturalWidth > 0)`;
const LONG_TITLE_RENDERED = `[...document.querySelectorAll(".card-shell strong")].some((node) => node.textContent === ${q(LONG_TITLE)})`;
const IMAGES_LOADED = `[...document.querySelectorAll(".card-shell img")].every((img) => img.complete)`;

function boxOf(box) {
  return [round(box.x), round(box.y), round(box.w), round(box.h)];
}

function compact(card) {
  return {
    title: card.title,
    kind: card.kind,
    ...(card.loaded === null ? {} : { loaded: card.loaded }),
    ...(card.initials ? { initials: card.initials } : {}),
    body: round(card.body),
    content: round(card.content),
    art: card.art ? boxOf(card.art) : null,
    overlay: card.overlay ? boxOf(card.overlay) : null,
    featured: card.featured,
    row: card.row,
  };
}

function sameBox(a, b) {
  return (
    Math.abs(a.x - b.x) <= 1 &&
    Math.abs(a.y - b.y) <= 1 &&
    Math.abs(a.w - b.w) <= 1 &&
    Math.abs(a.h - b.h) <= 1
  );
}

// Bare items show a placeholder; every other fixture card shows its image.
function artworkOk(card) {
  if (BARE_TITLES.includes(card.title)) {
    return card.kind === "initials" || card.kind === "icon";
  }
  return card.kind === "img" && card.loaded === true;
}

function spread(values) {
  return Math.max(...values) - Math.min(...values);
}

async function runView(page, check, view, artifactDir) {
  const name = view.label;
  try {
    await page.evaluate(`location.hash = ${q(view.hash)}; return true;`);
    await waitFor(page, LONG_TITLE_RENDERED, 15_000);
    if (view.ready) await waitFor(page, view.ready, 15_000);
    await page.evaluate(SCROLL_THROUGH);
    await waitFor(page, IMAGES_LOADED, 5_000);
    const cards = await page.evaluate(MEASURE);
    const fixtureCards = cards.filter((card) =>
      FIXTURE_TITLES.includes(card.title),
    );
    const measured = cards.map(compact);
    const rendered = cards.length >= view.min;
    check(`${name}: its cards render`, rendered, {
      cards: cards.length,
      min: view.min,
      fixtureCards: fixtureCards.length,
      measured,
    });

    const screenshot = await page.send("Page.captureScreenshot", {
      format: "png",
    });
    if (artifactDir) {
      const slug = name.replace(/\s+/gu, "-");
      fs.writeFileSync(
        path.join(artifactDir, `artwork-${slug}.png`),
        Buffer.from(screenshot.data, "base64"),
      );
    }

    // A featured card (the search top result, an artist's newest release) is
    // not in the equal-width check; its overlay is still checked against its art.
    const plain = cards.filter((card) => !card.featured);
    const widthFails = plain.filter(
      (card) => !card.art || Math.abs(card.art.w - card.content) > 1,
    );
    check(
      `${name}: every card's artwork fills its card content width`,
      cards.length > 0 && widthFails.length === 0,
      {
        checked: plain.length,
        featuredExcluded: cards.length - plain.length,
        fails: widthFails.map(compact).slice(0, 12),
      },
    );

    const squareFails = cards.filter(
      (card) => !card.art || Math.abs(card.art.w - card.art.h) > 1,
    );
    check(
      `${name}: every card's artwork is square`,
      cards.length > 0 && squareFails.length === 0,
      {
        checked: cards.length,
        fails: squareFails.map(compact).slice(0, 12),
      },
    );

    const rowGroups = new Map();
    for (const card of plain) {
      rowGroups.set(card.row, [...(rowGroups.get(card.row) ?? []), card]);
    }
    const rowFails = [...rowGroups.entries()].filter(
      ([, group]) =>
        group.length > 1 && spread(group.map((card) => card.body)) > 1,
    );
    check(
      `${name}: cards in one grid row share a width`,
      cards.length > 0 && rowFails.length === 0,
      {
        rows: rowGroups.size,
        fails: rowFails.map(([row, group]) => ({
          row,
          widths: group.map((card) => [card.title, round(card.body)]),
        })),
      },
    );

    const withOverlay = cards.filter((card) => card.overlay);
    const overlayFails = withOverlay.filter(
      (card) => !card.art || !sameBox(card.overlay, card.art),
    );
    check(
      `${name}: each card's Play and More overlay sits over its artwork`,
      withOverlay.length > 0 && overlayFails.length === 0,
      {
        withOverlay: withOverlay.length,
        withoutOverlay: cards.length - withOverlay.length,
        fails: overlayFails.map(compact).slice(0, 12),
      },
    );

    const loadFails = fixtureCards.filter((card) => !artworkOk(card));
    check(
      `${name}: fixture artwork loads, and items without art show a placeholder`,
      fixtureCards.length > 0 && loadFails.length === 0,
      { fixtureCards: fixtureCards.length, fails: loadFails.map(compact) },
    );

    if (view.extra) await view.extra(cards, check, page);
  } catch (error) {
    check(
      `${name}: artwork checks complete`,
      false,
      String(error?.message ?? error),
    );
  }
}

// The discovery suite signs the fixture back in, but the app stays signed out
// until its own sign-in runs (a sign-in from elsewhere is left to the sign-in
// flow). So this suite signs in through Settings, as the other suites do.
const AUTH_BUTTON = `[...document.querySelectorAll("button")].find((node) => ["Sign in", "Sign out"].includes(node.textContent.trim()))`;

async function ensureSignedIn(page, check) {
  await page.evaluate(`location.hash = "#/settings"; return true;`);
  await waitFor(page, `Boolean(${AUTH_BUTTON})`, 10_000);
  const before = await page.evaluate(
    `return ${AUTH_BUTTON}?.textContent.trim() ?? null;`,
  );
  if (before === "Sign in") {
    await page.evaluate(`${AUTH_BUTTON}.click(); return true;`);
  }
  const signedIn = await waitFor(
    page,
    `[...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Sign out")`,
    15_000,
  );
  check("artwork: signs in through Settings before the views", signedIn, {
    before,
  });
  return signedIn;
}

// Mirrors discovery's external sign-out: MusicKit stops authorizing, the app
// shows its sign-in banner and keeps its data, and Sign out in the banner runs
// the local sign-out (recents, saved queue and library cache go). Then the
// fixture is authorized again without the app signing back in.
async function leaveSignedOut(page) {
  await fixtureCall(page, "emitAuthorizationStatus", [false]);
  await waitFor(
    page,
    `Boolean(document.querySelector(".session-expired-notice"))`,
    10_000,
  );
  await page.evaluate(`
    [...document.querySelectorAll(".session-expired-notice button")]
      .find((node) => node.textContent.trim() === "Sign out")?.click();
    location.hash = "#/library/recent";
    return true;`);
  await waitFor(
    page,
    `document.body.innerText.includes("Sign in to view your library")`,
    10_000,
  );
  await fixtureCall(page, "emitAuthorizationStatus", [true]);
}

const SIGNED_IN_BUTTON = `[...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Sign out")`;

// Ends the suite signed in, through Settings, so the post-scenario isolation
// guard sees the app ready for the next scenario. Clicks Sign in only when an
// enabled Sign in button is present. Never throws: the check it records names
// the state it found, and the caller's cleanup still runs.
async function endSignedIn(page, check) {
  const detail = {
    before: null,
    signInClicked: false,
    signedIn: false,
    signedInLabel: null,
    fixtureAuthorized: null,
    error: null,
  };
  let passed = false;
  try {
    await fixtureCall(page, "reset");
    await fixtureCall(page, "emitAuthorizationStatus", [true]);
    await page.evaluate(`location.hash = "#/settings"; return true;`);
    await waitFor(page, `Boolean(${AUTH_BUTTON})`, 10_000);
    detail.before = await page.evaluate(
      `return ${AUTH_BUTTON}?.textContent.trim() ?? null;`,
    );
    if (detail.before === "Sign in") {
      detail.signInClicked = await page.evaluate(`
        const button = [...document.querySelectorAll("button")]
          .find((node) => node.textContent.trim() === "Sign in" && !node.disabled);
        if (!button) return false;
        button.click();
        return true;`);
      detail.signedIn =
        detail.signInClicked && (await waitFor(page, SIGNED_IN_BUTTON, 15_000));
    } else {
      detail.signedIn = detail.before === "Sign out";
    }
    await waitFor(
      page,
      `document.querySelector(".titlebar-status")?.textContent.trim() === "Connected"`,
      5_000,
    );
    detail.signedInLabel = await page.evaluate(
      `return document.querySelector(".titlebar-status")?.textContent.trim() ?? null;`,
    );
    detail.fixtureAuthorized = await page.evaluate(
      `return window.__ARLET_E2E_MUSIC__.snapshot().authorized === true;`,
    );
    passed =
      detail.signedIn &&
      detail.signedInLabel?.includes("Connected") === true &&
      detail.fixtureAuthorized === true;
  } catch (error) {
    detail.error = String(error?.message ?? error);
  }
  check("artwork ends signed in for the next scenario", passed, detail);
}

/** Visits each view, measures its cards, and checks the artwork geometry. */
export async function runArtwork({ page, check, artifactDir }) {
  try {
    await fixtureCall(page, "reset");
    const icon = await page.evaluate(
      `return document.querySelector("img.brand-mark")?.src ?? null;`,
    );
    check(
      "artwork: the app icon is available to stand in for artwork",
      Boolean(icon),
      { icon },
    );
    await fixtureCall(page, "configure", [
      { artworkGrid: true, artworkTemplate: artworkTemplate(icon) },
    ]);
    await ensureSignedIn(page, check);
    for (const view of VIEWS) {
      await runView(page, check, view, artifactDir);
    }
  } finally {
    // Drop this suite's data through the banner's local sign-out (recents,
    // saved queue and library cache), then sign back in through Settings so
    // the next scenario starts signed in. Each step is guarded so a failure
    // here cannot replace the suite's own error.
    try {
      await leaveSignedOut(page);
    } catch (error) {
      check("artwork clears its data through a local sign-out", false, {
        error: String(error?.message ?? error),
      });
    }
    await endSignedIn(page, check);
    await fixtureCall(page, "reset");
  }
}
