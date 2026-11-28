// Synthetic end-to-end coverage for legacy setting normalization and Clean filtering.
import { fixtureCall, waitFor as pollFor } from "./e2e-helpers.js";

const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const EXPLICIT_ID = "song-c";
const CLEAN_ID = "song-clean-c";
const PLAYLIST_NAME = "Fixture Playlist";
const SELECT =
  'document.querySelector("select[aria-label=\\\"Explicit content\\\"]")';
const PLAYLIST_HASH = "#/playlist/playlist-1";
const q = (value) => JSON.stringify(value);

const waitFor = (page, expression, timeoutMs = 10_000) =>
  pollFor(page, expression, timeoutMs, 100);
const snapshot = (page) => fixtureCall(page, "snapshot");
const MUSIC_KIT_READY = `(() => {
  const instance = window.MusicKit?.getInstance?.();
  return Boolean(
    instance?.isAuthorized === true &&
    typeof instance.api?.music === "function" &&
    document.querySelector(".titlebar-status")?.textContent.includes("Connected"),
  );
})()`;
const savedSettings = (page) =>
  page.evaluate(
    'return JSON.parse(await window.__TAURI_INTERNALS__.invoke("load_settings"));',
  );

async function openSettings(page) {
  await page.evaluate('location.hash = "#/settings"; return true;');
  return waitFor(page, SELECT);
}

async function chooseExplicit(page, value) {
  const previousRoute = await page.evaluate("return location.hash;");
  const shown = await openSettings(page);
  const changed = shown
    ? await page.evaluate(`
        const select = ${SELECT};
        if (!select) return false;
        select.value = ${q(value)};
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return select.value === ${q(value)};
      `)
    : false;
  if (previousRoute !== "#/settings") {
    await page.evaluate(`location.hash = ${q(previousRoute)}; return true;`);
  }
  return changed;
}

async function reloadApp(page) {
  await page.send("Page.reload", { ignoreCache: true });
  return waitFor(
    page,
    FIXTURE +
      ' && document.querySelector(".app-shell .player-bar") && ' +
      MUSIC_KIT_READY,
    30_000,
  );
}

async function saveLegacyPreference(page) {
  return page.evaluate(`
    const command = window.__TAURI_INTERNALS__.invoke;
    const raw = await command("load_settings");
    const settings = typeof raw === "string" ? JSON.parse(raw) : raw;
    settings.explicitContent = "allow";
    settings.explicitFix = true;
    settings.autoplay = true;
    await command("save_settings", { json: JSON.stringify(settings) });
    const saved = await command("load_settings");
    return typeof saved === "string" ? JSON.parse(saved) : saved;
  `);
}

async function deleteSavedQueue(page) {
  return page.evaluate(`
    await window.__TAURI_INTERNALS__.invoke("delete_playback_session");
    return true;
  `);
}

async function setAutoplayPreference(page, enabled) {
  const previousRoute = await page.evaluate("return location.hash;");
  const shown = await openSettings(page);
  const changed = shown
    ? await page.evaluate(`
        const label = [...document.querySelectorAll("label.settings-toggle-field")]
          .find((node) => node.textContent.includes("Autoplay"));
        const input = label?.querySelector('input[type="checkbox"]');
        if (!input) return false;
        if (input.checked !== ${Boolean(enabled)}) input.click();
        return true;
      `)
    : false;
  const applied = await waitFor(
    page,
    `[...document.querySelectorAll("label.settings-toggle-field")].find((node) => node.textContent.includes("Autoplay"))?.querySelector('input[type="checkbox"]')?.checked === ${Boolean(enabled)}`,
  );
  if (previousRoute !== "#/settings") {
    await page.evaluate(`location.hash = ${q(previousRoute)}; return true;`);
  }
  return changed && applied;
}

async function installEquivalent(page, { clean }) {
  const ready = await waitFor(
    page,
    'typeof window.MusicKit?.getInstance?.()?.api?.music === "function"',
  );
  if (!ready) return false;
  return page.evaluate(`
    const instance = window.MusicKit?.getInstance?.();
    const api = instance?.api;
    if (!api || typeof api.music !== "function") return false;
    window.__ARLET_CLEAN_MODE__ = ${q(clean)};
    window.__ARLET_CLEAN_EQUIVALENCE_CALLS__ = [];
    if (api.__arletCleanOriginal) return true;
    api.__arletCleanOriginal = api.music;
    api.music = function(path, query, options) {
      if (
        String(path) === "/v1/catalog/us/songs" &&
        query?.["filter[equivalents]"] === ${q(EXPLICIT_ID)}
      ) {
        window.__ARLET_CLEAN_EQUIVALENCE_CALLS__.push({
          path: String(path),
          query: structuredClone(query),
        });
        const clean = window.__ARLET_CLEAN_MODE__ === true;
        const id = clean ? ${q(CLEAN_ID)} : ${q(EXPLICIT_ID)};
        return Promise.resolve({
          data: [{
            id,
            type: "songs",
            attributes: {
              name: clean ? "Track C (Clean)" : "Track C",
              artistName: "Fixture Artist",
              albumName: "Fixture Album",
              durationInMillis: 180000,
              contentRating: clean ? "clean" : "explicit",
              playParams: { id, kind: "song" },
            },
          }],
        });
      }
      return api.__arletCleanOriginal.call(this, path, query, options);
    };
    return true;
  `);
}

async function clickTrackRow(page, id) {
  await page.evaluate("location.hash = " + q(PLAYLIST_HASH) + "; return true;");
  const rowSelector = `.song-row-shell[data-context-id=${q(id)}]`;
  const ready = await waitFor(
    page,
    `document.querySelector("h1")?.textContent.trim() === ${q(PLAYLIST_NAME)} && Boolean(document.querySelector(${q(rowSelector)}))`,
  );
  if (!ready) return false;
  return page.evaluate(`
    const row = document.querySelector(${q(rowSelector)});
    const button = row?.closest("li")?.querySelector("button.library-track-row");
    button?.click();
    return Boolean(button && !button.disabled);
  `);
}

async function contextPlayNext(page, id) {
  const drawer = await page.evaluate(`
    const button = document.querySelector('[aria-label="Toggle Playing Next"]');
    button?.click();
    return Boolean(button);
  `);
  if (!drawer) return { drawer: false };
  const rowReady = await waitFor(
    page,
    `document.querySelector('.queue-row-shell[data-context-id=${q(id)}]')`,
  );
  if (!rowReady) return { drawer: true, rowReady: false };
  const target = await page.evaluate(`
    const row = document.querySelector('.queue-row-shell[data-context-id=${q(id)}]');
    if (!row) return null;
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 120,
    }));
    return { explicit: row.dataset.contextExplicit ?? null };
  `);
  const menuReady = await waitFor(
    page,
    'document.querySelector("[role=menu]")',
  );
  const before = await snapshot(page);
  const observed = await page.evaluate(`
    window.__ARLET_E2E_CAPTURE_CONTEXT_PLAY_NEXT__ = true;
    return true;
  `);
  const clicked = menuReady
    ? await page.evaluate(`
        const button = document.querySelector('[role="menu"] [data-menu-item="play-next"]');
        button?.click();
        return Boolean(button);
      `)
    : false;
  const inserted = clicked
    ? await waitFor(
        page,
        FIXTURE +
          `.snapshot().transitions.some((item) => item.type === "playNext" && item.ids.includes(${q(id)}))`,
      )
    : false;
  const playNextCall = (await snapshot(page)).transitions
    .filter((item) => item.type === "playNext" && item.ids.includes(id))
    .at(-1);
  await page.evaluate(`
    window.__ARLET_E2E_CAPTURE_CONTEXT_PLAY_NEXT__ = false;
    return true;
  `);
  return {
    drawer,
    rowReady,
    observed,
    target,
    menuReady,
    clicked,
    inserted,
    before,
    descriptor: playNextCall?.options ?? null,
  };
}

async function latestSetQueue(page) {
  const trace = await snapshot(page);
  return trace.transitions.filter((item) => item.type === "setQueue").at(-1);
}

export async function runExplicitContent({ page, check }) {
  await fixtureCall(page, "reset");
  await deleteSavedQueue(page);

  const originalSettings = await savedSettings(page);
  const legacy = await saveLegacyPreference(page);
  const reloaded = await reloadApp(page);
  // Reload creates a fresh fixture. Clear any prior scenario's parked queue
  // before configuring ratings for this scenario.
  await fixtureCall(page, "reset");
  await deleteSavedQueue(page);
  await fixtureCall(page, "configure", [
    {
      restricted: false,
      explicitSongIds: [EXPLICIT_ID],
      cleanSongIds: ["song-a"],
      autoplayStation: "ok",
    },
  ]);
  const saved = await savedSettings(page);
  const initialProvider = await snapshot(page);
  const shown = await openSettings(page);
  const options = shown
    ? await page.evaluate(
        `return [...${SELECT}.options].map((option) => option.value);`,
      )
    : [];
  const advanced = await page.evaluate(`
    const heading = document.querySelector('[aria-labelledby="advanced-heading"]');
    return heading ? heading.innerText : "";
  `);
  check(
    "legacy Allow and explicitFix settings are forced to Auto and disabled",
    reloaded &&
      legacy.explicitContent === "auto" &&
      legacy.explicitFix !== true &&
      saved.explicitContent === "auto" &&
      saved.explicitFix !== true,
    { reloaded, legacy, saved },
  );
  check(
    "the UI offers only Auto and Clean and contains no bypass control",
    shown &&
      options.join(",") === "auto,clean" &&
      !advanced.includes("Fix explicit songs not playing"),
    { shown, options, advanced },
  );
  check(
    "Auto applies the saved provider autoplay preference",
    saved.autoplay === true && initialProvider.autoplayEnabled === true,
    {
      savedAutoplay: saved.autoplay,
      providerAutoplay: initialProvider.autoplayEnabled,
    },
  );

  const cleanApiReady = await installEquivalent(page, { clean: true });
  await chooseExplicit(page, "auto");
  const started = await clickTrackRow(page, "song-a");
  const firstQueueReady = await waitFor(
    page,
    FIXTURE +
      '.snapshot().transitions.some((item) => item.type === "setQueue")',
  );
  const beforeCleanFilter = await latestSetQueue(page);
  const contextInsertion = await contextPlayNext(page, EXPLICIT_ID);
  const contextDescriptorRating =
    contextInsertion.descriptor?.items?.[0]?.attributes?.contentRating;
  check(
    "queue context actions retain the known explicit rating in MusicKit song details",
    contextInsertion.rowReady &&
      contextInsertion.target?.explicit === "true" &&
      contextInsertion.clicked &&
      contextInsertion.inserted &&
      contextDescriptorRating === "explicit",
    {
      contextInsertion,
      contextDescriptorRating,
    },
  );
  const beforeCleanCount = (await snapshot(page)).transitions.filter(
    (item) => item.type === "setQueue",
  ).length;
  const cleanSelected = await chooseExplicit(page, "clean");
  const cleanQueueReady = await waitFor(
    page,
    FIXTURE +
      '.snapshot().transitions.filter((item) => item.type === "setQueue").length > ' +
      beforeCleanCount,
  );
  const cleanQueue = await latestSetQueue(page);
  const cleanCalls = await page.evaluate(
    "return window.__ARLET_CLEAN_EQUIVALENCE_CALLS__ ?? [];",
  );
  const cleanAutoplayDisabled = await waitFor(
    page,
    FIXTURE + ".snapshot().autoplayEnabled === false",
  );
  const cleanSnapshot = await snapshot(page);
  const explicitWrites = cleanSnapshot.transitions.filter(
    (item) => item.type === "restrictedEnabled",
  ).length;
  const explicitReads = cleanSnapshot.restrictedEnabledReads;
  check(
    "Clean filters a live queue to verified clean originals without switching recordings",
    cleanApiReady &&
      cleanSelected &&
      started &&
      firstQueueReady &&
      cleanQueueReady &&
      beforeCleanFilter?.ids?.includes(EXPLICIT_ID) &&
      cleanQueue?.ids?.includes("song-e") &&
      !cleanQueue?.ids?.includes(EXPLICIT_ID) &&
      !cleanQueue?.ids?.includes(CLEAN_ID) &&
      cleanCalls.length === 0 &&
      cleanAutoplayDisabled &&
      cleanSnapshot.autoplayEnabled === false &&
      cleanSnapshot.queue.autoplay.ids.length === 0,
    {
      cleanApiReady,
      cleanSelected,
      started,
      firstQueueReady,
      beforeCleanFilter,
      cleanQueueReady,
      cleanQueue,
      cleanCalls,
      cleanAutoplayDisabled,
      cleanSnapshotAutoplay: cleanSnapshot.autoplayEnabled,
      cleanQueueAutoplay: cleanSnapshot.queue.autoplay.ids,
    },
  );
  check(
    "Clean never reads or writes MusicKit's account policy",
    explicitWrites === 0 && explicitReads === 0,
    { explicitReads, explicitWrites },
  );

  await fixtureCall(page, "finishCurrentTrack");
  const automaticallyAdvanced = await waitFor(
    page,
    FIXTURE + '.snapshot().queue.activeId === "song-e"',
  );
  check(
    "automatic queue advances stay on the verified clean queue",
    automaticallyAdvanced &&
      (await snapshot(page)).queue.items.every(
        (item) => !item.id.startsWith("autoplay-") && item.id !== EXPLICIT_ID,
      ),
    { automaticallyAdvanced, queue: (await snapshot(page)).queue },
  );

  await page.evaluate(`
    const instance = window.MusicKit?.getInstance?.();
    if (!instance) return false;
    instance.autoplayEnabled = true;
    return true;
  `);
  const delayedAutoplayRejected = await waitFor(
    page,
    FIXTURE +
      ".snapshot().autoplayEnabled === false && window.__ARLET_E2E_MUSIC__.snapshot().queue.autoplay.ids.length === 0",
  );
  const afterDelayedAutoplay = await snapshot(page);
  check(
    "provider autoplay events during Clean cannot leave unverified suggestions queued",
    delayedAutoplayRejected &&
      afterDelayedAutoplay.autoplayEnabled === false &&
      afterDelayedAutoplay.queue.autoplay.ids.length === 0 &&
      afterDelayedAutoplay.queue.items.every(
        (item) => !item.id.startsWith("autoplay-") && item.id !== EXPLICIT_ID,
      ),
    {
      delayedAutoplayRejected,
      autoplayEnabled: afterDelayedAutoplay.autoplayEnabled,
      queue: afterDelayedAutoplay.queue,
    },
  );

  await chooseExplicit(page, "auto");
  const autoRestored = await waitFor(
    page,
    FIXTURE + ".snapshot().autoplayEnabled === true",
  );
  const cleanEquivalentAvailable = await installEquivalent(page, {
    clean: true,
  });
  const beforeUnavailable = (await snapshot(page)).transitions.filter(
    (item) => item.type === "setQueue",
  ).length;
  const restartedAutoPlay = await clickTrackRow(page, "song-a");
  const autoQueueReady = await waitFor(
    page,
    FIXTURE +
      '.snapshot().transitions.filter((item) => item.type === "setQueue").length > ' +
      beforeUnavailable,
  );
  const beforeRejected = (await snapshot(page)).transitions.filter(
    (item) => item.type === "setQueue",
  ).length;
  await chooseExplicit(page, "clean");
  const rejectedEquivalentReady = await waitFor(
    page,
    FIXTURE +
      '.snapshot().transitions.filter((item) => item.type === "setQueue").length > ' +
      beforeRejected,
  );
  const afterUnavailable = await latestSetQueue(page);
  const rejectedEquivalents = await page.evaluate(
    "return window.__ARLET_CLEAN_EQUIVALENCE_CALLS__ ?? [];",
  );
  check(
    "Clean never switches to a different recording, even when Apple has a clean equivalent",
    cleanEquivalentAvailable &&
      restartedAutoPlay &&
      autoQueueReady &&
      autoRestored &&
      rejectedEquivalentReady &&
      !afterUnavailable?.ids?.includes(EXPLICIT_ID) &&
      !afterUnavailable?.ids?.includes(CLEAN_ID) &&
      afterUnavailable?.ids?.includes("song-e") &&
      rejectedEquivalents.length === 0,
    {
      cleanEquivalentAvailable,
      restartedAutoPlay,
      autoQueueReady,
      autoRestored,
      rejectedEquivalentReady,
      afterUnavailable,
      rejectedEquivalents,
    },
  );

  const final = await snapshot(page);
  check(
    "explicit content cleanup leaves provider policy untouched",
    final.transitions.every((item) => item.type !== "restrictedEnabled") &&
      final.restrictedEnabledReads === 0,
    {
      policyReads: final.restrictedEnabledReads,
      policyWrites: final.transitions.filter(
        (item) => item.type === "restrictedEnabled",
      ).length,
    },
  );

  await fixtureCall(page, "seedQueue", [3]);
  const unverifiedProviderQueueCleared = await waitFor(
    page,
    FIXTURE + ".snapshot().queue.items.length === 0",
  );
  const afterUnverifiedProviderQueue = await snapshot(page);
  check(
    "delayed provider queue changes fail closed while Clean is active",
    unverifiedProviderQueueCleared &&
      afterUnverifiedProviderQueue.autoplayEnabled === false &&
      afterUnverifiedProviderQueue.queue.items.length === 0 &&
      afterUnverifiedProviderQueue.transitions.some(
        (item) => item.type === "stop",
      ),
    {
      unverifiedProviderQueueCleared,
      queue: afterUnverifiedProviderQueue.queue,
      autoplayEnabled: afterUnverifiedProviderQueue.autoplayEnabled,
    },
  );

  const autoCleanup = await chooseExplicit(page, "auto");
  const autoplayCleanup = await setAutoplayPreference(
    page,
    originalSettings.autoplay === true,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const cleanupSettings = await savedSettings(page);
  const cleanupProvider = await snapshot(page);
  check(
    "explicit-content leaves Auto and the original autoplay preference for the next scenario",
    autoCleanup &&
      autoplayCleanup &&
      cleanupSettings.explicitContent === "auto" &&
      cleanupSettings.autoplay === (originalSettings.autoplay === true) &&
      cleanupProvider.autoplayEnabled === (originalSettings.autoplay === true),
    {
      autoCleanup,
      autoplayCleanup,
      explicitContent: cleanupSettings.explicitContent,
      savedAutoplay: cleanupSettings.autoplay,
      providerAutoplay: cleanupProvider.autoplayEnabled,
    },
  );
  await fixtureCall(page, "configure", [
    {
      autoplayStation: "refused",
      explicitSongIds: [],
      cleanSongIds: [],
    },
  ]);
  await page.evaluate(`
    window.__ARLET_CLEAN_MODE__ = undefined;
    window.__ARLET_CLEAN_EQUIVALENCE_CALLS__ = [];
    return true;
  `);
}
