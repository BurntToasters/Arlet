#!/usr/bin/env node
// Stream handoff and expired sign-in against the MusicKit fixture
// (docs/TESTING.md "Stream handoff and sign-in expiry"): the handoff stops
// MusicKit and Play resumes in place; a rejected token shows the banner with
// one probe and keeps all data; a license error with a healthy token does not;
// Sign in again, a closed window, and Sign out behave. The 60 s delay is
// shortened by remapping setTimeout (removed before Play). The 30 s probe
// cooldown uses the app's own Date.now, so the page reloads first and the one
// second-probe check waits. Leaves the app signed in and healthy.

import { fixtureCall, sleep, waitFor as pollFor } from "./e2e-helpers.js";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const NOW_PLAYING = ".player-bar .player-track-copy strong";
const POSITION = ".player-progress span";
const PLAY_BUTTON = ".play-button";
const NOTICE = ".session-expired-notice";
const STATUS = ".titlebar-status";
const PINS = '.sidebar-group[aria-label="Pinned playlists"] .sidebar-link';
const RECENT_KEY = "arlet.search.recent";
const SONG_STATION_URL =
  "https://music.apple.com/us/station/navigation-song-station/ra.song-one";
const SONGS = ["song-a", "song-c"];
const SAVED_SECONDS = 42;
// The handoff delay in the app is 60 s; these stand in for it.
const FAST_RELEASE_MS = 400;
const SHORT_PAUSE_RELEASE_MS = 2500;
const PROBE_COOLDOWN_MS = 30_000;
const PROBE_PATH = "/v1/me/storefront";

const q = (value) => JSON.stringify(value);
const waitFor = (page, expression, timeoutMs = 10_000) =>
  pollFor(page, expression, timeoutMs, 50);
const snapshot = (page) => fixtureCall(page, "snapshot");

/** Runs one group; a throw becomes one failed check instead of a lost run. */
async function group(check, name, body) {
  try {
    await body();
  } catch (error) {
    check(`${name} completes`, false, String(error?.message ?? error));
  }
}

async function mark(page) {
  const trace = await snapshot(page);
  return {
    transitions: trace.transitions.length,
    requests: trace.requests.length,
  };
}

/** Transitions and requests recorded since a mark. */
async function since(page, at) {
  const trace = await snapshot(page);
  return {
    trace,
    transitions: trace.transitions.slice(at.transitions),
    requests: trace.requests.slice(at.requests),
  };
}

const pathOf = (request) => String(request.path).split("?", 1)[0];
const meRequests = (requests) =>
  requests.filter((request) => pathOf(request).startsWith("/v1/me"));
const probesOf = (requests) =>
  requests.filter((request) => pathOf(request) === PROBE_PATH);
const typesOf = (transitions, type) =>
  transitions.filter((item) => item.type === type);

/** Waits for a transition of this type recorded after the mark. */
function waitForTransition(page, at, type, timeoutMs = 8000) {
  return waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.slice(${at.transitions}).some((item) => item.type === ${q(type)})`,
    timeoutMs,
  );
}

function installFastRelease(page, ms) {
  return page.evaluate(`
    window.__ARLET_E2E_NATIVE_SET_TIMEOUT__ ??= window.setTimeout;
    window.__ARLET_E2E_RELEASE_MS__ = ${ms};
    const native = window.__ARLET_E2E_NATIVE_SET_TIMEOUT__;
    window.setTimeout = (callback, delay, ...rest) =>
      native(callback, delay === 60000 ? window.__ARLET_E2E_RELEASE_MS__ : delay, ...rest);
    return true;`);
}

function restoreTimeouts(page) {
  return page.evaluate(`
    if (window.__ARLET_E2E_NATIVE_SET_TIMEOUT__) {
      window.setTimeout = window.__ARLET_E2E_NATIVE_SET_TIMEOUT__;
    }
    return true;`);
}

const uiOf = (page) =>
  page.evaluate(`
    return {
      title: document.querySelector(${q(NOW_PLAYING)})?.textContent ?? null,
      position: document.querySelector(${q(POSITION)})?.textContent ?? null,
      button: document.querySelector(${q(PLAY_BUTTON)})?.getAttribute("aria-label") ?? null,
      notice: Boolean(document.querySelector(${q(NOTICE)})),
      status: document.querySelector(${q(STATUS)})?.textContent.trim() ?? null,
    };`);

const buttonIs = (page, label, timeoutMs) =>
  waitFor(
    page,
    `document.querySelector(${q(PLAY_BUTTON)})?.getAttribute("aria-label") === ${q(label)}`,
    timeoutMs,
  );

const clickPlayButton = (page) =>
  page.evaluate(
    `document.querySelector(${q(PLAY_BUTTON)})?.click(); return true;`,
  );

/** Clicks a button inside the expired-sign-in banner. */
const clickNotice = (page, text) =>
  page.evaluate(`
    const button = [...document.querySelectorAll(${q(`${NOTICE} button`)})]
      .find((node) => node.textContent.trim() === ${q(text)});
    button?.click();
    return Boolean(button);`);

const noticeShown = (page, timeoutMs = 10_000) =>
  waitFor(page, `Boolean(document.querySelector(${q(NOTICE)}))`, timeoutMs);
const noticeGone = (page, timeoutMs = 15_000) =>
  waitFor(page, `!document.querySelector(${q(NOTICE)})`, timeoutMs);

const pinsOf = (page) =>
  page.evaluate(
    `return [...document.querySelectorAll(${q(PINS)})].map((node) => node.textContent.trim());`,
  );

const recentsOf = (page) =>
  page.evaluate(`return localStorage.getItem(${q(RECENT_KEY)});`);

const openHash = async (page, hash, ready, timeoutMs = 10_000) => {
  await page.evaluate(`location.hash = ${q(hash)}; return true;`);
  return ready ? waitFor(page, ready, timeoutMs) : true;
};

/** Queues and plays the two fixture songs, and reports 0:42 elapsed. */
async function startPlayback(page) {
  await page.evaluate(`
    const music = window.MusicKit.getInstance();
    await music.setQueue({ songs: ${q(SONGS)} });
    await music.play();
    return true;`);
  const playing =
    (await buttonIs(page, "Pause")) &&
    (await waitFor(
      page,
      `document.querySelector(${q(NOW_PLAYING)})?.textContent === "Track A"`,
    ));
  await fixtureCall(page, "emitPlaybackTime", [SAVED_SECONDS]);
  const shown = await waitFor(
    page,
    `document.querySelector(${q(POSITION)})?.textContent === "0:42"`,
  );
  return playing && shown;
}

/**
 * Pauses through the player bar with the short handoff delay installed. The
 * native setTimeout is back before this returns, so Play never runs shortened.
 */
async function pauseWithFastRelease(page, releaseMs) {
  await installFastRelease(page, releaseMs);
  await clickPlayButton(page);
  const paused = await buttonIs(page, "Play");
  // The timer is armed on the state change; it keeps its shortened delay.
  await sleep(150);
  await restoreTimeouts(page);
  return paused;
}

async function openMenuAndClick(page, id, itemId) {
  await fixtureCall(page, "selectContext", [id]);
  const ready = await waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item="${itemId}"]:not(:disabled)')`,
  );
  if (!ready) return false;
  await page.evaluate(
    `document.querySelector('.context-menu [data-menu-item="${itemId}"]').click(); return true;`,
  );
  return true;
}

async function typeInto(page, selector, text) {
  await page.evaluate(
    `const input = document.querySelector(${q(selector)}); if (!input) return false; input.focus(); input.select(); return true;`,
  );
  await page.send("Input.insertText", { text });
}

async function pressEnter(page) {
  const common = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    text: "\r",
    ...common,
  });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

/** Runs one search so a recent search is saved for the signed-in account. */
async function saveRecentSearch(page) {
  await openHash(
    page,
    "#/search",
    `Boolean(document.querySelector('.search-form input[role="combobox"]'))`,
  );
  await typeInto(page, '.search-form input[role="combobox"]', "discovery");
  await pressEnter(page);
  await waitFor(
    page,
    `Boolean(document.querySelector(".search-top-section .search-tile-featured"))`,
    15_000,
  );
}

async function pinFixturePlaylist(page) {
  await openHash(
    page,
    "#/playlist/playlist-1",
    `document.querySelector(".library-detail-hero h1")?.textContent?.startsWith("Fixture Playlist")`,
    15_000,
  );
  const pinnedAlready = (await pinsOf(page)).some((text) =>
    text.startsWith("Fixture Playlist"),
  );
  const clicked =
    pinnedAlready ||
    (await openMenuAndClick(
      page,
      { id: "playlist-1", kind: "playlist", source: "library" },
      "pin-playlist",
    ));
  const shown = await waitFor(
    page,
    `[...document.querySelectorAll(${q(PINS)})].some((node) => node.textContent.startsWith("Fixture Playlist"))`,
  );
  return clicked && shown;
}

const pinKept = async (page) =>
  (await pinsOf(page)).some((text) => text.startsWith("Fixture Playlist"));

/** The cached playlist list still renders after the library is blocked. */
async function cachedLibraryShown(page) {
  await openHash(page, "#/library/playlists");
  return waitFor(
    page,
    `document.body.innerText.includes("Fixture Playlist")`,
    8000,
  );
}

async function saveScreenshot(page, artifactDir, name) {
  try {
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(
      path.join(artifactDir, name),
      Buffer.from(shot.data, "base64"),
    );
  } catch {
    // The harness still writes its own screenshot at the end of the suite.
  }
}

/** Starts from a clean page: a fresh probe cooldown, signed in, a pin saved. */
async function prepare(page, check) {
  await fixtureCall(page, "reset");
  await page.send("Page.reload", { ignoreCache: true });
  await sleep(1000);
  const ready = await waitFor(
    page,
    `${FIXTURE} && document.querySelector('.app-shell .player-bar')`,
    30_000,
  );
  const connected = await waitFor(
    page,
    `document.querySelector(${q(STATUS)})?.textContent.includes("Connected")`,
    20_000,
  );
  const trace = await snapshot(page);
  check(
    "account session: MusicKit is configured with its error dialog suppressed",
    ready &&
      connected &&
      trace.configure?.suppressErrorDialog === true &&
      !JSON.stringify(trace.configure).includes("fixture-music-user-token"),
    { ready, connected, configure: trace.configure },
  );
  const dialog = await page.evaluate(
    `return Boolean(document.querySelector("#musickit-dialog"));`,
  );
  check("account session: no MusicKit error dialog exists", !dialog, {
    dialog,
  });
  const pinned = await pinFixturePlaylist(page);
  check("account session: a playlist is pinned for the checks", pinned, {
    pinned,
  });
}

/** Pause past the delay, then Play, a short pause, and playing audio. */
async function handoff(page, check) {
  const started = await startPlayback(page);
  const at = await mark(page);
  const paused = await pauseWithFastRelease(page, FAST_RELEASE_MS);
  const stopped = await waitForTransition(page, at, "stop");
  // The fixture's stop echoes must not overwrite the parked queue.
  await sleep(400);
  const after = await since(page, at);
  const ui = await uiOf(page);
  check(
    "a pause past the delay stops MusicKit and leaves the UI on Track A at 0:42 paused",
    started &&
      paused &&
      stopped &&
      typesOf(after.transitions, "stop").length === 1 &&
      ui.title === "Track A" &&
      ui.position === "0:42" &&
      ui.button === "Play",
    { started, paused, stopped, ui, transitions: after.transitions },
  );

  const resumeAt = await mark(page);
  await clickPlayButton(page);
  const resumed = await waitForTransition(page, resumeAt, "play");
  const playing = await buttonIs(page, "Pause");
  const resume = await since(page, resumeAt);
  const types = resume.transitions.map((item) => item.type);
  const queueIndex = types.indexOf("setQueue");
  const seekIndex = types.indexOf("seekToTime");
  const playIndex = types.indexOf("play");
  const queued = resume.transitions[queueIndex];
  const seek = resume.transitions[seekIndex];
  check(
    "Play after the handoff queues the same songs at the same index, plays, and seeks to 0:42",
    resumed &&
      playing &&
      JSON.stringify(queued?.ids) === JSON.stringify(SONGS) &&
      queued?.index === 0 &&
      Math.abs((seek?.seconds ?? -1) - SAVED_SECONDS) < 1 &&
      queueIndex >= 0 &&
      queueIndex < playIndex &&
      queueIndex < seekIndex,
    { resumed, playing, types, queued, seek },
  );

  // A pause shorter than the delay is never handed back, and the timer left
  // from it must not fire once the audio is playing again.
  const shortAt = await mark(page);
  const shortPaused = await pauseWithFastRelease(page, SHORT_PAUSE_RELEASE_MS);
  await sleep(800);
  const resumeShortAt = await mark(page);
  await clickPlayButton(page);
  const shortResumed = await buttonIs(page, "Pause");
  const shortResume = await since(page, resumeShortAt);
  check(
    "a pause shorter than the delay resumes with plain play and no queue call",
    shortPaused &&
      shortResumed &&
      typesOf(shortResume.transitions, "setQueue").length === 0 &&
      typesOf(shortResume.transitions, "seekToTime").length === 0 &&
      typesOf(shortResume.transitions, "play").length >= 1,
    { shortPaused, shortResumed, types: shortResume.transitions },
  );
  await sleep(SHORT_PAUSE_RELEASE_MS + 600);
  const playingFor = await since(page, shortAt);
  const uiPlaying = await uiOf(page);
  check(
    "playing audio never gets a stop, even after the earlier pause timer would have fired",
    typesOf(playingFor.transitions, "stop").length === 0 &&
      uiPlaying.button === "Pause",
    { transitions: playingFor.transitions.map((item) => item.type), uiPlaying },
  );
}

/** A 403 on /v1/me: banner, one probe, parked queue, data kept, no more calls. */
async function expiry(page, check, artifactDir) {
  await saveRecentSearch(page);
  await openHash(page, "#/library/playlists");
  await startPlayback(page);
  const at = await mark(page);
  await fixtureCall(page, "configure", [{ rejectMeStatus: 403 }]);
  // Refresh the open view through the connection menu: it asks /v1/me.
  await page.evaluate(
    `document.querySelector(${q(STATUS)})?.click(); return true;`,
  );
  await waitFor(page, `Boolean(document.querySelector(".connection-popover"))`);
  await page.evaluate(`
    [...document.querySelectorAll(".connection-popover [role=menuitem]")]
      .find((node) => node.textContent.trim() === "Refresh current view")?.click();
    return true;`);
  const shown = await noticeShown(page);
  const stopped = await waitForTransition(page, at, "stop");
  await sleep(500);
  const after = await since(page, at);
  const ui = await uiOf(page);
  const alert = await page.evaluate(
    `return document.querySelector(${q(NOTICE)})?.getAttribute("role") ?? null;`,
  );
  check(
    "a 403 on /v1/me shows the sign-in banner and Sign in needed in the titlebar",
    shown && alert === "alert" && ui.status?.includes("Sign in needed"),
    { shown, alert, status: ui.status },
  );
  check(
    "expiry sends exactly one /v1/me/storefront probe",
    probesOf(after.requests).length === 1,
    { probes: probesOf(after.requests).length },
  );
  check(
    "expiry stops MusicKit and parks the queue paused at 0:42",
    stopped &&
      ui.title === "Track A" &&
      ui.position === "0:42" &&
      ui.button === "Play",
    { stopped, ui },
  );
  await saveScreenshot(
    page,
    artifactDir,
    "screenshot-account-session-expired.png",
  );

  const libraryShown = await cachedLibraryShown(page);
  const pins = await pinKept(page);
  const recents = await recentsOf(page);
  check(
    "expiry keeps the cached library, pins and recent searches",
    libraryShown && pins && String(recents).includes("discovery"),
    { libraryShown, pins, recents },
  );

  const quietAt = await mark(page);
  for (const hash of ["#/library/albums", "#/home", "#/library/playlists"]) {
    await openHash(page, hash);
    await sleep(500);
  }
  await sleep(1000);
  const quiet = await since(page, quietAt);
  check(
    "no /v1/me request goes out while the sign-in is expired",
    meRequests(quiet.requests).length === 0,
    { paths: meRequests(quiet.requests).map(pathOf) },
  );
  return at;
}

/** Sign in again: unauthorize first, a real popup, data kept, Play works. */
async function signInAgain(page, check) {
  const at = await mark(page);
  const clicked = await clickNotice(page, "Sign in again");
  const cleared = await noticeGone(page);
  const after = await since(page, at);
  const unauthorizeIndex = after.transitions.findIndex(
    (item) => item.type === "unauthorize",
  );
  const authorizeIndex = after.transitions.findIndex(
    (item) => item.type === "authorize" && item.popup === true,
  );
  check(
    "Sign in again unauthorizes first, then opens the sign-in window (popup)",
    clicked &&
      unauthorizeIndex >= 0 &&
      authorizeIndex > unauthorizeIndex &&
      !after.transitions.some(
        (item) => item.type === "authorize" && item.popup === false,
      ),
    { clicked, types: after.transitions },
  );
  const ui = await uiOf(page);
  check(
    "after Sign in again the banner clears and the title says Connected",
    cleared && !ui.notice && ui.status?.includes("Connected"),
    { cleared, ui },
  );
  check(
    "Sign in again keeps the pins and the parked queue",
    (await pinKept(page)) &&
      ui.title === "Track A" &&
      ui.position === "0:42" &&
      ui.button === "Play",
    { ui, pins: await pinsOf(page) },
  );
  const refetched = await waitFor(
    page,
    `${FIXTURE}.snapshot().requests.slice(${at.requests}).some((item) => String(item.path).startsWith("/v1/me/library"))`,
    10_000,
  );
  check("Sign in again refetches the library", refetched, {});
  const playAt = await mark(page);
  await clickPlayButton(page);
  const played = await waitForTransition(page, playAt, "play");
  const playing = await buttonIs(page, "Pause");
  check("Play works after Sign in again", played && playing, {
    played,
    playing,
  });
}

/** A parked station resumes as a station, not as loose songs. */
async function station(page, check) {
  await openHash(page, "#/home");
  const startAt = await mark(page);
  const clicked = await openMenuAndClick(page, "nav-multi", "start-station");
  const queued = await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.slice(${startAt.transitions}).some((item) => item.type === "setQueue" && item.options?.url)`,
  );
  // The fixture queues no songs for a station URL; a playing song stands in
  // for the one a real station would be on.
  await fixtureCall(page, "setCurrentTrack", ["song-e"]);
  const onSong = await waitFor(
    page,
    `document.querySelector(${q(NOW_PLAYING)})?.textContent === "Track E"`,
  );
  await fixtureCall(page, "emitPlaybackTime", [SAVED_SECONDS]);
  await waitFor(
    page,
    `document.querySelector(${q(POSITION)})?.textContent === "0:42"`,
  );
  const pauseAt = await mark(page);
  const paused = await pauseWithFastRelease(page, FAST_RELEASE_MS);
  const stopped = await waitForTransition(page, pauseAt, "stop");
  await sleep(300);
  const resumeAt = await mark(page);
  await clickPlayButton(page);
  const resumed = await waitForTransition(page, resumeAt, "play");
  const resume = await since(page, resumeAt);
  const queuedAgain = resume.transitions.find(
    (item) => item.type === "setQueue",
  );
  check(
    "a parked station resumes with a station-shaped setQueue",
    clicked &&
      queued &&
      onSong &&
      paused &&
      stopped &&
      resumed &&
      queuedAgain?.options?.url === SONG_STATION_URL &&
      !queuedAgain.shape.includes("items") &&
      !queuedAgain.shape.includes("songs"),
    { clicked, queued, onSong, paused, stopped, resumed, queuedAgain },
  );
}

/** MEDIA_LICENSE with a healthy token: friendly error, one probe, no banner. */
async function licenseError(page, check, lastProbeAt) {
  const wait = lastProbeAt + PROBE_COOLDOWN_MS + 1500 - (await pageNow(page));
  if (wait > 0) await sleep(wait);
  const at = await mark(page);
  await fixtureCall(page, "failCurrentItem", ["MEDIA_LICENSE"]);
  const errorShown = await waitFor(
    page,
    `Boolean(document.querySelector(".player-error"))`,
  );
  const probed = await waitFor(
    page,
    `${FIXTURE}.snapshot().requests.slice(${at.requests}).some((item) => String(item.path).split("?", 1)[0] === ${q(PROBE_PATH)})`,
  );
  await sleep(1000);
  const after = await since(page, at);
  const message = await page.evaluate(
    `return document.querySelector(".player-error")?.getAttribute("title") ?? "";`,
  );
  const visible = await page.evaluate(
    `return document.querySelector(".player-error")?.textContent ?? "";`,
  );
  const ui = await uiOf(page);
  check(
    "MEDIA_LICENSE with a healthy token shows a friendly error and no banner",
    errorShown &&
      !ui.notice &&
      /couldn.t start playback/i.test(message) &&
      !/MEDIA_LICENSE|-1003/.test(`${message} ${visible}`),
    { errorShown, notice: ui.notice, message, visible },
  );
  check(
    "MEDIA_LICENSE with a healthy token sends exactly one probe",
    probed && probesOf(after.requests).length === 1,
    { probed, probes: probesOf(after.requests).length },
  );
  // A fresh playing item clears the error and its pending release timer.
  await fixtureCall(page, "setCurrentTrack", ["song-a"]);
  await buttonIs(page, "Pause", 5000);
}

const pageNow = (page) => page.evaluate("return Date.now();");

/** MusicKit revokes the token: banner, a closed window, then Sign out. */
async function revocation(page, check) {
  await openHash(page, "#/home");
  await fixtureCall(page, "emitAuthorizationStatus", [false]);
  const shown = await noticeShown(page);
  const recents = await recentsOf(page);
  const ui = await uiOf(page);
  check(
    "MusicKit revocation shows the banner and keeps recents and pins",
    shown &&
      ui.status?.includes("Sign in needed") &&
      (await pinKept(page)) &&
      String(recents).includes("discovery"),
    { shown, status: ui.status, recents, pins: await pinsOf(page) },
  );

  // Closing the sign-in window must not leave Arlet half signed in.
  await fixtureCall(page, "configure", [{ rejectAuthorize: true }]);
  const at = await mark(page);
  await clickNotice(page, "Sign in again");
  const rejected = await waitForTransition(page, at, "authorize");
  const settled = await waitFor(
    page,
    `[...document.querySelectorAll(${q(`${NOTICE} button`)})].some((node) => node.textContent.trim() === "Sign in again")`,
  );
  const afterClose = await uiOf(page);
  const trace = await snapshot(page);
  check(
    "a closed sign-in window keeps the expired state, the banner and the data",
    rejected &&
      settled &&
      afterClose.notice &&
      (await pinKept(page)) &&
      String(await recentsOf(page)).includes("discovery") &&
      trace.authorized === false,
    { rejected, settled, afterClose, authorized: trace.authorized },
  );
  await fixtureCall(page, "configure", [{ rejectAuthorize: false }]);

  // Sign out from the banner is the full local sign-out.
  const clicked = await clickNotice(page, "Sign out");
  const signedOut = await openHash(
    page,
    "#/library/recent",
    `document.body.innerText.includes("Sign in to view your library")`,
    15_000,
  );
  const finalUi = await uiOf(page);
  const finalRecents = await recentsOf(page);
  const finalTrace = await snapshot(page);
  check(
    "Sign out from the banner runs the full local sign-out",
    clicked &&
      signedOut &&
      !finalUi.notice &&
      (await pinsOf(page)).length === 0 &&
      (finalRecents === null || JSON.parse(finalRecents).length === 0) &&
      finalUi.title === "Nothing playing" &&
      finalTrace.authorized === false &&
      finalTrace.transitions.some((item) => item.type === "unauthorize"),
    { clicked, signedOut, finalUi, finalRecents, pins: await pinsOf(page) },
  );
}

/** Leaves the app signed in with the fixture authorized and unrejected. */
async function restoreSignedIn(page, check) {
  await fixtureCall(page, "configure", [
    { rejectMeStatus: 0, rejectAuthorize: false },
  ]);
  const signedOut = await page.evaluate(`
    return !document.querySelector(${q(NOTICE)}) &&
      ![...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Sign out");`);
  await openHash(
    page,
    "#/settings",
    `[...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Sign in")`,
    15_000,
  );
  const clicked = await page.evaluate(`
    const button = [...document.querySelectorAll("button")]
      .find((node) => node.textContent.trim() === "Sign in");
    button?.click();
    return Boolean(button);`);
  const signedIn =
    (await waitFor(
      page,
      `[...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Sign out")`,
      15_000,
    )) && !(await uiOf(page)).notice;
  const trace = await snapshot(page);
  check(
    "account session ends signed in and healthy for the next suite",
    signedIn && trace.authorized === true,
    { signedOut, clicked, signedIn, authorized: trace.authorized },
  );
}

/** Stream handoff and expired sign-in checks (see the header). */
export async function runAccountSession({ page, check, artifactDir }) {
  try {
    await group(check, "account session setup", () => prepare(page, check));
    await group(check, "stream handoff", () => handoff(page, check));
    let expiredAt;
    await group(check, "sign-in expiry", async () => {
      expiredAt = await expiry(page, check, artifactDir);
    });
    await group(check, "sign in again", () => signInAgain(page, check));
    await group(check, "station handoff", () => station(page, check));
    // The expiry probe is the last one sent so far; the license check needs
    // the cooldown (30 s on the app's own clock) to have passed.
    const probeTimes = expiredAt
      ? (await snapshot(page)).requests
          .filter((request) => pathOf(request) === PROBE_PATH)
          .map((request) => request.startedAt)
      : [];
    const lastProbeAt = probeTimes.length ? Math.max(...probeTimes) : 0;
    await group(check, "license error with a healthy token", () =>
      licenseError(page, check, lastProbeAt),
    );
    await group(check, "revocation", () => revocation(page, check));
  } finally {
    await restoreTimeouts(page);
    await group(check, "account session cleanup", () =>
      restoreSignedIn(page, check),
    );
    await fixtureCall(page, "reset");
  }
}
