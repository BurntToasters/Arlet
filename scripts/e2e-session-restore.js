#!/usr/bin/env node
// Session restore against the MusicKit fixture. Seeds playback-session.json
// in the app data folder, reloads, and checks that a corrupt file starts with
// an empty queue, a valid one restores paused without provider calls, Play
// resumes at the saved index and position, and sign-out deletes the file.
// Runs last: it signs out at the end.

import fs from "node:fs";
import path from "node:path";

const SESSION_FILE = "playback-session.json";
const BACKUP_FILE = "playback-session.json.bak";
const NOW_PLAYING = ".player-bar .player-track-copy strong";
const SAVED_IDS = ["song-a", "song-c", "song-e"];
const SAVED_INDEX = 1;
const SAVED_POSITION = 42.5;
const SAVED_ITEMS = [
  {
    id: "song-a",
    title: "Track A",
    artistName: "Fixture Artist",
    albumTitle: "Fixture Album",
    resourceType: "library-songs",
    durationMs: 180_000,
  },
  {
    id: "song-c",
    title: "Track C",
    artistName: "Fixture Artist",
    albumTitle: "Fixture Album",
    resourceType: "library-songs",
    durationMs: 180_000,
  },
  {
    id: "song-e",
    title: "Track E",
    artistName: "Fixture Artist",
    albumTitle: "Fixture Album",
    resourceType: "library-songs",
    durationMs: 180_000,
  },
];

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(page, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(`return Boolean(${expression});`)) return true;
    await sleep(100);
  }
  return false;
}

async function waitForFile(file, present, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) === present) return true;
    await sleep(100);
  }
  return fs.existsSync(file) === present;
}

async function reloadApp(page) {
  await page.send("Page.reload", { ignoreCache: true });
  await sleep(1000);
  return waitFor(
    page,
    "window.__ARLET_E2E_MUSIC__ && document.querySelector('.app-shell .player-bar')",
    30_000,
  );
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function clickByText(page, selector, text) {
  return page.evaluate(`
    const match = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((node) => node.textContent.trim() === ${JSON.stringify(text)});
    match?.click();
    return Boolean(match);`);
}

function setResumeToggle(page, checked) {
  return page.evaluate(`
    const label = [...document.querySelectorAll("label")]
      .find((node) => node.textContent.includes("Resume where I left off"));
    const input = label?.querySelector('input[type="checkbox"]');
    if (!input) return false;
    if (input.checked !== ${checked}) input.click();
    return true;`);
}

/** Session restore: corrupt, valid, play, toggle, and sign-out cases. */
export async function runSessionRestore({ page, check, dataDir }) {
  const sessionFile = path.join(dataDir, SESSION_FILE);
  const backupFile = path.join(dataDir, BACKUP_FILE);

  // Earlier scenarios leave a queue behind. reset() empties it, so the
  // pagehide save on reload has nothing to write over the seeded files.
  await page.evaluate("window.__ARLET_E2E_MUSIC__.reset(); return true;");
  await sleep(2500);

  // 1. Corrupt main file and corrupt backup: startup ignores both.
  fs.writeFileSync(sessionFile, '{"schemaVersion":1,"items":[');
  fs.writeFileSync(backupFile, "not json");
  const corruptReloaded = await reloadApp(page);
  await sleep(1000);
  const corrupt = await page.evaluate(`
    location.hash = "#/settings";
    return {
      nowPlaying: document.querySelector(${JSON.stringify(NOW_PLAYING)})?.textContent ?? null,
    };`);
  const usable = await waitFor(
    page,
    'document.querySelector("h1")?.textContent === "Settings"',
  );
  check(
    "corrupt saved queue starts with an empty queue and a usable app",
    corruptReloaded && corrupt.nowPlaying === "Nothing playing" && usable,
    { ...corrupt, usable },
  );

  // 2. Valid main file, backup removed: queue renders paused, no provider calls.
  fs.rmSync(backupFile, { force: true });
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({
      schemaVersion: 1,
      items: SAVED_ITEMS,
      index: SAVED_INDEX,
      positionSeconds: SAVED_POSITION,
      savedAt: Date.now() - 60_000,
    }),
  );
  await reloadApp(page);
  const restored = await waitFor(
    page,
    `document.querySelector(${JSON.stringify(NOW_PLAYING)})?.textContent === "Track C"`,
    15_000,
  );
  await page.evaluate(`
    document.querySelector('button[aria-label="Toggle Playing Next"]')?.click();
    return true;`);
  const queueRows = await waitFor(
    page,
    'document.querySelectorAll(".queue-list > li").length === 3',
  );
  const restoredView = await page.evaluate(`
    const trace = window.__ARLET_E2E_MUSIC__.snapshot();
    return {
      button: document.querySelector(".play-button")?.getAttribute("aria-label") ?? null,
      position: document.querySelector(".player-progress span")?.textContent ?? null,
      activeRow: document.querySelector(".queue-row-shell.is-active")?.textContent ?? null,
      // Applying the saved volume at startup is not a playback call.
      transitions: trace.transitions
        .map((item) => item.type)
        .filter((type) => type !== "volume"),
    };`);
  check(
    "saved queue renders paused at the saved position with no provider calls",
    restored &&
      queueRows &&
      restoredView.button === "Play" &&
      restoredView.position === "0:42" &&
      restoredView.activeRow?.includes("Track C") &&
      restoredView.transitions.length === 0,
    { queueRows, ...restoredView },
  );
  await page.evaluate(`
    document.querySelector('button[aria-label="Toggle Playing Next"]')?.click();
    return true;`);

  // 3. Play resumes at the saved index and seeks to the saved position.
  await page.evaluate(`
    document.querySelector(".play-button")?.click();
    return true;`);
  const resumed = await waitFor(
    page,
    'window.__ARLET_E2E_MUSIC__.snapshot().transitions.some((item) => item.type === "seekToTime")',
    15_000,
  );
  const transitions = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot().transitions;",
  );
  const indexOf = (type) => transitions.findIndex((item) => item.type === type);
  const setQueue = transitions.find((item) => item.type === "setQueue");
  const selected = transitions.find((item) => item.type === "selectIndex");
  const seek = transitions.find((item) => item.type === "seekToTime");
  check(
    "Play sets the saved queue, selects the saved song, then seeks to the saved position",
    resumed &&
      JSON.stringify(setQueue?.ids) === JSON.stringify(SAVED_IDS) &&
      selected?.index === SAVED_INDEX &&
      Math.abs((seek?.seconds ?? -1) - SAVED_POSITION) < 0.001 &&
      indexOf("setQueue") < indexOf("selectIndex") &&
      indexOf("selectIndex") < indexOf("play") &&
      indexOf("play") < indexOf("seekToTime"),
    { order: transitions.map((item) => item.type), setQueue, selected, seek },
  );

  // 4. Turning Resume off deletes the file; turning it back on saves again.
  await page.evaluate('location.hash = "#/settings"; return true;');
  await waitFor(page, 'document.querySelector("#playback-heading")');
  await setResumeToggle(page, false);
  const deletedByToggle = await waitForFile(sessionFile, false);
  check("turning Resume off deletes the saved queue", deletedByToggle, {
    stillExists: fs.existsSync(sessionFile),
  });
  await setResumeToggle(page, true);
  await page.evaluate(`
    document.querySelector(".play-button")?.click();
    return true;`);
  const savedAgain = await waitForFile(sessionFile, true, 8_000);
  const saved = readJson(sessionFile);
  const playingTitle = await page.evaluate(
    `return document.querySelector(${JSON.stringify(NOW_PLAYING)})?.textContent ?? null;`,
  );
  check(
    "turning Resume back on saves the queue after the next pause",
    savedAgain &&
      JSON.stringify(saved?.items?.map((item) => item.id)) ===
        JSON.stringify(SAVED_IDS) &&
      saved?.index === SAVED_INDEX,
    {
      savedAgain,
      index: saved?.index,
      ids: saved?.items?.map((item) => item.id),
      playingTitle,
      provider: await page.evaluate(
        "return window.__ARLET_E2E_MUSIC__.snapshot().queue;",
      ),
    },
  );

  // 5. Sign-out deletes the file, and no save follows it.
  await page.evaluate('location.hash = "#/settings"; return true;');
  await clickByText(page, "button", "Sign out");
  const signedOut = await waitFor(
    page,
    '[...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Sign in")',
    15_000,
  );
  const removed = await waitForFile(sessionFile, false);
  await sleep(3000);
  check(
    "sign-out deletes the saved queue and nothing is written afterwards",
    signedOut &&
      removed &&
      !fs.existsSync(sessionFile) &&
      !fs.existsSync(backupFile),
    {
      signedOut,
      removed,
      stillExists: fs.existsSync(sessionFile),
      nowPlayingAfterSignOut: await page.evaluate(
        `return document.querySelector(${JSON.stringify(NOW_PLAYING)})?.textContent ?? null;`,
      ),
    },
  );
}
