#!/usr/bin/env node

/* Failure modes live in docs/TESTING.md ("Pinned playlist artwork"). Saves two
 * pins whose covers are signed links, one long expired and one fresh, then
 * reloads the app so they load the way they do after a restart. */

import { fixtureCall, sleep, waitFor as pollFor } from "./e2e-helpers.js";

// The fixture answers this playlist with a cover signed at request time.
const EXPIRED_ID = "playlist-pin-art";
// Not in the fixture at all: a lookup for it would be wasted.
const VALID_ID = "playlist-pin-valid";
const PIN_GROUP = `.sidebar-group[aria-label="Pinned playlists"]`;
// The fixture answers this one with no artwork at all.
const NOCOVER_ID = "playlist-pin-nocover";
// Not in the fixture: detail and ?ids= both answer nothing for it.
const MISSING_ID = "playlist-pin-missing";
const EXPIRED_AT = Date.UTC(2026, 0, 1);
const EXPIRED_DATE_PARAM = `X-Amz-Date=${amzDate(EXPIRED_AT)}`;

const waitFor = (page, expression, timeoutMs = 10_000) =>
  pollFor(page, expression, timeoutMs, 50);

function amzDate(ms) {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "");
}

function signedCover(id, signedAtMs) {
  return `https://e2e-blobstore.invalid/${id}.jpg?X-Amz-Date=${amzDate(signedAtMs)}&X-Amz-Expires=86400&X-Amz-Signature=e2e`;
}

async function loadPinsRaw(page) {
  return page.evaluate(
    `return (await window.__TAURI_INTERNALS__.invoke("load_pins")) ?? null;`,
  );
}

async function savePinsRaw(page, json) {
  await page.evaluate(
    `await window.__TAURI_INTERNALS__.invoke("save_pins", { json: ${JSON.stringify(json)} }); return true;`,
  );
}

async function reloadApp(page) {
  await page.send("Page.reload", { ignoreCache: true });
  await sleep(1000);
  return waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__ && document.querySelector(".app-shell .player-bar") && document.querySelector(".titlebar-status")?.textContent.includes("Connected")`,
    30_000,
  );
}

function pinLink(name) {
  return `[...document.querySelectorAll(${JSON.stringify(`${PIN_GROUP} .sidebar-link`)})].find((link) => link.textContent.includes(${JSON.stringify(name)}))`;
}

const isFreshCover = (url, id) =>
  typeof url === "string" &&
  url.includes(`/${id}.jpg?`) &&
  !url.includes(EXPIRED_DATE_PARAM);

async function savePins(page, pins) {
  await savePinsRaw(page, JSON.stringify({ schemaVersion: 1, pins }));
}

async function savedPins(page) {
  return JSON.parse((await loadPinsRaw(page)) || "{}").pins ?? [];
}

/** Polls the saved pins until the pin with this id passes; null on timeout. */
async function waitForSavedPin(page, id, passes, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pin = (await savedPins(page)).find((entry) => entry.id === id);
    if (pin && passes(pin)) return pin;
    await sleep(200);
  }
  return null;
}

async function playlistRequests(page) {
  return page.evaluate(`
    return window.__ARLET_E2E_MUSIC__.snapshot().requests
      .filter((request) => request.path.includes("/v1/me/library/playlists"))
      .map((request) => ({ path: request.path, ids: request.query?.ids ?? null }));`);
}

/** Whether a library playlist request asked for this id, alone or in ?ids=. */
function requestsMention(requests, id) {
  return requests.some(
    (request) =>
      request.path.includes(`/playlists/${id}`) ||
      String(request.ids ?? "")
        .split(",")
        .includes(id),
  );
}

/** Waits until a library request for this id has gone out since the reload. */
async function waitForLookup(page, id, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (requestsMention(await playlistRequests(page), id)) return true;
    await sleep(100);
  }
  return false;
}

/** Pinning from a page while the Library list holds an expired link saves a fresh one. */
async function checkPinFromExpiredListLink(page, check) {
  await savePins(page, []);
  await reloadApp(page);
  await fixtureCall(page, "configure", [{ pinArtListExpired: true }]);
  try {
    // Records each cover src the list shows, since a card drops its image
    // once the dead host fails to load.
    await page.evaluate(`
      window.__ARLET_E2E_LIST_SRCS__ = [];
      new MutationObserver(() => {
        for (const img of document.querySelectorAll(".library-card img")) {
          const src = img.getAttribute("src");
          if (src && !window.__ARLET_E2E_LIST_SRCS__.includes(src)) {
            window.__ARLET_E2E_LIST_SRCS__.push(src);
          }
        }
      }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
      location.hash = "#/library/playlists";
      return true;`);
    const listed = await waitFor(
      page,
      `window.__ARLET_E2E_LIST_SRCS__.some((src) => src.includes(${JSON.stringify(`/${EXPIRED_ID}.jpg?${EXPIRED_DATE_PARAM}`)}))`,
      15_000,
    );
    check(
      "the Library list shows the pin-art playlist with an expired cover link",
      listed,
    );
    if (!listed) return;

    await page.evaluate(
      `location.hash = ${JSON.stringify(`#/playlist/${EXPIRED_ID}`)}; return true;`,
    );
    const detailReady = await waitFor(
      page,
      `document.querySelector(".library-detail-hero h1")?.textContent?.startsWith("Pinned Cover Art")`,
      15_000,
    );
    const pinButton = `[...document.querySelectorAll(".library-detail-hero button")].find((button) => ["Pin", "Unpin"].includes(button.textContent.trim()))`;
    const pinReady =
      detailReady &&
      (await waitFor(
        page,
        `${pinButton}?.textContent.trim() === "Pin"`,
        15_000,
      ));
    if (pinReady) await page.evaluate(`${pinButton}?.click(); return true;`);
    const pin = pinReady
      ? await waitForSavedPin(page, EXPIRED_ID, (entry) =>
          isFreshCover(entry.artworkUrl, EXPIRED_ID),
        )
      : null;
    check(
      "pinning a playlist whose listed cover link expired saves a fresh cover link",
      pin !== null,
      { savedPins: pin ? undefined : await savedPins(page) },
    );
  } finally {
    await fixtureCall(page, "configure", [{ pinArtListExpired: false }]);
  }
}

/** A pin whose playlist has no cover drops its dead link; an unknown pin keeps its link. */
async function checkPinsWithoutCover(page, check) {
  const noCoverLink = signedCover(NOCOVER_ID, EXPIRED_AT);
  const missingLink = signedCover(MISSING_ID, EXPIRED_AT);
  await savePins(page, [
    {
      id: NOCOVER_ID,
      source: "library",
      name: "Pinned Without Cover",
      artworkUrl: noCoverLink,
    },
    {
      id: MISSING_ID,
      source: "library",
      name: "Pinned Missing",
      artworkUrl: missingLink,
    },
  ]);
  await reloadApp(page);
  const cleared = await waitForSavedPin(
    page,
    NOCOVER_ID,
    (entry) => entry.artworkUrl === undefined,
  );
  check(
    "a pin whose playlist has no cover drops its dead cover link",
    cleared !== null,
    { savedPins: cleared ? undefined : await savedPins(page) },
  );

  const missingLooked = await waitForLookup(page, MISSING_ID);
  const missingPin = (await savedPins(page)).find(
    (entry) => entry.id === MISSING_ID,
  );
  check(
    "a pin the library does not know keeps its saved cover link",
    missingLooked && missingPin?.artworkUrl === missingLink,
    {
      missingLooked,
      savedLink: missingPin?.artworkUrl ?? null,
    },
  );

  // The next start looks up the unknown pin again, so its lookup has run
  // before the no-cover pin is checked.
  await reloadApp(page);
  const lookedUpAgain = await waitForLookup(page, MISSING_ID);
  const requests = await playlistRequests(page);
  check(
    "a pin whose playlist has no cover is not looked up on the next start",
    lookedUpAgain && !requestsMention(requests, NOCOVER_ID),
    { lookedUpAgain, requests },
  );
}

/** Expired pin covers are fetched again, saved, and never shown broken. */
export async function runPinArtwork({ page, check }) {
  const originalPins = await loadPinsRaw(page);
  const expiredCover = signedCover(EXPIRED_ID, Date.UTC(2026, 0, 1));
  const validCover = signedCover(VALID_ID, Date.now());
  // Records every pin cover src from the first paint, so a short flash of
  // the expired link counts too.
  const recorder = await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__ARLET_E2E_PIN_SRCS__ = [];
      new MutationObserver(() => {
        for (const img of document.querySelectorAll(".sidebar-pin-art")) {
          const src = img.getAttribute("src");
          if (src && !window.__ARLET_E2E_PIN_SRCS__.includes(src)) {
            window.__ARLET_E2E_PIN_SRCS__.push(src);
          }
        }
      }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });`,
  });
  try {
    await savePinsRaw(
      page,
      JSON.stringify({
        schemaVersion: 1,
        pins: [
          {
            id: EXPIRED_ID,
            source: "library",
            name: "Pinned Cover Art",
            artworkUrl: expiredCover,
          },
          {
            id: VALID_ID,
            source: "library",
            name: "Pinned Valid Cover",
            artworkUrl: validCover,
          },
        ],
      }),
    );
    const ready = await reloadApp(page);
    const pinsShown =
      ready &&
      (await waitFor(
        page,
        `${pinLink("Pinned Cover Art")} && ${pinLink("Pinned Valid Cover")}`,
      ));
    check("pin-artwork reloads with both saved pins", pinsShown);
    if (!pinsShown) return;

    const savedFresh = await (async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const pins = JSON.parse((await loadPinsRaw(page)) || "{}").pins ?? [];
        const url = pins.find((pin) => pin.id === EXPIRED_ID)?.artworkUrl;
        if (url && url !== expiredCover) return url;
        await sleep(200);
      }
      return null;
    })();
    const requests = await page.evaluate(`
      return window.__ARLET_E2E_MUSIC__.snapshot().requests
        .filter((request) => request.path.includes("/v1/me/library/playlists"))
        .map((request) => ({ path: request.path, ids: request.query?.ids ?? null }));`);
    const lookedUp = (id) => requestsMention(requests, id);
    check(
      "a pin whose saved cover link expired is looked up again at startup",
      lookedUp(EXPIRED_ID),
      { requests },
    );
    check(
      "the fresh cover link is saved with the pin",
      typeof savedFresh === "string" &&
        savedFresh.includes(`/${EXPIRED_ID}.jpg?`) &&
        !savedFresh.includes(`X-Amz-Date=${amzDate(Date.UTC(2026, 0, 1))}`),
      { savedFresh },
    );
    check(
      "a pin whose saved cover link is still valid is not looked up again",
      !lookedUp(VALID_ID),
      { requests },
    );

    // Both covers point at a host that never resolves.
    const fellBack = await waitFor(
      page,
      `[${pinLink("Pinned Cover Art")}, ${pinLink("Pinned Valid Cover")}].every((link) => link && !link.querySelector(".sidebar-pin-art") && link.querySelector("svg"))`,
    );
    const shownSrcs = await page.evaluate(
      `return window.__ARLET_E2E_PIN_SRCS__ ?? null;`,
    );
    check(
      "the sidebar never shows an expired cover link",
      Array.isArray(shownSrcs) && !shownSrcs.includes(expiredCover),
      { shownSrcs },
    );
    check(
      "a cover that fails to load shows the playlist icon, not a broken image",
      fellBack,
      {
        links: await page.evaluate(`
          return [...document.querySelectorAll(${JSON.stringify(`${PIN_GROUP} .sidebar-link`)})]
            .map((link) => ({ text: link.textContent.trim(), html: link.innerHTML.slice(0, 200) }));`),
      },
    );

    await checkPinFromExpiredListLink(page, check);
    await checkPinsWithoutCover(page, check);
  } finally {
    await page.send("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: recorder.identifier,
    });
    await savePinsRaw(page, originalPins ?? JSON.stringify({ pins: [] }));
    const restored = await reloadApp(page);
    check("pin-artwork restores the saved pins", restored);
  }
}
