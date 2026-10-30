import fs from "node:fs";
import path from "node:path";
import { fixtureCall, sleep, waitFor as pollFor } from "./e2e-helpers.js";

const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const TITLE =
  'document.querySelector(".player-bar .player-track-copy strong")?.textContent';
const ALBUM_IDS = ["album-a", "album-b", "album-c", "album-d"];
const PLAYLIST_IDS = [
  "song-a",
  "song-duplicate",
  "song-c",
  "song-duplicate",
  "song-e",
  "song-f",
];
const q = (value) => JSON.stringify(value);
const waitFor = (page, expression, timeoutMs = 15000) =>
  pollFor(page, expression, timeoutMs, 50);

async function required(page, expression, message, timeoutMs = 15000) {
  if (!(await waitFor(page, expression, timeoutMs))) throw new Error(message);
}

function gatedCheck(check, name, preconditions, passed, observation) {
  const names = Object.keys(preconditions);
  const met = names.filter((key) => preconditions[key] === true).length;
  const gatesPassed = met === names.length;
  check(name, gatesPassed && passed, {
    preconditions,
    preconditionsMet: met,
    expectedPreconditions: names.length,
    observation,
  });
}

async function fresh(page) {
  await fixtureCall(page, "reset");
  await page.send("Page.reload", { ignoreCache: true });
  await required(
    page,
    FIXTURE + " && document.querySelector('.app-shell .player-bar')",
    "Fixture reload failed",
    30000,
  );
  await required(
    page,
    'document.querySelector(".titlebar-status")?.textContent.includes("Connected")',
    "Fixture did not start connected",
  );
}

async function route(page, hash, heading, rowTitle) {
  await page.evaluate("location.hash = " + q(hash) + "; return true;");
  let ready =
    'document.querySelector(".library-detail-hero h1")?.textContent.trim() === ' +
    q(heading);
  if (rowTitle) {
    ready +=
      ' && [...document.querySelectorAll(".library-track-row")].some((row) => row.textContent.includes(' +
      q(rowTitle) +
      "))";
  }
  await required(page, ready, "Route not ready: " + hash);
}

async function state(page) {
  return page.evaluate(
    [
      "const snapshot = " + FIXTURE + ".snapshot();",
      "const music = window.MusicKit.getInstance();",
      "const queue = snapshot.queue;",
      "return {",
      "  title: " + TITLE + " ?? null,",
      "  queueIds: queue.items.map((item) => item.id),",
      "  queueIndex: queue.index,",
      "  activeId: queue.activeId,",
      "  shuffle: snapshot.modes.shuffle,",
      "  queueEdit: snapshot.queueEdit,",
      "  playing: music.playbackState === window.MusicKit.PlaybackStates.playing,",
      "  providerState: music.playbackState,",
      '  playButton: document.querySelector(".player-bar .play-button")?.getAttribute("aria-label"),',
      "  transitions: snapshot.transitions,",
      "};",
    ].join("\n"),
  );
}

async function startRow(page, index, title) {
  const accepted = await page.evaluate(
    [
      "const row = document.querySelectorAll('.library-track-row')[" +
        index +
        "];",
      "if (!row) return false;",
      "row.click();",
      "return true;",
    ].join("\n"),
  );
  await required(
    page,
    TITLE + " === " + q(title),
    "Track did not start: " + title,
  );
  return { accepted, state: await state(page) };
}

async function clickPlayerToggle(page) {
  const accepted = await page.evaluate(
    [
      'const button = document.querySelector(".player-bar .play-button");',
      "if (!button || button.disabled) return false;",
      "button.click();",
      "return true;",
    ].join("\n"),
  );
  if (!accepted) throw new Error("Player toggle was unavailable");
  return accepted;
}

async function saveScreenshot(page, artifactDir, name) {
  const result = await page.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(
    path.join(artifactDir, name),
    Buffer.from(result.data, "base64"),
  );
}

async function pauseDuringPendingResume(page, check) {
  await fresh(page);
  await route(page, "#/album/album-1", "Fixture Album", "Album Track A");
  const initial = await startRow(page, 0, "Album Track A");
  await fixtureCall(page, "emitPlaybackTime", [42]);
  const positionSaved = await waitFor(
    page,
    'document.querySelector(\'input[aria-label="Playback position"]\')?.getAttribute("aria-valuetext") === "0:42 of 3:00"',
  );
  const installHold = await page.evaluate(
    [
      "const music = window.MusicKit.getInstance();",
      "const nativeTimeout = window.setTimeout;",
      "const originalStop = music.stop.bind(music);",
      "const audit = window.__HANDOFF_STOP__ = { held: false, released: false, stopCalls: 0 };",
      "window.__HANDOFF_TIMEOUT__ = nativeTimeout;",
      "window.setTimeout = (callback, delay, ...args) =>",
      "  nativeTimeout(callback, delay === 60000 ? 100 : delay, ...args);",
      "music.stop = (...args) => {",
      "  audit.stopCalls += 1;",
      "  originalStop(...args);",
      "  audit.held = true;",
      "  return new Promise((resolve) => {",
      "    audit.release = () => { audit.released = true; resolve(); };",
      "  });",
      "};",
      "audit.originalStop = originalStop;",
      'const button = document.querySelector(".player-bar .play-button");',
      'if (!button || button.getAttribute("aria-label") !== "Pause" || button.disabled) return false;',
      "button.click();",
      "return true;",
    ].join("\n"),
  );
  try {
    await required(
      page,
      "window.__HANDOFF_STOP__?.held === true",
      "Real provider stop was not held after the queue was parked",
    );
    const stopHeld = await page.evaluate(
      [
        "const audit = window.__HANDOFF_STOP__;",
        "return {",
        "  held: audit?.held === true,",
        "  released: audit?.released === true,",
        "  stopCalls: audit?.stopCalls ?? 0,",
        "  providerStopped: window.MusicKit.getInstance().playbackState === window.MusicKit.PlaybackStates.stopped,",
        "};",
      ].join("\n"),
    );
    await page.evaluate(
      "window.setTimeout = window.__HANDOFF_TIMEOUT__; return true;",
    );
    const beforeFirstPlay = await state(page);
    const firstPlayAccepted = await clickPlayerToggle(page);
    await sleep(150);
    const firstPlayPending = await page.evaluate(
      [
        "const audit = window.__HANDOFF_STOP__;",
        "const snapshot = " + FIXTURE + ".snapshot();",
        "const music = window.MusicKit.getInstance();",
        "return {",
        "  stopStillHeld: audit?.held === true && audit?.released === false,",
        "  providerStillStopped: music.playbackState === window.MusicKit.PlaybackStates.stopped,",
        "  noAudioStart: !snapshot.transitions.slice(" +
          beforeFirstPlay.transitions.length +
          ').some((item) => item.type === "play"),',
        "};",
      ].join("\n"),
    );
    const beforeSecondToggle = await state(page);
    const secondToggleAccepted = await clickPlayerToggle(page);
    const secondPauseRecorded = await waitFor(
      page,
      FIXTURE +
        ".snapshot().transitions.slice(" +
        beforeSecondToggle.transitions.length +
        ').some((item) => item.type === "pause")',
    );
    const afterSecondPause = await state(page);
    const transitionStart = afterSecondPause.transitions.length;
    await page.evaluate("window.__HANDOFF_STOP__?.release?.(); return true;");
    await sleep(1000);
    const afterStopRelease = await state(page);
    const releaseTransitions =
      afterStopRelease.transitions.slice(transitionStart);
    const staleResumeActions = releaseTransitions.filter((item) =>
      ["setQueue", "selectIndex", "seekToTime", "play"].includes(item.type),
    );
    const noPlayAfterRelease = !releaseTransitions.some(
      (item) => item.type === "play",
    );
    const beforeFreshPlay = await state(page);
    const freshPlayAccepted = await clickPlayerToggle(page);
    const freshPlayCondition = [
      FIXTURE + ".snapshot().queue.activeId === " + q("album-a"),
      FIXTURE + ".snapshot().queue.index === 0",
      "JSON.stringify(" +
        FIXTURE +
        ".snapshot().queue.items.map((item) => item.id)) === " +
        q(JSON.stringify(ALBUM_IDS)),
      "window.MusicKit.getInstance().playbackState === window.MusicKit.PlaybackStates.playing",
      'document.querySelector(\'input[aria-label="Playback position"]\')?.getAttribute("aria-valuetext") === "0:42 of 3:00"',
    ].join(" && ");
    const freshPlayReady = await waitFor(page, freshPlayCondition, 15000);
    const afterFreshPlay = await state(page);
    const freshPlayTransitions = afterFreshPlay.transitions.slice(
      beforeFreshPlay.transitions.length,
    );
    const savedPositionApplied = freshPlayTransitions.some(
      (item) => item.type === "seekToTime" && Number(item.seconds) === 42,
    );
    const observation = {
      initial: initial.state,
      positionSaved,
      installHold,
      stopHeld,
      beforeFirstPlay,
      firstPlayAccepted,
      firstPlayPending,
      beforeSecondToggle,
      secondToggleAccepted,
      secondPauseRecorded,
      afterSecondPause,
      afterStopRelease,
      releaseTransitions,
      staleResumeActions,
      noPlayAfterRelease,
      beforeFreshPlay,
      freshPlayAccepted,
      freshPlayReady,
      afterFreshPlay,
      freshPlayTransitions,
      savedPositionApplied,
    };
    gatedCheck(
      check,
      "a second Pause during a parked resume wait blocks audio and a later Play resumes the saved queue",
      {
        albumTrackStarted:
          initial.accepted &&
          initial.state.activeId === "album-a" &&
          JSON.stringify(initial.state.queueIds) === JSON.stringify(ALBUM_IDS),
        savedPositionWas42Seconds: positionSaved,
        handoffPauseAccepted: installHold,
        realStopHeldAfterParking:
          stopHeld.held &&
          !stopHeld.released &&
          stopHeld.stopCalls === 1 &&
          stopHeld.providerStopped,
        firstPlayAccepted: firstPlayAccepted,
        firstPlayRemainedPending:
          firstPlayPending.stopStillHeld &&
          firstPlayPending.providerStillStopped &&
          firstPlayPending.noAudioStart,
        secondToggleAccepted: secondToggleAccepted,
        secondToggleWasPause: secondPauseRecorded,
      },
      noPlayAfterRelease &&
        staleResumeActions.length === 0 &&
        !afterStopRelease.playing &&
        freshPlayAccepted &&
        freshPlayReady &&
        afterFreshPlay.playing &&
        afterFreshPlay.title === "Album Track A" &&
        afterFreshPlay.activeId === "album-a" &&
        afterFreshPlay.queueIndex === 0 &&
        JSON.stringify(afterFreshPlay.queueIds) === JSON.stringify(ALBUM_IDS) &&
        savedPositionApplied,
      observation,
    );
    return observation;
  } finally {
    try {
      await page.evaluate(
        [
          "const audit = window.__HANDOFF_STOP__;",
          "if (audit?.release && !audit.released) audit.release();",
          "const music = window.MusicKit?.getInstance?.();",
          "if (music && audit?.originalStop) music.stop = audit.originalStop;",
          "if (window.__HANDOFF_TIMEOUT__) window.setTimeout = window.__HANDOFF_TIMEOUT__;",
          "return true;",
        ].join("\n"),
      );
    } catch {}
  }
}

async function installHeldQueueEdit(page, key) {
  const source = [
    "return (() => {",
    "  const music = window.MusicKit.getInstance();",
    "  const original = music.setQueue.bind(music);",
    "  const idsFromOptions = (options) => {",
    "    const ids = [];",
    "    if (Array.isArray(options?.items)) ids.push(...options.items.map((item) => String(item?.id)));",
    '    for (const key of ["songs", "musicVideos"]) {',
    "      if (Array.isArray(options?.[key])) ids.push(...options[key].map(String));",
    "    }",
    "    return ids;",
    "  };",
    "  const audit = window[" +
      q(key) +
      "] = { held: false, rejected: false, heldOptions: null, replacements: [], postReject: [], originalSetQueue: original };",
    "  music.setQueue = async (options) => {",
    "    const call = { ids: idsFromOptions(options), startWith: options?.startWith, shuffle: music.player.shuffle === true };",
    "    if (!audit.held) {",
    "      audit.held = true;",
    "      audit.heldOptions = call;",
    "      await new Promise((_resolve, reject) => { audit.reject = reject; });",
    "    } else if (audit.rejected) {",
    "      audit.postReject.push(call);",
    "    } else {",
    "      audit.replacements.push(call);",
    "    }",
    "    return original(options);",
    "  };",
    '  const remove = document.querySelectorAll(".queue-drawer .queue-list > li")[3]?.querySelector(\'[data-queue-action="remove"]\');',
    "  if (!remove || remove.disabled) return false;",
    "  remove.click();",
    "  return true;",
    "})()",
  ].join("\n");
  return page.evaluate(source);
}

async function heldQueueEditObservation(page, key) {
  return page.evaluate(
    [
      "const audit = window[" + q(key) + "];",
      "return {",
      "  held: audit?.held === true,",
      "  heldOptions: audit?.heldOptions ?? null,",
      "  replacements: audit?.replacements ?? [],",
      "  postReject: audit?.postReject ?? [],",
      "};",
    ].join("\n"),
  );
}

async function rejectQueueEdit(page, key) {
  const released = await page.evaluate(
    [
      "const audit = window[" + q(key) + "];",
      "if (!audit?.reject) return false;",
      "const error = new Error('One or more items could not be resolved: song-duplicate');",
      'error.errorCode = "NOT_FOUND";',
      'error.data = [{ id: "song-duplicate" }];',
      "audit.rejected = true;",
      "audit.reject(error);",
      "return true;",
    ].join("\n"),
  );
  if (!released) throw new Error("Held queue edit could not be rejected");
}

async function clickShuffle(page, expectedPressed) {
  const source = [
    "const button = document.querySelector('button[aria-label=\"Toggle shuffle\"]');",
    "if (!button || button.getAttribute('aria-pressed') !== " +
      q(expectedPressed ? "true" : "false") +
      ") return false;",
    "button.click();",
    "return true;",
  ].join("\n");
  return page.evaluate(source);
}

async function shuffleRebuild(page, check, turnOff) {
  const key = turnOff ? "__HANDOFF_SHUFFLE_OFF__" : "__HANDOFF_SHUFFLE_ON__";
  await fresh(page);
  await route(page, "#/playlist/playlist-1", "Fixture Playlist", "Track A");
  const initial = await startRow(page, 0, "Track A");
  await fixtureCall(page, "configure", [{ nativeQueueEdit: false }]);
  const beforeShuffle = await state(page);
  const shuffleTurnedOn =
    beforeShuffle.shuffle || (await clickShuffle(page, false));
  await required(
    page,
    FIXTURE + ".snapshot().modes.shuffle === true",
    "Shuffle did not turn on",
  );
  const beforeEdit = await state(page);
  await page.evaluate(
    'if (!document.querySelector(".queue-drawer")) document.querySelector(\'button[aria-label="Toggle Playing Next"]\')?.click(); return true;',
  );
  const queueDrawerReady = await waitFor(
    page,
    'document.querySelectorAll(".queue-drawer .queue-list > li").length === 6',
  );
  if (!queueDrawerReady)
    throw new Error("Six-song queue drawer did not render");
  const installed = await installHeldQueueEdit(page, key);
  await required(
    page,
    "window[" + q(key) + "]?.held === true",
    "Queue edit was not held at the provider boundary",
  );
  const duringEdit = await state(page);
  const heldEdit = await heldQueueEditObservation(page, key);
  await route(page, "#/album/album-1", "Fixture Album", "Album Track C");
  const newerPlay = await startRow(page, 2, "Album Track C");
  const beforeReject = await state(page);
  const replacementBeforeReject = await heldQueueEditObservation(page, key);
  let explicitOffAccepted = true;
  let modeOffBeforeReject = false;
  let pressedBeforeOff = null;
  if (turnOff) {
    pressedBeforeOff = await page.evaluate(
      'return document.querySelector(\'button[aria-label="Toggle shuffle"]\')?.getAttribute("aria-pressed") ?? null;',
    );
    explicitOffAccepted =
      pressedBeforeOff === "true" && (await clickShuffle(page, true));
    if (explicitOffAccepted) {
      modeOffBeforeReject = await waitFor(
        page,
        FIXTURE + ".snapshot().modes.shuffle === false",
      );
    }
  }
  const beforeFailure = await state(page);
  await rejectQueueEdit(page, key);
  await sleep(700);
  const afterReject = await state(page);
  const heldAfterReject = await heldQueueEditObservation(page, key);
  const replacementOptionsContainWholeAlbum =
    replacementBeforeReject.replacements.some(
      (call) => JSON.stringify(call.ids) === JSON.stringify(ALBUM_IDS),
    );
  const replacementQueueIsWholeAlbum =
    JSON.stringify(beforeReject.queueIds) === JSON.stringify(ALBUM_IDS);
  const observation = {
    initial: initial.state,
    installed,
    beforeEdit,
    queueDrawerReady,
    duringEdit,
    heldEdit,
    newerPlay: newerPlay.state,
    replacementBeforeReject,
    beforeReject,
    pressedBeforeOff,
    explicitOffAccepted,
    modeOffBeforeReject,
    beforeFailure,
    afterReject,
    heldAfterReject,
    replacementOptionsContainWholeAlbum,
    replacementQueueIsWholeAlbum,
  };
  const replacementOwnsQueue =
    newerPlay.accepted &&
    beforeReject.title === "Album Track C" &&
    beforeReject.activeId === "album-c" &&
    beforeReject.queueIndex === 2 &&
    replacementQueueIsWholeAlbum &&
    replacementOptionsContainWholeAlbum;
  const finalMode = turnOff ? !afterReject.shuffle : afterReject.shuffle;
  gatedCheck(
    check,
    turnOff
      ? "an explicit Shuffle off after a newer Play survives an older rejected queue edit"
      : "a rejected queue rebuild retains Shuffle and a newer Play's whole small album",
    {
      sixSongPlaylistStarted:
        initial.accepted &&
        initial.state.activeId === "song-a" &&
        JSON.stringify(initial.state.queueIds) === JSON.stringify(PLAYLIST_IDS),
      shuffleWasOnBeforeEdit: shuffleTurnedOn && beforeEdit.shuffle,
      rebuildTierEnabled: beforeEdit.queueEdit?.native === false,
      editWasHeld: installed && heldEdit.held,
      editTemporarilyDisabledShuffle: duringEdit.shuffle === false,
      oldEditHadExpectedRemoval:
        JSON.stringify(heldEdit.heldOptions?.ids) ===
        JSON.stringify([
          "song-a",
          "song-duplicate",
          "song-c",
          "song-e",
          "song-f",
        ]),
      newerAlbumTrackCPlayOwnsWholeQueue: replacementOwnsQueue,
      explicitUserOffWasAccepted: explicitOffAccepted,
      explicitUserOffReachedProvider: !turnOff || modeOffBeforeReject,
    },
    replacementOwnsQueue &&
      finalMode &&
      heldAfterReject.postReject.length === 0 &&
      afterReject.title === "Album Track C" &&
      afterReject.activeId === "album-c" &&
      afterReject.queueIndex === 2 &&
      JSON.stringify(afterReject.queueIds) === JSON.stringify(ALBUM_IDS),
    observation,
  );
  return observation;
}

function lstatOwnedFile(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function snapshotOwnedFile(file) {
  const stat = lstatOwnedFile(file);
  if (!stat) return { exists: false, base64: null, bytes: 0 };
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Settings path is not an owned regular file: " + file);
  }
  const contents = fs.readFileSync(file);
  return {
    exists: true,
    base64: contents.toString("base64"),
    bytes: contents.length,
  };
}

function restoreOwnedFile(file, snapshot) {
  const current = lstatOwnedFile(file);
  if (current && (!current.isFile() || current.isSymbolicLink())) {
    throw new Error("Settings path changed during fault: " + file);
  }
  if (snapshot.exists) {
    fs.writeFileSync(file, Buffer.from(snapshot.base64, "base64"));
    return;
  }
  if (!current) return;
  fs.unlinkSync(file);
}

function removeOwnedFile(file) {
  const current = lstatOwnedFile(file);
  if (!current) return;
  if (!current.isFile() || current.isSymbolicLink()) {
    throw new Error("Settings fault path is not a regular owned file: " + file);
  }
  fs.unlinkSync(file);
}

function fileMatchesSnapshot(file, snapshot) {
  const current = snapshotOwnedFile(file);
  return (
    current.exists === snapshot.exists &&
    current.base64 === snapshot.base64 &&
    current.bytes === snapshot.bytes
  );
}

function parseSettingsResult(raw) {
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function settingsRenderer(page, theme, volume) {
  await page.evaluate('location.hash = "#/settings"; return true;');
  await required(
    page,
    [
      "document.querySelector('.settings-section[aria-labelledby=\"appearance-heading\"] select')?.value === " +
        q(theme),
      "Math.abs(Number(document.querySelector('.player-bar input[aria-label=\"Volume\"]')?.value) - " +
        volume +
        ") < 0.005",
      "Math.abs(Number(" +
        FIXTURE +
        ".snapshot().volume) - " +
        volume +
        ") < 0.005",
      "document.documentElement.getAttribute('data-theme') === " +
        q(theme === "system" ? null : theme),
    ].join(" && "),
    "Renderer did not apply the loaded theme and volume",
  );
  return page
    .evaluate(
      [
        "const theme = document.querySelector('.settings-section[aria-labelledby=\"appearance-heading\"] select');",
        "const volumeInput = document.querySelector('.player-bar input[aria-label=\"Volume\"]');",
        "return {",
        "  theme: theme?.value ?? null,",
        "  rootTheme: document.documentElement.getAttribute('data-theme'),",
        "  colorScheme: getComputedStyle(document.documentElement).colorScheme,",
        "  volume: Number(volumeInput?.value),",
        "  volumeText: volumeInput?.getAttribute('aria-valuetext') ?? null,",
        "  providerVolume: window.__ARLET_E2E_MUSIC__.snapshot().volume,",
        "};",
      ].join("\n"),
    )
    .then((displayed) => ({
      ...displayed,
      matchesExpected:
        displayed.theme === theme &&
        Math.abs(displayed.volume - volume) < 0.005 &&
        Math.abs(displayed.providerVolume - volume) < 0.005 &&
        displayed.rootTheme === (theme === "system" ? null : theme),
    }));
}

async function nativeSettingsFallback(
  page,
  check,
  dataDir,
  artifactDir,
  name,
  fault,
) {
  await fresh(page);
  const ownedRoot = path.resolve(dataDir);
  const primary = path.join(ownedRoot, "settings.json");
  const backup = path.join(ownedRoot, "settings.json.bak");
  if (
    path.dirname(path.resolve(primary)) !== ownedRoot ||
    path.dirname(path.resolve(backup)) !== ownedRoot
  ) {
    throw new Error("Settings fault path escaped the owned data directory");
  }
  const original = {
    primary: snapshotOwnedFile(primary),
    backup: snapshotOwnedFile(backup),
  };
  const setup = {
    ownedDataDirectory: path.resolve(path.dirname(primary)) === ownedRoot,
    originalMainAndBackupCaptured: true,
  };
  if (Object.values(setup).some((value) => value !== true)) {
    gatedCheck(check, "handoff settings " + name + " setup", setup, false, {
      original,
    });
    throw new Error("Settings fault preconditions were not met");
  }

  let loaded;
  let native;
  let displayed;
  let bytesPreservedDuringLoad = false;
  let bytesPreservedAfterReload = false;
  let originalRestored = false;
  let restoreReloadError;
  let screenshotSaved = false;
  let faultBytes;
  try {
    if (fault === "valid-backup") {
      faultBytes = Buffer.from(
        JSON.stringify({
          theme: "dark",
          volume: 0.42,
          _audit3_backup_marker: "valid-backup",
        }),
        "utf8",
      );
      fs.writeFileSync(backup, faultBytes);
      removeOwnedFile(primary);
    } else if (fault === "missing-both") {
      removeOwnedFile(primary);
      removeOwnedFile(backup);
    } else if (fault === "invalid-backup") {
      faultBytes = Buffer.from("{ invalid backup json", "utf8");
      fs.writeFileSync(backup, faultBytes);
      removeOwnedFile(primary);
    } else {
      throw new Error("Unknown settings fault: " + fault);
    }
    const raw = await page.evaluate(
      "return await window.__TAURI_INTERNALS__.invoke('load_settings');",
    );
    loaded = raw;
    native = parseSettingsResult(raw);
    bytesPreservedDuringLoad =
      fault === "valid-backup" || fault === "invalid-backup"
        ? !lstatOwnedFile(primary) &&
          snapshotOwnedFile(backup).base64 === faultBytes.toString("base64")
        : !lstatOwnedFile(primary) && !lstatOwnedFile(backup);
    await fresh(page);
    displayed =
      fault === "valid-backup"
        ? await settingsRenderer(page, "dark", 0.42)
        : await settingsRenderer(page, "system", 1);
    bytesPreservedAfterReload =
      fault === "valid-backup" || fault === "invalid-backup"
        ? !lstatOwnedFile(primary) &&
          snapshotOwnedFile(backup).base64 === faultBytes.toString("base64")
        : !lstatOwnedFile(primary) && !lstatOwnedFile(backup);
    await saveScreenshot(
      page,
      artifactDir,
      "screenshot-handoff-settings-regressions-" + name + ".png",
    );
    screenshotSaved = true;
  } finally {
    try {
      restoreOwnedFile(primary, original.primary);
    } finally {
      restoreOwnedFile(backup, original.backup);
    }
    originalRestored =
      fileMatchesSnapshot(primary, original.primary) &&
      fileMatchesSnapshot(backup, original.backup);
    try {
      await fresh(page);
    } catch (error) {
      restoreReloadError = String(error?.message ?? error);
    }
  }

  const validBackup = fault === "valid-backup";
  const nativeExpected = validBackup
    ? native?.theme === "dark" &&
      native?.volume === 0.42 &&
      native?._audit3_backup_marker === "valid-backup"
    : Object.keys(native ?? {}).length === 0;
  const observation = {
    name,
    fault,
    original,
    faultBytes: faultBytes?.toString("base64") ?? null,
    loaded,
    native,
    displayed,
    bytesPreservedDuringLoad,
    bytesPreservedAfterReload,
    originalRestored,
    restoreReloadError: restoreReloadError ?? null,
    screenshotSaved,
  };
  gatedCheck(
    check,
    "handoff settings " +
      name +
      " uses the native loader and preserves owned files",
    setup,
    nativeExpected &&
      displayed?.matchesExpected === true &&
      bytesPreservedDuringLoad &&
      bytesPreservedAfterReload &&
      originalRestored &&
      !restoreReloadError &&
      screenshotSaved,
    observation,
  );
  return observation;
}

function writeObservations(artifactDir, results) {
  fs.writeFileSync(
    path.join(artifactDir, "handoff-settings-regressions-observations.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
}

export async function runHandoffSettingsRegressions({
  page,
  check,
  artifactDir,
  dataDir,
}) {
  fs.mkdirSync(artifactDir, { recursive: true });
  const results = {};
  const cases = [
    ["pause-during-pending-resume", (p, c) => pauseDuringPendingResume(p, c)],
    ["shuffle-rebuild-retains-mode", (p, c) => shuffleRebuild(p, c, false)],
    ["shuffle-explicit-off-wins", (p, c) => shuffleRebuild(p, c, true)],
    [
      "settings-missing-primary",
      (p, c) =>
        nativeSettingsFallback(
          p,
          c,
          dataDir,
          artifactDir,
          "settings-missing-primary",
          "valid-backup",
        ),
    ],
    [
      "settings-missing-both",
      (p, c) =>
        nativeSettingsFallback(
          p,
          c,
          dataDir,
          artifactDir,
          "settings-missing-both",
          "missing-both",
        ),
    ],
    [
      "settings-invalid-backup",
      (p, c) =>
        nativeSettingsFallback(
          p,
          c,
          dataDir,
          artifactDir,
          "settings-invalid-backup",
          "invalid-backup",
        ),
    ],
  ];

  for (const [name, run] of cases) {
    try {
      results[name] = await run(page, check);
    } catch (error) {
      results[name] = { setupError: String(error?.message ?? error) };
      check("handoff settings regressions: " + name + " completes", false, {
        preconditions: { scenarioSetupCompleted: false },
        ...results[name],
      });
    } finally {
      const screenshotName =
        "screenshot-handoff-settings-regressions-" + name + ".png";
      if (!fs.existsSync(path.join(artifactDir, screenshotName))) {
        try {
          await saveScreenshot(page, artifactDir, screenshotName);
        } catch (error) {
          results[name] ??= {};
          results[name].screenshotError = String(error?.message ?? error);
        }
      }
      writeObservations(artifactDir, results);
      if (name.startsWith("shuffle-")) {
        const key =
          name === "shuffle-explicit-off-wins"
            ? "__HANDOFF_SHUFFLE_OFF__"
            : "__HANDOFF_SHUFFLE_ON__";
        try {
          await page.evaluate(
            [
              "const audit = window[" + q(key) + "];",
              "if (audit?.reject && !audit.rejected) {",
              "  audit.rejected = true;",
              "  audit.reject(new Error('E2E cleanup'));",
              "}",
              "if (window.MusicKit?.getInstance) {",
              "  const music = window.MusicKit.getInstance();",
              "  if (audit?.originalSetQueue) music.setQueue = audit.originalSetQueue;",
              "}",
              "return true;",
            ].join("\n"),
          );
        } catch {}
      }
      if (!name.startsWith("settings-")) {
        try {
          await fresh(page);
        } catch (error) {
          results[name].reloadError = String(error?.message ?? error);
          writeObservations(artifactDir, results);
          check(
            "handoff settings regressions: " +
              name +
              " reloads a healthy fixture",
            false,
            {
              preconditions: { scenarioCompleted: true },
              error: results[name].reloadError,
            },
          );
        }
      }
    }
  }

  await fresh(page);
  const finalState = await state(page);
  const finalConnected = await page.evaluate(
    'return window.__ARLET_E2E_MUSIC__.snapshot().authorized && document.querySelector(".titlebar-status")?.textContent.includes("Connected") && !document.querySelector(".session-expired-notice")',
  );
  gatedCheck(
    check,
    "handoff settings regressions end with a healthy connected fixture",
    {
      finalFixtureConnected: finalConnected,
      finalProviderNotPlaying: !finalState.playing,
    },
    true,
    finalState,
  );
  results.final = finalState;
  writeObservations(artifactDir, results);
}
