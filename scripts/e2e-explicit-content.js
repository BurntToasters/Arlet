// Explicit content: the Settings choice (Auto, Clean, Allow) and the Advanced
// fix that offers Allow. MusicKit drops explicit songs from queues while its
// restriction is on, so the fixture's queue shows what each choice does. The
// fixture also stores MusicKit's restriction (localStorage itre), which Arlet
// must leave as Apple reported it.
//
// The sign-in and sign-out checks cover MusicKit's latch: the public
// restrictedEnabled setter stays latched for the page session, so Arlet must
// not write it while signed out, must apply a saved Allow after a same-account
// sign-in, and must restart the process on sign-out after an override. The
// CONTENT_RESTRICTED failure text is checked in the auto-skip notice and the
// player bar. Every check here lives in this scenario, not account-session.

import fs from "node:fs";
import path from "node:path";
import { fixtureCall, sleep, waitFor } from "./e2e-helpers.js";
import {
  clickSignOut,
  FIXTURE_PIN_ID,
  pinFixturePlaylist,
  pinKept,
  reloadWithFixtureOptions,
  signInFromSettings,
  storedPinIds,
} from "./e2e-account-session.js";

const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const EXPLICIT_ID = "song-c";
const EXPLICIT_TITLE = "Track C";
const FIRST_TITLE = "Track A";
const PLAYLIST_NAME = "Fixture Playlist";
const LIBRARY_CACHE_SCOPE = "current-account";
const PLAYLIST_HASH = "#/playlist/playlist-1";
const AGREE_DELAY_MS = 15_000;
const q = (value) => JSON.stringify(value);

const SELECT = `document.querySelector('select[aria-label="Explicit content"]')`;
const ADVANCED_TOGGLE = `document.querySelector('.settings-section[aria-labelledby="advanced-heading"] button[aria-controls="advanced-details"]')`;
const FIX_INPUT = `[...document.querySelectorAll("label.settings-toggle-field")].find((label) => label.textContent.includes("Fix explicit songs not playing"))?.querySelector("input")`;
const DIALOG_TITLE = `document.getElementById("explicit-fix-title")`;
const dialogButton = (test) =>
  `[...document.querySelectorAll("[role=alertdialog] button")].find((button) => ${test})`;
const AGREE_BUTTON = dialogButton(
  `button.textContent.trim().startsWith("I Agree")`,
);
const CANCEL_BUTTON = dialogButton(`button.textContent.trim() === "Cancel"`);
const ALLOW_OFFERED = `[...(${SELECT}?.options ?? [])].some((option) => option.value === "allow")`;
const RESTART_NOTE = `document.querySelector(".explicit-restart-note")?.textContent.includes("Restart Arlet to apply.")`;
const RESTRICTED_NOTE = `[...document.querySelectorAll(".settings-field-help")].some((node) => node.textContent.includes("Apple reports explicit content as restricted"))`;
const RESTRICTED_TOAST = `[...document.querySelectorAll(".action-toast-message")].some((node) => node.textContent.includes("Explicit songs are restricted for this Apple Account"))`;
const ESCAPE = `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`;
const RESTART_BUTTON = `document.querySelector(".explicit-restart-note button")`;
const PLAYING_FIXTURE = `window.MusicKit?.getInstance?.()?.playbackState === window.MusicKit?.PlaybackStates?.playing`;
const SIGNED_IN = `document.querySelector(".titlebar-status")?.textContent.includes("Connected") === true`;

const snapshot = (page) => fixtureCall(page, "snapshot");
const pageValue = (page, expression) => page.evaluate(`return ${expression};`);
const stopCount = async (page) =>
  (await snapshot(page)).transitions.filter((item) => item.type === "stop")
    .length;
const selectValue = (page) => pageValue(page, `${SELECT}?.value ?? null`);
const optionValues = (page) =>
  pageValue(
    page,
    `${SELECT} ? [...${SELECT}.options].map((option) => option.value) : null`,
  );
const fixOn = (page) => pageValue(page, `Boolean(${FIX_INPUT}?.checked)`);
const storedRestriction = async (page) =>
  (await snapshot(page)).storedRestriction;

function clickIn(page, expression) {
  return page.evaluate(
    `${expression}?.click(); return Boolean(${expression});`,
  );
}

function chooseExplicit(page, value) {
  return page.evaluate(`
    const select = ${SELECT};
    if (!select) return false;
    select.value = ${q(value)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return select.value === ${q(value)};`);
}

const savedSetting = (page, key) =>
  page.evaluate(
    `return JSON.parse(await window.__TAURI_INTERNALS__.invoke("load_settings"))[${q(key)}];`,
  );

/** Saves are asynchronous; poll the settings file until the key reads as expected. */
async function waitForSaved(page, key, value, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await savedSetting(page, key)) === value) return true;
    await sleep(100);
  }
  return false;
}

async function dismissToasts(page) {
  await page.evaluate(`
    for (const button of document.querySelectorAll('.action-toast button')) {
      button.click();
    }
    return true;`);
}

async function openSettings(page) {
  await page.evaluate(`location.hash = "#/settings"; return true;`);
  return waitFor(page, `Boolean(${SELECT})`, 10_000);
}

async function openAdvanced(page) {
  const found = await waitFor(page, `Boolean(${ADVANCED_TOGGLE})`, 10_000);
  if (!found) return false;
  await page.evaluate(`
    const button = ${ADVANCED_TOGGLE};
    if (button?.getAttribute("aria-expanded") !== "true") button?.click();
    return true;`);
  return waitFor(
    page,
    `${ADVANCED_TOGGLE}?.getAttribute("aria-expanded") === "true"`,
    3000,
  );
}

async function openConsent(page) {
  await clickIn(page, FIX_INPUT);
  return waitFor(page, `Boolean(${DIALOG_TITLE})`, 5000);
}

/** Opens the consent dialog, waits out the delay, and agrees. */
async function agreeToFix(page) {
  await openConsent(page);
  const ready = await waitFor(
    page,
    `Boolean(${AGREE_BUTTON}) && !${AGREE_BUTTON}.disabled`,
    AGREE_DELAY_MS + 5000,
  );
  const clicked = ready && (await clickIn(page, AGREE_BUTTON));
  const on = await waitFor(
    page,
    `!${DIALOG_TITLE} && ${FIX_INPUT}?.checked === true`,
    5000,
  );
  return Boolean(clicked && on);
}

async function reloadApp(page) {
  await page.send("Page.reload", { ignoreCache: true });
  await sleep(1000);
  return waitFor(
    page,
    `${FIXTURE} && document.querySelector(".app-shell .player-bar")`,
    30_000,
  );
}

/** The row whose title is `title` on the playlist page, or undefined. */
const playlistRow = (title) =>
  `[...document.querySelectorAll(".library-track-row")].find((row) => row.textContent.includes(${q(title)}))`;
const PLAYLIST_PAGE = `[...document.querySelectorAll("h1")].some((node) => node.textContent.trim() === ${q(PLAYLIST_NAME)})`;

/**
 * Opens the fixture playlist and clicks the row with this title. Waits until
 * the playlist page is the current one and the row is on it, so a row from
 * an earlier view or a different order is never clicked by position.
 */
async function playRow(page, title) {
  await page.evaluate(`location.hash = ${q(PLAYLIST_HASH)}; return true;`);
  const ready = await waitFor(
    page,
    `${PLAYLIST_PAGE} && Boolean(${playlistRow(title)})`,
    15_000,
  );
  if (!ready) return false;
  await page.evaluate(`
    ${playlistRow(title)}?.click();
    return true;`);
  return true;
}

const setQueueCount = async (page) =>
  (await snapshot(page)).transitions.filter((item) => item.type === "setQueue")
    .length;

/** Plays the playlist row with this title and returns the song IDs MusicKit was given. */
async function playRowAndReadQueue(page, title) {
  const before = await setQueueCount(page);
  const started = await playRow(page, title);
  const queued = await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.filter((item) => item.type === "setQueue").length > ${before}`,
    15_000,
  );
  const last = (await snapshot(page)).transitions
    .filter((item) => item.type === "setQueue")
    .at(-1);
  return { started, queued, ids: last?.ids ?? [] };
}

/**
 * Starts from known state whatever ran before: the fixture's defaults, the
 * account's library cache cleared, a fresh page (no playlist view, queue, or
 * in-memory playlist data carried over), and shuffle and repeat off.
 */
async function startFromDefaults(page) {
  await fixtureCall(page, "reset");
  await page.evaluate(
    `await window.__TAURI_INTERNALS__.invoke("library_cache_clear", { scope: ${q(LIBRARY_CACHE_SCOPE)} }); return true;`,
  );
  await reloadApp(page);
  await page.evaluate(`
    const music = window.MusicKit?.getInstance?.();
    if (music) {
      music.shuffleMode = 0;
      music.repeatMode = 0;
    }
    return true;`);
  await dismissToasts(page);
}

/** Back to the start state: fixture defaults, fix off, Auto selected. */
async function restoreDefaults(page) {
  await fixtureCall(page, "reset");
  await dismissToasts(page);
  await page.evaluate(ESCAPE);
  if (!(await openSettings(page))) return;
  await openAdvanced(page);
  await page.evaluate(`
    const select = ${SELECT};
    if (select && select.value !== "auto") {
      select.value = "auto";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (${FIX_INPUT}?.checked) ${FIX_INPUT}.click();
    return true;`);
  await waitForSaved(page, "explicitFix", false);
}

const SKIP_RESTRICTED_TEXT =
  "because Apple restricts it for this Apple Account";
const PLAYER_RESTRICTED_TEXT =
  "Apple restricts this song for this Apple Account";
const LOG_ALLOW_APPLE_REPORT =
  "Explicit content: choice allow; Apple reports restricted: yes; MusicKit restricts: no.";
const CANT_PLAY_TEXT = "can't be played";

/** Arlet's app log text, or null when no log file exists. */
function appLog(logDir) {
  try {
    return fs.readFileSync(path.join(logDir, "arlet.log"), "utf8");
  } catch {
    return null;
  }
}

/** Polls the log for text written after the given offset; false on timeout. */
async function logHasSince(logDir, text, offset, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = appLog(logDir)?.slice(offset) ?? "";
    if (fresh.includes(text)) return true;
    await sleep(100);
  }
  return false;
}

/** MusicKit public restrictedEnabled writes made in this page session. */
async function restrictedWrites(page) {
  const { transitions } = await snapshot(page);
  return transitions.filter((item) => item.type === "restrictedEnabled").length;
}

/** Text of the last row on the fixture playlist page, or null. */
async function lastPlaylistTitle(page) {
  await page.evaluate(`location.hash = ${q(PLAYLIST_HASH)}; return true;`);
  await waitFor(
    page,
    `${PLAYLIST_PAGE} && document.querySelectorAll(".library-track-row").length > 0`,
    15_000,
  );
  return pageValue(
    page,
    `(() => { const rows = [...document.querySelectorAll(".library-track-row")]; return rows.at(-1)?.querySelector("strong")?.textContent ?? null; })()`,
  );
}

/** Texts of the visible action toasts and the player-bar error, for wording checks. */
const noticeTexts = (page) =>
  pageValue(
    page,
    `[...document.querySelectorAll(".action-toast-message, .player-error")].map((node) => [node.textContent, node.getAttribute("title") ?? ""].join(" ")).join(" | ")`,
  );

/** Runs one cleanup step; a failure is recorded and the next step still runs. */
async function attempt(failures, label, body) {
  try {
    await body();
  } catch (error) {
    failures.push(`${label}: ${error?.message ?? error}`);
  }
}

export async function runExplicitContent({
  page,
  check,
  artifactDir,
  logDir,
  restartApp,
}) {
  try {
    await startFromDefaults(page);
    const shown = await openSettings(page);
    const advanced = await openAdvanced(page);
    const startOptions = (await optionValues(page)) ?? [];
    check(
      "the Allow option is absent until the fix is agreed to",
      shown && advanced && startOptions.join(",") === "auto,clean",
      { options: startOptions },
    );

    const opened = await openConsent(page);
    const openedAt = Date.now();
    const atOpen = await pageValue(
      page,
      `(() => { const button = ${AGREE_BUTTON}; return { text: button?.textContent.trim() ?? null, disabled: button?.disabled ?? null }; })()`,
    );
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(
      path.join(artifactDir, "explicit-content-consent.png"),
      Buffer.from(shot.data, "base64"),
    );
    check(
      "the Advanced toggle opens the consent dialog with I Agree disabled",
      opened &&
        atOpen.disabled === true &&
        /^I Agree \(\d+\)$/u.test(atOpen.text ?? ""),
      { opened, ...atOpen, fixOn: await fixOn(page) },
    );

    const agreeEnabled = await waitFor(
      page,
      `Boolean(${AGREE_BUTTON}) && !${AGREE_BUTTON}.disabled`,
      AGREE_DELAY_MS + 5000,
    );
    const enabledAfterMs = Date.now() - openedAt;
    const agreeText = await pageValue(
      page,
      `${AGREE_BUTTON}?.textContent.trim() ?? null`,
    );
    check(
      "I Agree is enabled after the 15-second delay",
      agreeEnabled &&
        enabledAfterMs >= AGREE_DELAY_MS - 1000 &&
        agreeText === "I Agree",
      { agreeEnabled, enabledAfterMs, agreeText },
    );

    const cancelled = await clickIn(page, CANCEL_BUTTON);
    const closed = await waitFor(page, `!${DIALOG_TITLE}`, 5000);
    const fixAfterCancel = await fixOn(page);
    const savedAfterCancel = await savedSetting(page, "explicitFix");
    check(
      "Cancel leaves the fix off",
      cancelled &&
        closed &&
        fixAfterCancel === false &&
        savedAfterCancel !== true,
      { closed, fixAfterCancel, savedAfterCancel: savedAfterCancel ?? null },
    );

    const agreed = await agreeToFix(page);
    const allowOffered = (await pageValue(page, ALLOW_OFFERED)) === true;
    const savedFix = await waitForSaved(page, "explicitFix", true);
    const choiceKept = (await selectValue(page)) === "auto";
    check(
      "I Agree turns the fix on, saves it, offers Allow, and keeps the choice",
      agreed && allowOffered && savedFix && choiceKept,
      { agreed, allowOffered, savedFix, choiceKept },
    );

    // Auto with Apple reporting the account as restricted: MusicKit drops the
    // explicit song, and the user is told why.
    await fixtureCall(page, "configure", [
      { restricted: true, explicitSongIds: [EXPLICIT_ID] },
    ]);
    const autoPlay = await playRowAndReadQueue(page, EXPLICIT_TITLE);
    const toast = await waitFor(page, RESTRICTED_TOAST, 8000);
    check(
      "with the fixture restricted, Auto skips the explicit song and says so",
      autoPlay.started &&
        autoPlay.queued &&
        !autoPlay.ids.includes(EXPLICIT_ID) &&
        autoPlay.ids.length > 0 &&
        toast,
      {
        started: autoPlay.started,
        queued: autoPlay.queued,
        ids: autoPlay.ids,
        toast,
      },
    );
    await openSettings(page);
    const restrictedNote = await waitFor(page, RESTRICTED_NOTE, 5000);
    check("Auto shows the restricted note in Settings", restrictedNote, {
      restrictedNote,
    });

    // Allow changes MusicKit's flag for this session; Apple's stored report stays.
    const chosenAllow = await chooseExplicit(page, "allow");
    const allowApplied = await waitFor(
      page,
      `${FIXTURE}.snapshot().restrictedEnabled === false`,
      3000,
    );
    const allowPlay = await playRowAndReadQueue(page, EXPLICIT_TITLE);
    const storedAfterAllow = await storedRestriction(page);
    check(
      "Allow plays the explicit song and leaves Apple's stored report alone",
      chosenAllow &&
        allowApplied &&
        allowPlay.queued &&
        allowPlay.ids.includes(EXPLICIT_ID) &&
        storedAfterAllow === "1",
      {
        chosenAllow,
        allowApplied,
        queued: allowPlay.queued,
        ids: allowPlay.ids,
        storedAfterAllow,
      },
    );

    // The choice and the fix survive a reload, which starts a new page session.
    const savedAllow = await waitForSaved(page, "explicitContent", "allow");
    const reloaded = await reloadApp(page);
    await openSettings(page);
    await openAdvanced(page);
    const persisted = await waitFor(
      page,
      `${SELECT}?.value === "allow" && ${FIX_INPUT}?.checked === true`,
      10_000,
    );
    check(
      "the Allow choice and the fix survive a reload",
      savedAllow && reloaded && persisted,
      { savedAllow, reloaded, persisted },
    );

    // Turning the fix off returns Allow to Auto and asks for a restart, since
    // MusicKit keeps the value it was given during this session.
    await clickIn(page, FIX_INPUT);
    const turnedOff = await waitFor(
      page,
      `${SELECT}?.value === "auto" && ${FIX_INPUT}?.checked === false && !${ALLOW_OFFERED}`,
      5000,
    );
    const restartShown = await waitFor(page, RESTART_NOTE, 3000);
    const savedOff =
      (await waitForSaved(page, "explicitFix", false)) &&
      (await waitForSaved(page, "explicitContent", "auto"));
    check(
      "turning the fix off turns Allow into Auto and shows the restart note",
      turnedOff && restartShown && savedOff,
      { turnedOff, restartShown, savedOff },
    );

    // The note's button restarts the process. A new process reads Apple's
    // stored report again, so Auto follows it and no restart note is left.
    const restartClicked = await clickIn(page, RESTART_BUTTON);
    const restart = await restartApp(page);
    page = restart.page;
    await openSettings(page);
    const signedIn = await waitFor(page, SIGNED_IN, 10_000);
    const settingsKept =
      (await savedSetting(page, "explicitContent")) === "auto" &&
      (await savedSetting(page, "explicitFix")) === false;
    check(
      "Restart Arlet restarts the process; the app comes back signed in with settings kept",
      restartClicked &&
        restart.exited &&
        restart.ready &&
        signedIn &&
        settingsKept,
      {
        restartClicked,
        oldProcessExited: restart.exited,
        ready: restart.ready,
        signedIn,
        settingsKept,
      },
    );
    const storedAfterRestart = await storedRestriction(page);
    const followsApple = await waitFor(page, RESTRICTED_NOTE, 8000);
    const noteAfterRestart = await pageValue(page, RESTART_NOTE);
    check(
      "after a restart, Auto follows Apple's stored report again",
      restart.ready &&
        storedAfterRestart === "1" &&
        followsApple &&
        !noteAfterRestart,
      {
        restarted: restart.ready,
        storedAfterRestart,
        followsApple,
        noteAfterRestart: noteAfterRestart ?? false,
      },
    );

    // Clean with Apple reporting the account as unrestricted: Clean alone skips
    // the explicit song, and the restriction toast stays silent, since the user
    // chose Clean. Choosing it while a song plays must not stop that song: the
    // MusicKit write waits for the next Play, which replaces the queue.
    await fixtureCall(page, "configure", [
      { restricted: false, explicitSongIds: [EXPLICIT_ID] },
    ]);
    await openSettings(page);
    await openAdvanced(page);
    const reagreed = await agreeToFix(page);
    await openSettings(page);
    await dismissToasts(page);
    const playedFirst = await playRowAndReadQueue(page, FIRST_TITLE);
    const playingFirst = await waitFor(page, PLAYING_FIXTURE, 10_000);
    await openSettings(page);
    const stopsBeforeClean = await stopCount(page);
    const chosenClean = await chooseExplicit(page, "clean");
    await sleep(800);
    const stillPlaying = await pageValue(page, PLAYING_FIXTURE);
    const stoppedByClean = (await stopCount(page)) > stopsBeforeClean;
    const heldUntilPlay = (await snapshot(page)).restrictedEnabled === false;
    const cleanSaved = await waitForSaved(page, "explicitContent", "clean");
    check(
      "choosing Clean while a song plays neither stops it nor writes MusicKit before the next Play",
      reagreed &&
        playedFirst.queued &&
        playingFirst &&
        chosenClean &&
        stillPlaying === true &&
        !stoppedByClean &&
        heldUntilPlay &&
        cleanSaved,
      {
        reagreed,
        queued: playedFirst.queued,
        playingFirst,
        chosenClean,
        stillPlaying,
        stoppedByClean,
        heldUntilPlay,
        cleanSaved,
      },
    );
    const cleanPlay = await playRowAndReadQueue(page, EXPLICIT_TITLE);
    const cleanApplied = await waitFor(
      page,
      `${FIXTURE}.snapshot().restrictedEnabled === true`,
      3000,
    );
    const cleanToastShown = await pageValue(page, RESTRICTED_TOAST);
    check(
      "the next Play applies Clean: the explicit song is skipped, with no restriction toast",
      cleanPlay.queued &&
        cleanApplied &&
        !cleanPlay.ids.includes(EXPLICIT_ID) &&
        cleanPlay.ids.length > 0 &&
        cleanToastShown === false,
      {
        queued: cleanPlay.queued,
        cleanApplied,
        ids: cleanPlay.ids,
        cleanToastShown,
      },
    );

    // Turning the fix off with Clean selected keeps Clean and shows no note.
    await openSettings(page);
    await openAdvanced(page);
    await clickIn(page, FIX_INPUT);
    const cleanKept = await waitFor(
      page,
      `${SELECT}?.value === "clean" && ${FIX_INPUT}?.checked === false && !${ALLOW_OFFERED}`,
      5000,
    );
    const noNote = !(await pageValue(page, RESTART_NOTE));
    const savedClean = await waitForSaved(page, "explicitContent", "clean");
    check(
      "turning the fix off keeps Clean and shows no restart note",
      cleanKept && noNote && savedClean,
      { cleanKept, noNote, savedClean },
    );

    // Sign-in and sign-out. MusicKit's public restriction setter latches for
    // the page session, so Arlet writes it only after sign-in, and a sign-out
    // after an override restarts the process.
    await startFromDefaults(page);
    const pinned = await pinFixturePlaylist(page);
    await openSettings(page);
    await openAdvanced(page);
    const setupAgreed = await agreeToFix(page);
    const setupAllow = await chooseExplicit(page, "allow");
    const setupSaved = await waitForSaved(page, "explicitContent", "allow");

    const signedOutStart = await reloadWithFixtureOptions(page, {
      startUnauthorized: true,
      restricted: true,
    });
    await fixtureCall(page, "configure", [{ startUnauthorized: false }]);
    const atStartup = await snapshot(page);
    const startupWrites = atStartup.transitions.filter(
      (item) => item.type === "restrictedEnabled",
    ).length;
    check(
      "startup without a token does not write MusicKit before sign-in",
      signedOutStart &&
        atStartup.authorized === false &&
        atStartup.restrictionLatched === false &&
        startupWrites === 0,
      {
        signedOutStart,
        authorized: atStartup.authorized,
        restrictionLatched: atStartup.restrictionLatched,
        restrictedWrites: startupWrites,
        setup: { pinned, setupAgreed, setupAllow, setupSaved },
      },
    );

    await openSettings(page);
    await openAdvanced(page);
    await chooseExplicit(page, "clean");
    const signedOutChoice = await chooseExplicit(page, "allow");
    const signedOutSaved = await waitForSaved(page, "explicitContent", "allow");
    const signedOutState = await snapshot(page);
    const signedOutWrites = await restrictedWrites(page);
    check(
      "choosing Clean or Allow while signed out does not write MusicKit",
      signedOutChoice &&
        signedOutSaved &&
        signedOutState.restrictionLatched === false &&
        signedOutWrites === 0 &&
        (await selectValue(page)) === "allow",
      {
        signedOutChoice,
        signedOutSaved,
        restrictionLatched: signedOutState.restrictionLatched,
        restrictedWrites: signedOutWrites,
      },
    );

    // Same-account sign-in: Apple's stored report is applied, then Allow.
    const logOffset = appLog(logDir)?.length ?? 0;
    const sameSignedIn = await signInFromSettings(page);
    await openAdvanced(page);
    const afterSignIn = await snapshot(page);
    const choiceAfterSignIn = await selectValue(page);
    const pinsAfterSignIn = await storedPinIds(page);
    const pinStillKept = await pinKept(page);
    const logExists = appLog(logDir) !== null;
    const logLineShown = logExists
      ? await logHasSince(logDir, LOG_ALLOW_APPLE_REPORT, logOffset)
      : null;
    check(
      "a same-account sign-in keeps Apple's report and applies Allow after it",
      sameSignedIn &&
        afterSignIn.storedRestriction === "1" &&
        afterSignIn.restrictedEnabled === false &&
        afterSignIn.restrictionLatched === true &&
        choiceAfterSignIn === "allow" &&
        pinStillKept &&
        Array.isArray(pinsAfterSignIn) &&
        pinsAfterSignIn.includes(FIXTURE_PIN_ID) &&
        (!logExists || logLineShown === true),
      {
        signedIn: sameSignedIn,
        storedRestriction: afterSignIn.storedRestriction,
        restrictedEnabled: afterSignIn.restrictedEnabled,
        restrictionLatched: afterSignIn.restrictionLatched,
        choice: choiceAfterSignIn,
        pinStillKept,
        pinIds: pinsAfterSignIn,
        logChecked: logExists,
        logLineShown: logLineShown ?? "no log file; line not checked",
      },
    );

    // Apple's server refuses the explicit song while the user chose Allow.
    await dismissToasts(page);
    const skipPlay = await playRowAndReadQueue(page, FIRST_TITLE);
    const skipPlaying = await waitFor(page, PLAYING_FIXTURE, 10_000);
    await fixtureCall(page, "failCurrentItem", ["CONTENT_RESTRICTED"]);
    const skipNotice = await waitFor(
      page,
      `[...document.querySelectorAll(".action-toast-message")].some((node) => node.textContent.includes(${q(SKIP_RESTRICTED_TEXT)}))`,
      8000,
    );
    const skipTexts = (await noticeTexts(page)) ?? "";
    check(
      "a CONTENT_RESTRICTED skip says Apple restricts the song, never can't be played",
      skipPlay.started &&
        skipPlaying &&
        skipNotice &&
        !skipTexts.includes(CANT_PLAY_TEXT),
      {
        started: skipPlay.started,
        playing: skipPlaying,
        skipNotice,
        cantPlayShown: skipTexts.includes(CANT_PLAY_TEXT),
      },
    );

    // The last row has no next song, so the failure stays in the player bar.
    await dismissToasts(page);
    const lastTitle = await lastPlaylistTitle(page);
    await page.evaluate(`
      const music = window.MusicKit?.getInstance?.();
      if (music) music.repeatMode = 0;
      return true;`);
    const lastPlay = lastTitle
      ? await playRowAndReadQueue(page, lastTitle)
      : { started: false, queued: false, ids: [] };
    const lastPlaying = await waitFor(page, PLAYING_FIXTURE, 10_000);
    await dismissToasts(page);
    await fixtureCall(page, "failCurrentItem", ["CONTENT_RESTRICTED"]);
    const playerError = await waitFor(
      page,
      `[...document.querySelectorAll(".player-error")].some((node) => (node.getAttribute("title") ?? "").includes(${q(PLAYER_RESTRICTED_TEXT)}) || node.textContent.includes(${q(PLAYER_RESTRICTED_TEXT)}))`,
      8000,
    );
    const lastTexts = (await noticeTexts(page)) ?? "";
    const noSkipAtEnd = !lastTexts.includes(SKIP_RESTRICTED_TEXT);
    check(
      "a CONTENT_RESTRICTED failure on the last song shows the restricted text in the player bar",
      lastTitle !== null &&
        lastPlay.started &&
        lastPlay.queued &&
        lastPlaying &&
        playerError &&
        noSkipAtEnd,
      {
        lastTitle,
        started: lastPlay.started,
        queued: lastPlay.queued,
        playing: lastPlaying,
        playerError,
        noSkipAtEnd,
      },
    );

    // Sign-out after an override restarts Arlet; nothing from the old session stays.
    await clickSignOut(page);
    const signOutRestart = await restartApp(page, { startUnauthorized: true });
    page = signOutRestart.page;
    await waitForSaved(page, "explicitContent", "auto");
    const afterSignOut = await snapshot(page);
    const fixAfterSignOut = await savedSetting(page, "explicitFix");
    const choiceAfterSignOut = await savedSetting(page, "explicitContent");
    const pinsAfterSignOut = await storedPinIds(page);
    const storedAfterSignOut = await storedRestriction(page);
    check(
      "sign-out after an override restarts Arlet and leaves no fix or old account data",
      signOutRestart.exited &&
        signOutRestart.ready &&
        afterSignOut.authorized === false &&
        fixAfterSignOut === false &&
        choiceAfterSignOut === "auto" &&
        Array.isArray(pinsAfterSignOut) &&
        !pinsAfterSignOut.includes(FIXTURE_PIN_ID) &&
        storedAfterSignOut === null,
      {
        exited: signOutRestart.exited,
        ready: signOutRestart.ready,
        authorized: afterSignOut.authorized,
        savedFix: fixAfterSignOut ?? null,
        savedChoice: choiceAfterSignOut ?? null,
        pinIds: pinsAfterSignOut,
        storedRestriction: storedAfterSignOut,
      },
    );

    // After the restart, another account Apple reports as restricted is
    // restricted under Auto, and Arlet does not latch the setter.
    await fixtureCall(page, "configure", [
      { startUnauthorized: false, otherAccount: true, restricted: true },
    ]);
    const otherSignedIn = await signInFromSettings(page);
    await openAdvanced(page);
    const otherState = await snapshot(page);
    const otherChoice = await selectValue(page);
    const otherNote = await waitFor(page, RESTRICTED_NOTE, 5000);
    check(
      "after the restart, another account Apple reports as restricted is restricted under Auto",
      otherSignedIn &&
        otherState.restrictedEnabled === true &&
        otherState.storedRestriction === "1" &&
        otherState.restrictionLatched === false &&
        otherChoice === "auto" &&
        otherNote,
      {
        signedIn: otherSignedIn,
        restrictedEnabled: otherState.restrictedEnabled,
        storedRestriction: otherState.storedRestriction,
        restrictionLatched: otherState.restrictionLatched,
        choice: otherChoice,
        restrictedNote: otherNote,
      },
    );
    await fixtureCall(page, "configure", [{ otherAccount: false }]);
  } finally {
    // Cleanup runs every step even when one fails, so the run ends with no
    // override latched and the app signed in for later scenarios.
    const failures = [];
    await attempt(failures, "reset", () => fixtureCall(page, "reset"));
    await attempt(failures, "reload", async () => {
      if (!(await reloadApp(page))) throw new Error("app did not reload");
    });
    await attempt(failures, "defaults", () => restoreDefaults(page));
    await attempt(failures, "reset", () => fixtureCall(page, "reset"));
    await attempt(failures, "toasts", () => dismissToasts(page));
    let endState = null;
    let endConnected = false;
    await attempt(failures, "snapshot", async () => {
      endState = await snapshot(page);
    });
    await attempt(failures, "settings", async () => {
      await openSettings(page);
      endConnected = await waitFor(page, SIGNED_IN, 10_000);
    });
    check(
      "explicit content ends with no override latched and signed in",
      failures.length === 0 &&
        endState?.restrictionLatched === false &&
        endState?.authorized === true &&
        endConnected,
      {
        restrictionLatched: endState?.restrictionLatched ?? null,
        authorized: endState?.authorized ?? null,
        connected: endConnected,
        failures,
      },
    );
  }
}
