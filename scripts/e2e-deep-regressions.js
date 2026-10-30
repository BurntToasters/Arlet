import fs from "node:fs";
import path from "node:path";
import { fixtureCall, sleep, waitFor as pollFor } from "./e2e-helpers.js";

const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const CURRENT_TITLE =
  'document.querySelector(".player-bar .player-track-copy strong")?.textContent';
const PLAYLIST_TRACK_A_READY =
  'document.querySelector(".library-detail-hero h1")?.textContent?.startsWith("Fixture Playlist") && document.querySelector(".library-track-row")?.textContent.includes("Track A")';
const ALBUM_TRACK_A_READY =
  'document.querySelector(".library-detail-hero h1")?.textContent?.startsWith("Fixture Album") && document.querySelector(".library-track-row")?.textContent.includes("Album Track A")';
const ALBUM_TRACK_C_READY =
  'document.querySelector(".library-detail-hero h1")?.textContent?.startsWith("Fixture Album") && [...document.querySelectorAll(".library-track-row")].some((row) => row.textContent.includes("Album Track C"))';
const QUEUE_IDS_FROM_OPTIONS = `const idsFromOptions = (options) => {
  const ids = [];
  if (Array.isArray(options?.items)) {
    ids.push(...options.items.map((item) => String(item?.id)));
  }
  for (const key of ["songs", "musicVideos"]) {
    if (Array.isArray(options?.[key])) ids.push(...options[key].map(String));
  }
  return ids;
};`;
const q = (value) => JSON.stringify(value);
const waitFor = (page, expression, timeoutMs = 10_000) =>
  pollFor(page, expression, timeoutMs, 50);

async function required(page, expression, label, timeoutMs = 10_000) {
  if (!(await waitFor(page, expression, timeoutMs))) throw new Error(label);
}

async function state(page) {
  return page.evaluate(`
    const fixture = ${FIXTURE}.snapshot();
    return {
      authorized: fixture.authorized,
      status: document.querySelector(".titlebar-status")?.textContent.trim() ?? "",
      expiredNotice: Boolean(document.querySelector(".session-expired-notice")),
      title: ${CURRENT_TITLE} ?? null,
      queueIds: fixture.queue.items.map((item) => item.id),
      queueIndex: fixture.queue.index,
      activeId: fixture.queue.activeId,
      queueEdit: fixture.queueEdit,
      transitions: fixture.transitions,
    };
  `);
}

async function fresh(page) {
  await fixtureCall(page, "reset");
  await page.send("Page.reload", { ignoreCache: true });
  await required(
    page,
    `${FIXTURE} && document.querySelector(".app-shell .player-bar")`,
    "Fixture reload failed",
    30_000,
  );
  await required(
    page,
    'document.querySelector(".titlebar-status")?.textContent.includes("Connected")',
    "Fixture did not start connected",
    15_000,
  );
  return state(page);
}

async function route(page, hash, ready) {
  await page.evaluate(`location.hash = ${q(hash)}; return true;`);
  await required(page, ready, `Route not ready: ${hash}`, 15_000);
}

async function startRow(page, index, title) {
  const clicked = await page.evaluate(`return (() => {
    const row = document.querySelectorAll(".library-track-row")[${index}];
    if (!row) return false;
    row.click();
    return true;
  })()`);
  await required(
    page,
    `${CURRENT_TITLE} === ${q(title)}`,
    `Track did not start: ${title}`,
    15_000,
  );
  return { clicked, state: await state(page) };
}

function preconditions(check, name, conditions, passed, detail) {
  const met = Object.values(conditions).filter(Boolean).length;
  check(name, met === Object.keys(conditions).length && passed, {
    preconditions: conditions,
    preconditionsMet: met,
    expectedPreconditions: Object.keys(conditions).length,
    ...detail,
  });
}

async function rejectHeld(page, key, id) {
  await page.evaluate(`(() => {
    const error = new Error("One or more items could not be resolved: " + ${q(id)});
    error.errorCode = "NOT_FOUND";
    error.data = [{ id: ${q(id)} }];
    const audit = window[${q(key)}];
    audit.released = true;
    audit.reject(error);
    return true;
  })()`);
  await sleep(700);
}

async function saveScreenshot(page, artifactDir, name) {
  const result = await page.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(
    path.join(artifactDir, name),
    Buffer.from(result.data, "base64"),
  );
}

async function stalePlayNext(page, check) {
  await fresh(page);
  await route(page, "#/playlist/playlist-1", PLAYLIST_TRACK_A_READY);
  const initial = await startRow(page, 0, "Track A");
  await page.evaluate(`(() => {
    const instance = window.MusicKit.getInstance();
    ${QUEUE_IDS_FROM_OPTIONS}
    const original = instance.playNext.bind(instance);
    const audit = window.__DEEP_PLAY_NEXT__ = { held: false, released: false, retries: [] };
    instance.playNext = async (options) => {
      if (!audit.held) {
        audit.held = true;
        await new Promise((_resolve, reject) => { audit.reject = reject; });
      }
      if (audit.released) audit.retries.push(idsFromOptions(options));
      return original(options);
    };
    return true;
  })()`);
  await fixtureCall(page, "selectContext", [
    { id: "album-1", kind: "album", source: "library" },
  ]);
  await required(
    page,
    `document.querySelector('.context-menu [data-menu-item="play-next-collection"]:not(:disabled)')`,
    "Album Play Next menu missing",
  );
  const actionAccepted = await page.evaluate(`return (() => {
    const item = document.querySelector('.context-menu [data-menu-item="play-next-collection"]');
    if (!item || item.disabled) return false;
    item.click();
    return true;
  })()`);
  await required(
    page,
    "window.__DEEP_PLAY_NEXT__?.held === true",
    "Old Play Next call was not held",
  );
  const held = await page.evaluate(
    "return window.__DEEP_PLAY_NEXT__?.held === true;",
  );

  await route(page, "#/album/album-1", ALBUM_TRACK_C_READY);
  const newerPlay = await startRow(page, 2, "Album Track C");
  const beforeFailure = await state(page);
  await rejectHeld(page, "__DEEP_PLAY_NEXT__", "album-a");
  const afterFailure = await state(page);
  const retries = await page.evaluate(
    "return window.__DEEP_PLAY_NEXT__?.retries ?? [];",
  );
  const lateTransitions = afterFailure.transitions.slice(
    beforeFailure.transitions.length,
  );
  const pre = {
    playlistStarted: initial.clicked && initial.state.activeId === "song-a",
    userSelectedPlayNext: actionAccepted,
    oldCallHeld: held,
    newerPlayOwnsQueue:
      newerPlay.clicked && beforeFailure.activeId === "album-c",
  };
  preconditions(
    check,
    "an unresolved Play Next from an older selection cannot insert after a newer Play",
    pre,
    retries.length === 0 &&
      JSON.stringify(afterFailure.queueIds) ===
        JSON.stringify(beforeFailure.queueIds) &&
      afterFailure.activeId === beforeFailure.activeId &&
      afterFailure.title === "Album Track C" &&
      !lateTransitions.some((item) => item.type === "playNext"),
    { beforeFailure, afterFailure, retries, lateTransitions },
  );
  return { preconditions: pre, beforeFailure, afterFailure, retries };
}

async function staleQueueSelection(page, check) {
  await fresh(page);
  await route(page, "#/playlist/playlist-1", PLAYLIST_TRACK_A_READY);
  const initial = await startRow(page, 0, "Track A");
  await page.evaluate(`(() => {
    const instance = window.MusicKit.getInstance();
    instance.player.changeToMediaAtIndex = undefined;
    instance.changeToMediaAtIndex = undefined;
    ${QUEUE_IDS_FROM_OPTIONS}
    const original = instance.setQueue.bind(instance);
    const audit = window.__DEEP_QUEUE_SELECTION__ = { held: false, released: false, retries: [] };
    instance.setQueue = async (options) => {
      if (!audit.held) {
        audit.held = true;
        await new Promise((_resolve, reject) => { audit.reject = reject; });
      }
      if (audit.released) audit.retries.push(idsFromOptions(options));
      return original(options);
    };
    if (!document.querySelector(".queue-drawer")) {
      document.querySelector('button[aria-label="Toggle Playing Next"]')?.click();
    }
    return true;
  })()`);
  const indexedSelectionMethodsRemoved = await page.evaluate(`return (() => {
    const instance = window.MusicKit.getInstance();
    return typeof instance.player.changeToMediaAtIndex !== "function" &&
      typeof instance.changeToMediaAtIndex !== "function";
  })()`);
  await required(
    page,
    'document.querySelectorAll(".queue-drawer .queue-row").length >= 3',
    "Queue drawer did not show the playlist queue",
  );
  const selectionAccepted = await page.evaluate(`return (() => {
    const row = document.querySelectorAll(".queue-drawer .queue-row")[1];
    if (!row) return false;
    row.click();
    return true;
  })()`);
  await required(
    page,
    "window.__DEEP_QUEUE_SELECTION__?.held === true",
    "Queue selection fallback was not held",
  );
  const held = await page.evaluate(
    "return window.__DEEP_QUEUE_SELECTION__?.held === true;",
  );

  await route(page, "#/album/album-1", ALBUM_TRACK_C_READY);
  const newerPlay = await startRow(page, 2, "Album Track C");
  const beforeFailure = await state(page);
  await rejectHeld(page, "__DEEP_QUEUE_SELECTION__", "song-duplicate");
  const afterFailure = await state(page);
  const retries = await page.evaluate(
    "return window.__DEEP_QUEUE_SELECTION__?.retries ?? [];",
  );
  const lateTransitions = afterFailure.transitions.slice(
    beforeFailure.transitions.length,
  );
  const pre = {
    playlistStarted: initial.clicked && initial.state.activeId === "song-a",
    indexedSelectionMethodsRemoved,
    userSelectedQueueRow: selectionAccepted,
    oldFallbackHeld: held,
    newerPlayOwnsQueue:
      newerPlay.clicked && beforeFailure.activeId === "album-c",
  };
  preconditions(
    check,
    "an unresolved queue-selection fallback cannot replace a newer Play",
    pre,
    retries.length === 0 &&
      JSON.stringify(afterFailure.queueIds) ===
        JSON.stringify(beforeFailure.queueIds) &&
      afterFailure.activeId === beforeFailure.activeId &&
      afterFailure.title === "Album Track C" &&
      !lateTransitions.some((item) =>
        ["setQueue", "selectIndex", "seekToTime", "play"].includes(item.type),
      ),
    { beforeFailure, afterFailure, retries, lateTransitions },
  );
  return { preconditions: pre, beforeFailure, afterFailure, retries };
}

async function parkedResume(page, check) {
  await fresh(page);
  await route(page, "#/album/album-1", ALBUM_TRACK_A_READY);
  const initial = await startRow(page, 0, "Album Track A");
  await fixtureCall(page, "emitPlaybackTime", [42]);
  const positionSaved = await waitFor(
    page,
    'document.querySelector(\'input[aria-label="Playback position"]\')?.getAttribute("aria-valuetext") === "0:42 of 3:00"',
  );
  const pauseAccepted = await page.evaluate(`return (() => {
    const nativeTimeout = window.setTimeout;
    window.__DEEP_TIMEOUT__ = nativeTimeout;
    window.setTimeout = (callback, delay, ...args) =>
      nativeTimeout(callback, delay === 60000 ? 100 : delay, ...args);
    const instance = window.MusicKit.getInstance();
    const originalStop = instance.stop.bind(instance);
    const audit = window.__DEEP_PARKED_STOP__ = { held: false, released: false };
    instance.stop = (...args) => {
      originalStop(...args);
      audit.held = true;
      return new Promise((resolve) => {
        audit.release = () => { audit.released = true; resolve(); };
      });
    };
    const pause = document.querySelector('.player-bar button[aria-label="Pause"]');
    if (!pause || pause.disabled) return false;
    pause.click();
    return true;
  })()`);
  await required(
    page,
    "window.__DEEP_PARKED_STOP__?.held === true",
    "Handoff stop was not held",
  );
  const stopHeld = await page.evaluate(
    "return window.__DEEP_PARKED_STOP__?.held === true;",
  );
  const resumeClicked = await page.evaluate(`return (() => {
    window.setTimeout = window.__DEEP_TIMEOUT__;
    const play = document.querySelector('.player-bar button[aria-label="Play"]');
    if (!play || play.disabled) return false;
    play.click();
    return true;
  })()`);
  await sleep(150);
  await route(page, "#/playlist/playlist-1", PLAYLIST_TRACK_A_READY);
  const newerPlay = await startRow(page, 0, "Track A");
  const beforeRelease = await state(page);
  const lateStart = beforeRelease.transitions.length;
  await page.evaluate("window.__DEEP_PARKED_STOP__.release(); return true;");
  await sleep(700);
  const afterRelease = await state(page);
  const lateTransitions = afterRelease.transitions.slice(lateStart);
  const staleActions = lateTransitions.filter((item) =>
    ["setQueue", "selectIndex", "seekToTime", "play", "pause"].includes(
      item.type,
    ),
  );
  const pre = {
    olderTrackStarted: initial.clicked && initial.state.activeId === "album-a",
    oldPositionWas42Seconds: positionSaved,
    pauseStartedHandoff: pauseAccepted,
    handoffStopHeld: stopHeld,
    parkedResumeRequested: resumeClicked,
    newerPlayOwnsQueue:
      newerPlay.clicked && beforeRelease.activeId === "song-a",
  };
  preconditions(
    check,
    "a parked resume waiting for stop cannot replace a newer Play or seek to its saved position",
    pre,
    JSON.stringify(afterRelease.queueIds) ===
      JSON.stringify(beforeRelease.queueIds) &&
      afterRelease.activeId === beforeRelease.activeId &&
      afterRelease.title === "Track A" &&
      !staleActions.some(
        (item) =>
          ["setQueue", "selectIndex", "play", "pause"].includes(item.type) ||
          (item.type === "seekToTime" && Number(item.seconds) === 42),
      ),
    { beforeRelease, afterRelease, staleActions, lateTransitions },
  );
  return { preconditions: pre, beforeRelease, afterRelease, staleActions };
}

async function staleQueueEdit(page, check) {
  await fresh(page);
  await route(page, "#/playlist/playlist-1", PLAYLIST_TRACK_A_READY);
  const initial = await startRow(page, 0, "Track A");
  await fixtureCall(page, "configure", [{ nativeQueueEdit: false }]);
  await page.evaluate(`if (!document.querySelector(".queue-drawer")) {
    document.querySelector('button[aria-label="Toggle Playing Next"]')?.click();
  }
  return true;`);
  await required(
    page,
    'document.querySelectorAll(".queue-drawer .queue-list > li").length === 6',
    "Six-song queue did not render",
  );
  const beforeEdit = await state(page);
  const removeAccepted = await page.evaluate(`return (() => {
    const instance = window.MusicKit.getInstance();
    ${QUEUE_IDS_FROM_OPTIONS}
    const original = instance.setQueue.bind(instance);
    const audit = window.__DEEP_QUEUE_EDIT__ = {
      held: false,
      released: false,
      heldIds: [],
      afterReject: [],
    };
    instance.setQueue = async (options) => {
      const ids = idsFromOptions(options);
      if (!audit.held) {
        audit.held = true;
        audit.heldIds = ids;
        await new Promise((_resolve, reject) => { audit.reject = reject; });
      }
      if (audit.released) audit.afterReject.push(ids);
      return original(options);
    };
    const row = document.querySelectorAll(".queue-drawer .queue-list > li")[3];
    const remove = row?.querySelector('[data-queue-action="remove"]');
    if (!remove || remove.disabled) return false;
    remove.click();
    return true;
  })()`);
  await required(
    page,
    "window.__DEEP_QUEUE_EDIT__?.held === true",
    "Upcoming-row queue rebuild was not held",
  );
  const heldEdit = await page.evaluate(`return {
    held: window.__DEEP_QUEUE_EDIT__?.held === true,
    ids: window.__DEEP_QUEUE_EDIT__?.heldIds ?? [],
  };`);
  await route(page, "#/album/album-1", ALBUM_TRACK_C_READY);
  const newerPlay = await startRow(page, 2, "Album Track C");
  const beforeFailure = await state(page);
  const lateStart = beforeFailure.transitions.length;
  await rejectHeld(page, "__DEEP_QUEUE_EDIT__", "song-duplicate");
  const afterFailure = await state(page);
  const afterRejectCalls = await page.evaluate(
    "return window.__DEEP_QUEUE_EDIT__?.afterReject ?? [];",
  );
  const lateTransitions = afterFailure.transitions.slice(lateStart);
  const staleActions = lateTransitions.filter((item) =>
    ["setQueue", "selectIndex", "seekToTime", "play", "pause"].includes(
      item.type,
    ),
  );
  const pre = {
    sixSongPlaylistStarted:
      initial.clicked &&
      JSON.stringify(beforeEdit.queueIds) ===
        JSON.stringify([
          "song-a",
          "song-duplicate",
          "song-c",
          "song-duplicate",
          "song-e",
          "song-f",
        ]) &&
      beforeEdit.activeId === "song-a",
    rebuildTierEnabled: beforeEdit.queueEdit?.native === false,
    removeUpcomingRowStarted:
      removeAccepted &&
      heldEdit.held &&
      JSON.stringify(heldEdit.ids) ===
        JSON.stringify([
          "song-a",
          "song-duplicate",
          "song-c",
          "song-e",
          "song-f",
        ]),
    newerPlayOwnsQueue:
      newerPlay.clicked && beforeFailure.activeId === "album-c",
  };
  preconditions(
    check,
    "an older queue-edit rebuild rejected with NOT_FOUND cannot reselect, seek, or play over a newer queue",
    pre,
    afterRejectCalls.length === 0 &&
      staleActions.length === 0 &&
      JSON.stringify(afterFailure.queueIds) ===
        JSON.stringify(beforeFailure.queueIds) &&
      afterFailure.activeId === beforeFailure.activeId &&
      afterFailure.title === "Album Track C",
    {
      beforeEdit,
      heldEdit,
      beforeFailure,
      afterFailure,
      afterRejectCalls,
      staleActions,
      lateTransitions,
    },
  );
  return {
    preconditions: pre,
    beforeEdit,
    heldEdit,
    beforeFailure,
    afterFailure,
    staleActions,
    afterRejectCalls,
  };
}

function readPins(pinsPath) {
  if (!fs.existsSync(pinsPath))
    return { exists: false, raw: null, value: null };
  const raw = fs.readFileSync(pinsPath, "utf8");
  return { exists: true, raw, value: JSON.parse(raw) };
}

function hasPin(snapshot, id) {
  return Boolean(snapshot.value?.pins?.some((pin) => pin.id === id));
}

function pinSaveFailureCount(logPath) {
  if (!fs.existsSync(logPath)) return 0;
  return (
    fs.readFileSync(logPath, "utf8").match(/Pinned playlists save failed:/gu)
      ?.length ?? 0
  );
}

async function waitForPins(pinsPath, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = readPins(pinsPath);
    if (predicate(snapshot)) return snapshot;
    await sleep(50);
  }
  return snapshot ?? readPins(pinsPath);
}

function removeOwnedEmptyDirectory(directory, owned) {
  if (!owned || !fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Owned pin fault path is no longer an empty directory");
  }
  if (fs.readdirSync(directory).length > 0) {
    throw new Error("Owned pin fault directory contains unexpected entries");
  }
  fs.rmdirSync(directory);
}

async function pinPersistence(page, check, dataDir, logDir, artifactDir) {
  await fresh(page);
  await route(page, "#/playlist/playlist-1", PLAYLIST_TRACK_A_READY);
  const buttonSelector =
    '[...document.querySelectorAll(".library-detail-hero button")].find((button) => ["Pin", "Unpin"].includes(button.textContent.trim()))';
  await required(page, buttonSelector, "Playlist pin control missing");
  let button = await page.evaluate(
    `return ${buttonSelector}?.textContent.trim() ?? null;`,
  );
  if (button === "Unpin") {
    await page.evaluate(`${buttonSelector}?.click(); return true;`);
    await required(
      page,
      `${buttonSelector}?.textContent.trim() === "Pin"`,
      "Existing test pin did not clear",
    );
  }
  button = await page.evaluate(
    `return ${buttonSelector}?.textContent.trim() ?? null;`,
  );
  const pinsPath = path.join(dataDir, "pins.json");
  const logPath = path.join(logDir, "arlet.log");
  const before = await waitForPins(
    pinsPath,
    (snapshot) => !hasPin(snapshot, "playlist-1"),
  );
  const cleanBefore = !hasPin(before, "playlist-1");
  const faultPath = path.join(dataDir, "pins.json.tmp");
  if (fs.existsSync(faultPath)) {
    throw new Error(
      "Pin temporary path is already occupied; fault not installed",
    );
  }
  fs.mkdirSync(faultPath);
  const faultOwned = true;
  let failedSave;
  try {
    const failureCountBefore = pinSaveFailureCount(logPath);
    await page.evaluate(`${buttonSelector}?.click(); return true;`);
    const deadline = Date.now() + 5000;
    let failureCountAfter = pinSaveFailureCount(logPath);
    while (failureCountAfter <= failureCountBefore && Date.now() < deadline) {
      await sleep(50);
      failureCountAfter = pinSaveFailureCount(logPath);
    }
    const visibleError = await waitFor(
      page,
      'Boolean(document.querySelector(".action-toast:not(.action-toast-success) .action-toast-message"))',
      5000,
    );
    const ui = await page.evaluate(`return (() => ({
      button: ${buttonSelector}?.textContent.trim() ?? null,
      errors: [...document.querySelectorAll(".action-toast:not(.action-toast-success) .action-toast-message")]
        .map((node) => node.textContent?.trim() ?? ""),
    }))()`);
    const after = readPins(pinsPath);
    failedSave = {
      before,
      after,
      ui,
      failureCountBefore,
      failureCountAfter,
      nativeFailureObserved: failureCountAfter > failureCountBefore,
      visibleError,
    };
    const pre = {
      pinControlWasReady: button === "Pin",
      persistedPinWasAbsent: cleanBefore,
      nativeFaultWasInstalled: fs.existsSync(faultPath),
      saveFailureWasLogged: failureCountAfter > failureCountBefore,
    };
    preconditions(
      check,
      "a failed native pin save shows an error and leaves persisted pins unchanged",
      pre,
      visibleError &&
        ui.errors.some((message) =>
          message.toLowerCase().includes("could not be saved"),
        ) &&
        before.raw === after.raw &&
        !hasPin(after, "playlist-1"),
      failedSave,
    );
    await saveScreenshot(
      page,
      artifactDir,
      "screenshot-deep-regressions-pins-error.png",
    );
  } finally {
    removeOwnedEmptyDirectory(faultPath, faultOwned);
  }

  const afterFailedReload = await fresh(page);
  await route(page, "#/playlist/playlist-1", PLAYLIST_TRACK_A_READY);
  const unpinnedAfterReload =
    (await page.evaluate(
      `return ${buttonSelector}?.textContent.trim() ?? null;`,
    )) === "Pin";
  await page.evaluate(`${buttonSelector}?.click(); return true;`);
  const recoveryDeadline = Date.now() + 5000;
  const recovered = await waitForPins(
    pinsPath,
    (snapshot) => hasPin(snapshot, "playlist-1"),
    recoveryDeadline - Date.now(),
  );
  const afterRecoveryReload = await fresh(page);
  await route(page, "#/playlist/playlist-1", PLAYLIST_TRACK_A_READY);
  const pinnedAfterReload =
    (await page.evaluate(
      `return ${buttonSelector}?.textContent.trim() ?? null;`,
    )) === "Unpin";
  const recoveryPre = {
    failedSaveLeftDiskUnchanged:
      failedSave?.before.raw === failedSave?.after.raw,
    faultPathRemoved: !fs.existsSync(faultPath),
    failedPinAbsentAfterReload: unpinnedAfterReload,
    laterPinWritePersisted: hasPin(recovered, "playlist-1"),
  };
  preconditions(
    check,
    "pin persistence recovers after removing the owned fault path and survives reload",
    recoveryPre,
    pinnedAfterReload,
    {
      failedSave,
      afterFailedReload,
      recovered,
      afterRecoveryReload,
      pinnedAfterReload,
    },
  );
  return {
    failedSave,
    afterFailedReload,
    unpinnedAfterReload,
    recovered,
    afterRecoveryReload,
    pinnedAfterReload,
  };
}

function writeObservations(artifactDir, results) {
  fs.writeFileSync(
    path.join(artifactDir, "deep-regressions-observations.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
}

export async function runDeepRegressions({
  page,
  check,
  artifactDir,
  dataDir,
  logDir,
}) {
  fs.mkdirSync(artifactDir, { recursive: true });
  const results = {};
  const cases = [
    ["stale-play-next", (p, c) => stalePlayNext(p, c)],
    ["stale-queue-selection", (p, c) => staleQueueSelection(p, c)],
    ["parked-resume", (p, c) => parkedResume(p, c)],
    ["stale-queue-edit", (p, c) => staleQueueEdit(p, c)],
    [
      "pin-persistence",
      (p, c) => pinPersistence(p, c, dataDir, logDir, artifactDir),
    ],
  ];
  for (const [name, run] of cases) {
    try {
      results[name] = await run(page, check);
    } catch (error) {
      results[name] = { setupError: String(error?.message ?? error) };
      check(`deep regressions: ${name} completes`, false, results[name]);
    } finally {
      try {
        await saveScreenshot(
          page,
          artifactDir,
          `screenshot-deep-regressions-${name}.png`,
        );
      } catch (error) {
        results[name] ??= {};
        results[name].screenshotError = String(error?.message ?? error);
      }
      writeObservations(artifactDir, results);
      if (name !== "pin-persistence") {
        try {
          await fresh(page);
        } catch (error) {
          results[name].reloadError = String(error?.message ?? error);
          writeObservations(artifactDir, results);
          check(`deep regressions: ${name} reloads a healthy fixture`, false, {
            error: results[name].reloadError,
          });
        }
      }
    }
  }
  const final = await fresh(page);
  check(
    "deep regressions end with a healthy signed-in fixture",
    final.authorized &&
      final.status.includes("Connected") &&
      !final.expiredNotice,
    final,
  );
  results.final = final;
  writeObservations(artifactDir, results);
}
