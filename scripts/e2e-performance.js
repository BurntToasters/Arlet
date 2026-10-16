/* Failure modes live in docs/TESTING.md ("Rendering performance"). The
 * numbers in each check detail are the deliverable: a ceiling set to null
 * only records them, and a number makes its check fail above it. */

import fs from "node:fs";
import path from "node:path";
import { fixtureCall, sleep, waitFor } from "./e2e-helpers.js";

const STEADY_EVENTS = 50; // alternating playback-state and queue events
const STEADY_TICKS = 100; // playbackTime ticks
const VOLUME_STEPS = 40; // input events in one volume drag
// The app's VOLUME_SAVE_DELAY_MS in src/app/controller.ts: a save waits this
// long after the last volume event.
const VOLUME_DEBOUNCE_MS = 300;
const SAVE_FLUSH_MS = 1500; // wait past the debounce before reading the file
const VOLUME_TOLERANCE = 0.001; // persisted volume against the slider's value
const LIBRARY_SIZE = 5000;
// 5000 items at the 100-item page the app requests is 50 pages; the rest is slack.
const LIBRARY_MAX_STEPS = 120;
const LIBRARY_PATHS = {
  Albums: "/v1/me/library/albums",
  Artists: "/v1/me/library/artists",
};
const UP_NEXT_SEED = 499; // upcoming rows are this minus the current song
const SETTLE_MS = 500;
// Apple-shaped URL so the app's size rewrite runs; `{id}` is the resource ID.
const ARTWORK_TEMPLATE =
  "https://is1-ssl.mzstatic.com/image/thumb/Music/e2e/{id}/{w}x{h}bb.jpg";
// The Artwork size buckets in src/musickit/normalize.ts.
const ARTWORK_BUCKETS = [96, 300, 640];
const METRICS = [
  "ScriptDuration",
  "LayoutCount",
  "RecalcStyleCount",
  "Nodes",
  "JSHeapUsedSize",
];

// Ceilings. null records only; a number makes its check fail above it.
const LIBRARY_CARD_MAX = 600; // mounted cards in one library grid
const UP_NEXT_ROW_MAX = 120; // mounted Up Next rows

// Records the img src of 42 px thumbnails and the hero as they are set.
// Artwork removes the img when its host fails to load, so reading the DOM
// after the fact would miss the size. Library cards are not recorded, so
// a large library cannot push these out of the log.
const IMAGE_LOG = `
  if (!window.__ARLET_E2E_IMAGES__) {
    window.__ARLET_E2E_IMAGES__ = [];
    const record = (node) => {
      if (!(node instanceof HTMLImageElement)) return;
      const src = node.getAttribute("src");
      const owner = node.closest('[class*="artwork-"]');
      const kind = owner
        ? [...owner.classList].find((name) => name.startsWith("artwork-"))
        : "";
      if (!src || (kind !== "artwork-sm" && kind !== "artwork-xl")) return;
      if (window.__ARLET_E2E_IMAGES__.length >= 5000) return;
      window.__ARLET_E2E_IMAGES__.push({ owner: kind, src });
    };
    new MutationObserver((changes) => {
      for (const change of changes) {
        if (change.type === "attributes") record(change.target);
        for (const node of change.addedNodes) {
          if (node instanceof HTMLImageElement) record(node);
          else if (node instanceof Element) node.querySelectorAll("img").forEach(record);
        }
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  }
  return true;
`;

async function readMetrics(page) {
  const { metrics } = await page.send("Performance.getMetrics");
  const values = Object.fromEntries(
    metrics.map(({ name, value }) => [name, value]),
  );
  return Object.fromEntries(METRICS.map((name) => [name, values[name] ?? 0]));
}

const round = (value) => Math.round(value * 10_000) / 10_000;

/** Nodes and heap are gauges, so both readings are kept. */
function diffMetrics(before, after) {
  return {
    scriptSeconds: round(after.ScriptDuration - before.ScriptDuration),
    layouts: after.LayoutCount - before.LayoutCount,
    styleRecalcs: after.RecalcStyleCount - before.RecalcStyleCount,
    nodesBefore: before.Nodes,
    nodesAfter: after.Nodes,
    jsHeapBeforeBytes: before.JSHeapUsedSize,
    jsHeapAfterBytes: after.JSHeapUsedSize,
  };
}

/** Runs `step`, lets renders settle, and returns the metric deltas. */
async function measure(page, step) {
  const before = await readMetrics(page);
  const result = await step();
  await sleep(SETTLE_MS);
  const after = await readMetrics(page);
  return { ...diffMetrics(before, after), ...(result ?? {}) };
}

/**
 * The persisted volume and the file's mtime. The mtime is read before the
 * file so a save that lands between the two reads shows as a change, not a
 * miss. Both are null while settings.json does not exist.
 */
function readPersistedVolume(file) {
  if (!fs.existsSync(file)) return { volume: null, mtimeMs: null };
  const mtimeMs = fs.statSync(file).mtimeMs;
  const { volume } = JSON.parse(fs.readFileSync(file, "utf8"));
  return { volume: typeof volume === "number" ? volume : null, mtimeMs };
}

const imageCount = (page) =>
  page.evaluate("return window.__ARLET_E2E_IMAGES__.length;");

/** The size segment of a templated artwork URL, such as "96x96". */
const sizeOf = (src) => src?.match(/\/(\d+x\d+)[a-z]*\.jpg/u)?.[1] ?? null;

const distinct = (values) => [...new Set(values)];

const hostOf = (src) => {
  try {
    return new URL(src).hostname;
  } catch {
    return null;
  }
};

/** Only Apple's artwork hosts get the size rewrite that is being checked. */
const isMzstatic = (src) => hostOf(src)?.endsWith(".mzstatic.com") === true;

/**
 * The size segment Artwork requests for a rendered CSS width: the smallest
 * bucket that covers width x devicePixelRatio, or the largest if none does.
 * Mirrors artworkBucketFor in src/musickit/normalize.ts.
 */
function expectedArtworkSize(cssPixels, devicePixelRatio) {
  const needed = cssPixels * devicePixelRatio;
  const bucket =
    !Number.isFinite(needed) || needed <= 0
      ? 300
      : (ARTWORK_BUCKETS.find((value) => value >= needed) ?? 640);
  return `${bucket}x${bucket}`;
}

/** Runs one scenario step; a thrown error fails only that check. */
async function runCheck(check, name, body) {
  try {
    const { passed, detail } = await body();
    check(name, passed, detail);
  } catch (error) {
    check(name, false, { error: String(error?.message ?? error) });
  }
}

const sectionCards = (label) =>
  `document.querySelectorAll('section[aria-label="${label}"] .library-card').length`;

/**
 * Items the fixture has answered for one library path, counted in the page.
 * Ids are deduplicated, so a refreshed first page is not counted twice.
 */
const libraryLoaded = (path) => `(() => {
  const { requests } = window.__ARLET_E2E_MUSIC__.snapshot();
  const ids = new Set();
  let pages = 0;
  for (const request of requests) {
    if (request.path.split("?")[0] !== ${JSON.stringify(path)} || !request.response) continue;
    pages += 1;
    for (const item of request.response.data ?? []) ids.add(item.id);
  }
  return { loaded: ids.size, pages };
})()`;

/**
 * Opens a library section and pages it to the end. Each step scrolls the
 * content pane to its bottom, which brings the load-more trigger into view.
 * The grid is virtualized, so the mounted card count is sampled every step.
 */
async function scrollLibrary(page, section, label) {
  await page.evaluate(
    `location.hash = ${JSON.stringify(`#/library/${section}`)}; return true;`,
  );
  const loaded = await waitFor(page, `${sectionCards(label)} > 0`, 15_000);
  if (!loaded) throw new Error(`no ${label} cards loaded`);
  const path = LIBRARY_PATHS[label];
  const sampleCards = () => page.evaluate(`return ${sectionCards(label)};`);
  const loadedNow = () => page.evaluate(`return ${libraryLoaded(path)};`);
  let maxCards = await sampleCards();
  let { loaded: items } = await loadedNow();
  let steps = 0;
  let reachedEnd = false;
  while (steps < LIBRARY_MAX_STEPS) {
    const hasMore = await page.evaluate(`
      if (!document.querySelector('.library-load-more')) return false;
      const scroller = document.querySelector('.content-scroll');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      return true;`);
    if (!hasMore) {
      reachedEnd = true;
      break;
    }
    steps += 1;
    // A step advances when the fixture answers more items or the trigger goes.
    const advanced = await waitFor(
      page,
      `(${libraryLoaded(path)}).loaded > ${items} || !document.querySelector('.library-load-more')`,
      3000,
    );
    // Give the virtual window a frame to re-render before sampling.
    await sleep(100);
    ({ loaded: items } = await loadedNow());
    maxCards = Math.max(maxCards, await sampleCards());
    if (!advanced) break;
  }
  const finalCards = await sampleCards();
  const totals = await loadedNow();
  return {
    maxCards: Math.max(maxCards, finalCards),
    finalCards,
    steps,
    reachedEnd,
    loaded: totals.loaded,
    pages: totals.pages,
  };
}

/** Steady playback, a volume drag, the large library, Up Next, and artwork. */
export async function runPerformance({ page, check, dataDir }) {
  await page.send("Performance.enable");
  await page.evaluate(IMAGE_LOG);
  try {
    await fixtureCall(page, "reset");
    await fixtureCall(page, "configure", [
      { artworkTemplate: ARTWORK_TEMPLATE },
    ]);
    await page.evaluate(`
      const music = window.MusicKit.getInstance();
      await music.setQueue({ songs: ["song-a", "song-c", "song-e"] });
      await music.play();
      return true;
    `);
    await waitFor(
      page,
      `document.querySelector('.player-artwork-button:not(:disabled)')`,
      10_000,
    );
    await sleep(1000);

    await runCheck(
      check,
      "steady playback: 50 playback and queue events with an unchanged queue",
      async () => {
        const metrics = await measure(page, async () => {
          await page.evaluate(`
            const music = window.MusicKit.getInstance();
            const fixture = window.__ARLET_E2E_MUSIC__;
            for (let index = 0; index < ${STEADY_EVENTS}; index += 1) {
              // Even: playback state. Odd: queue event, with no items added.
              if (index % 2 === 0) await music.play();
              else await music.playLater({ items: [] });
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            for (let tick = 0; tick < ${STEADY_TICKS}; tick += 1) {
              fixture.emitPlaybackTime(tick * 0.5);
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            return true;
          `);
          return {};
        });
        return {
          passed: true,
          detail: {
            events: STEADY_EVENTS,
            ticks: STEADY_TICKS,
            ...metrics,
          },
        };
      },
    );

    await runCheck(
      check,
      "volume drag: 40 input events persist once, after the debounce",
      async () => {
        const settingsFile = path.join(dataDir, "settings.json");
        const before = readPersistedVolume(settingsFile);
        const start = before.volume ?? 1;
        // Ends 0.4 away from the start, so the drag changes the saved value.
        const target =
          Math.round((start >= 0.5 ? start - 0.4 : start + 0.4) * 100) / 100;
        let during;
        let after;
        let sliderFinal;
        const metrics = await measure(page, async () => {
          const drag = await page.evaluate(`
            const input = document.querySelector('input[aria-label="Volume"]');
            if (!input) throw new Error("Volume slider not found");
            let lastEventAt = Date.now();
            for (let index = 0; index < ${VOLUME_STEPS}; index += 1) {
              const value = ${start} + ((${target} - ${start}) * (index + 1)) / ${VOLUME_STEPS};
              input.value = String(Math.round(value * 100) / 100);
              input.dispatchEvent(new Event("input", { bubbles: true }));
              lastEventAt = Date.now();
              await new Promise((resolve) => setTimeout(resolve, 16));
            }
            return { value: Number(input.value), lastEventAt };
          `);
          // Read straight after the drag, while the debounce is still pending.
          const readAt = Date.now();
          during = {
            ...readPersistedVolume(settingsFile),
            sinceLastEventMs: readAt - drag.lastEventAt,
          };
          sliderFinal = drag.value;
          await sleep(SAVE_FLUSH_MS);
          after = readPersistedVolume(settingsFile);
          return {};
        });
        await page.evaluate(`
          const input = document.querySelector('input[aria-label="Volume"]');
          if (input) {
            input.value = "1";
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
          return true;
        `);
        // No write while the drag is in progress, and the debounce has not
        // fired when the file is read; then the final value is on disk.
        const unchangedDuringDrag =
          during.volume === before.volume && during.mtimeMs === before.mtimeMs;
        const readBeforeDebounce = during.sinceLastEventMs < VOLUME_DEBOUNCE_MS;
        const persisted =
          after.volume !== null &&
          Math.abs(after.volume - sliderFinal) <= VOLUME_TOLERANCE &&
          after.mtimeMs !== before.mtimeMs;
        return {
          passed: unchangedDuringDrag && readBeforeDebounce && persisted,
          detail: {
            events: VOLUME_STEPS,
            debounceMs: VOLUME_DEBOUNCE_MS,
            flushMs: SAVE_FLUSH_MS,
            startVolume: start,
            targetVolume: target,
            sliderFinal,
            before,
            during,
            after,
            ...metrics,
          },
        };
      },
    );

    await fixtureCall(page, "configure", [{ librarySize: LIBRARY_SIZE }]);
    for (const [section, label, name] of [
      ["albums", "Albums", "large library: album grid cards in the DOM"],
      ["artists", "Artists", "large library: artist grid cards in the DOM"],
    ]) {
      await runCheck(check, name, async () => {
        const scroll = await measure(page, () =>
          scrollLibrary(page, section, label),
        );
        const within =
          LIBRARY_CARD_MAX === null || scroll.maxCards <= LIBRARY_CARD_MAX;
        return {
          passed:
            within &&
            scroll.maxCards > 0 &&
            scroll.reachedEnd &&
            scroll.loaded === LIBRARY_SIZE,
          detail: {
            librarySize: LIBRARY_SIZE,
            expectedLoaded: LIBRARY_SIZE,
            ceiling: LIBRARY_CARD_MAX,
            ...scroll,
          },
        };
      });
    }

    await runCheck(
      check,
      "Up Next: a 499-song queue mounts only its visible rows",
      async () => {
        await fixtureCall(page, "seedQueue", [UP_NEXT_SEED]);
        const metrics = await measure(page, async () => {
          await page.evaluate(
            `document.querySelector('.player-artwork-button')?.click(); return true;`,
          );
          await waitFor(
            page,
            `document.querySelector('.now-playing-queue')`,
            10_000,
          );
          return {};
        });
        // Virtual spacer rows are aria-hidden, so they are not counted.
        const rows = await page.evaluate(
          `return document.querySelectorAll('.now-playing-queue > li:not([aria-hidden="true"])').length;`,
        );
        const spacerRows = await page.evaluate(
          `return document.querySelectorAll('.now-playing-queue > li[aria-hidden="true"]').length;`,
        );
        const within = UP_NEXT_ROW_MAX === null || rows <= UP_NEXT_ROW_MAX;
        return {
          passed: within && rows > 0,
          detail: {
            queueSeed: UP_NEXT_SEED,
            upcomingTotal: UP_NEXT_SEED - 1,
            rows,
            spacerRows,
            ceiling: UP_NEXT_ROW_MAX,
            ...metrics,
          },
        };
      },
    );

    await runCheck(
      check,
      "artwork: 42 px queue thumbnails and the Now Playing hero",
      async () => {
        // Closing and reopening Now Playing remounts the hero and the Up Next
        // rows, so every image logged after `mark` comes from this step.
        const mark = await imageCount(page);
        await page.evaluate(
          `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`,
        );
        await waitFor(
          page,
          `!document.querySelector('.now-playing-hero')`,
          5_000,
        );
        await page.evaluate(
          `document.querySelector('.player-artwork-button')?.click(); return true;`,
        );
        const opened = await waitFor(
          page,
          `document.querySelector('.now-playing-hero .artwork') && document.querySelector('.now-playing-queue .artwork-sm')`,
          10_000,
        );
        await sleep(500);
        const reading = await page.evaluate(`
          const hero = document.querySelector('.now-playing-hero .artwork');
          const thumb = document.querySelector('.now-playing-queue .artwork-sm');
          return {
            heroCssWidth: hero ? hero.clientWidth : null,
            thumbCssWidth: thumb ? thumb.clientWidth : null,
            devicePixelRatio: window.devicePixelRatio,
          };
        `);
        const logged = await page.evaluate(
          `return window.__ARLET_E2E_IMAGES__.slice(${mark});`,
        );
        await page.evaluate(
          `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`,
        );

        const dpr = reading.devicePixelRatio;
        const heroExpected = expectedArtworkSize(
          reading.heroCssWidth ?? 0,
          dpr,
        );
        const thumbExpected = expectedArtworkSize(
          reading.thumbCssWidth ?? 0,
          dpr,
        );
        const heroLog = logged.filter((entry) => entry.owner === "artwork-xl");
        const thumbLog = logged.filter((entry) => entry.owner === "artwork-sm");
        // Only mzstatic-shaped URLs go through the size rewrite being checked.
        const thumbMzstatic = thumbLog.filter((entry) => isMzstatic(entry.src));
        const heroSizes = distinct(heroLog.map((entry) => sizeOf(entry.src)));
        const thumbSizes = distinct(
          thumbMzstatic.map((entry) => sizeOf(entry.src)),
        );
        const lastThumb = thumbMzstatic.at(-1)?.src ?? null;
        const lastHero = heroLog.at(-1)?.src ?? null;
        const passed =
          opened &&
          reading.heroCssWidth !== null &&
          reading.thumbCssWidth !== null &&
          heroSizes.length > 0 &&
          heroSizes.every((size) => size === heroExpected) &&
          thumbSizes.length > 0 &&
          thumbSizes.every((size) => size === thumbExpected);
        return {
          passed,
          detail: {
            devicePixelRatio: dpr,
            thumbnailCssWidth: reading.thumbCssWidth,
            thumbnailExpectedSize: thumbExpected,
            thumbnailLogged: thumbLog.length,
            thumbnailMzstatic: thumbMzstatic.length,
            thumbnailHosts: distinct(
              thumbLog.map((entry) => hostOf(entry.src)),
            ),
            thumbnailSizes: thumbSizes,
            thumbnailSize: sizeOf(lastThumb),
            thumbnailSrc: lastThumb,
            heroCssWidth: reading.heroCssWidth,
            heroExpectedSize: heroExpected,
            heroLogged: heroLog.length,
            heroSizes,
            heroSize: sizeOf(lastHero),
            heroSrc: lastHero,
            ...(thumbMzstatic.length === 0
              ? {
                  error:
                    "no 42 px queue thumbnail with an mzstatic URL was logged",
                }
              : {}),
          },
        };
      },
    );
  } finally {
    await fixtureCall(page, "configure", [
      { librarySize: 0, artworkTemplate: "" },
    ]).catch(() => undefined);
    await page
      .evaluate(
        `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); location.hash = "#/home"; return true;`,
      )
      .catch(() => undefined);
    await page.send("Performance.disable").catch(() => undefined);
  }
}
