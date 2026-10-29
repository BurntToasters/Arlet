import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureCall, sleep, waitFor as pollFor } from "./e2e-helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const NOTICE = ".session-expired-notice";
const STATUS = ".titlebar-status";
const NOW_PLAYING = ".player-bar .player-track-copy strong";
const PROBE_PATH = "/v1/me/storefront";
const SETTINGS_SECTION =
  '.settings-section[aria-labelledby="appearance-heading"]';
const THEMES = ["system", "light", "dark"];
const q = (value) => JSON.stringify(value);
const waitFor = (page, expression, timeoutMs = 10_000) =>
  pollFor(page, expression, timeoutMs, 50);

async function required(page, expression, label, timeoutMs = 10_000) {
  if (!(await waitFor(page, expression, timeoutMs))) throw new Error(label);
}

async function route(page, hash, ready, timeoutMs = 10_000) {
  await page.evaluate(`location.hash = ${q(hash)}; return true;`);
  await required(page, ready, `Route not ready: ${hash}`, timeoutMs);
}

async function clickEnabled(page, text) {
  const expression = `[...document.querySelectorAll("button")].some((button) => button.textContent.trim() === ${q(text)} && !button.disabled)`;
  await required(page, expression, `Enabled button not found: ${text}`, 15_000);
  const action = await page.evaluate(`
    const button = [...document.querySelectorAll("button")]
      .find((node) => node.textContent.trim() === ${q(text)} && !node.disabled);
    const label = button?.textContent.trim() ?? null;
    const disabled = button?.disabled ?? null;
    const accepted = Boolean(button && !disabled);
    if (accepted) button.click();
    return { accepted, label, disabled };
  `);
  if (!action.accepted)
    throw new Error(`Button action was not accepted: ${text}`);
  return action;
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
    `document.querySelector(${q(STATUS)})?.textContent.includes("Connected")`,
    "Fixture did not start connected",
    15_000,
  );
  return state(page);
}

async function state(page) {
  return page.evaluate(`
    const fixture = window.__ARLET_E2E_MUSIC__.snapshot();
    return {
      authorized: fixture.authorized,
      apiGeneration: fixture.apiGeneration,
      banner: Boolean(document.querySelector(${q(NOTICE)})),
      status: document.querySelector(${q(STATUS)})?.textContent.trim() ?? "",
      current: document.querySelector(${q(NOW_PLAYING)})?.textContent ?? null,
      queueIds: fixture.queue.items.map((item) => item.id),
    };
  `);
}

async function settings(page) {
  await route(
    page,
    "#/settings",
    `Boolean(document.querySelector(${q(".account-card")}))`,
  );
}

async function saveScreenshot(page, artifactDir, name) {
  const result = await page.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(
    path.join(artifactDir, name),
    Buffer.from(result.data, "base64"),
  );
}

async function staleProbe(page, check) {
  const before = await fresh(page);
  await page.evaluate(`
    const instance = window.MusicKit.getInstance();
    const api = instance.api;
    const original = api.music.bind(api);
    const audit = window.__ARLET_AUDIT_PROBES__ = { calls: [], old: null, current: null };
    api.music = (path, ...args) => {
      if (String(path).split("?", 1)[0] === ${q(PROBE_PATH)}) {
        const call = {
          generation: window.__ARLET_E2E_MUSIC__.snapshot().apiGeneration,
          owner: "old",
        };
        audit.calls.push(call);
        if (!audit.old) {
          return new Promise((resolve, reject) => {
            audit.old = { generation: call.generation, resolve, reject };
          });
        }
      }
      return original(path, ...args);
    };
    return true;
  `);
  await fixtureCall(page, "failCurrentItem", ["MEDIA_LICENSE"]);
  await required(
    page,
    "window.__ARLET_AUDIT_PROBES__?.old !== null",
    "Old account probe was not held",
  );
  const oldProbe = await page.evaluate(
    "return { generation: window.__ARLET_AUDIT_PROBES__.old.generation, calls: window.__ARLET_AUDIT_PROBES__.calls.length };",
  );

  await settings(page);
  await clickEnabled(page, "Sign out");
  await required(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().authorized === false && [...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "Sign in" && !button.disabled)`,
    "Sign out did not settle before the next sign-in",
    15_000,
  );
  await clickEnabled(page, "Sign in");
  await required(
    page,
    `document.querySelector(${q(STATUS)})?.textContent.includes("Connected")`,
    "Fresh sign-in did not complete",
    15_000,
  );
  const freshSignIn = await state(page);

  await page.evaluate(`
    const instance = window.MusicKit.getInstance();
    const api = instance.api;
    const original = api.music.bind(api);
    const audit = window.__ARLET_AUDIT_PROBES__;
    audit.currentApiGeneration = window.__ARLET_E2E_MUSIC__.snapshot().apiGeneration;
    audit.currentCalls = 0;
    api.music = (path, ...args) => {
      if (String(path).split("?", 1)[0] === ${q(PROBE_PATH)}) {
        audit.currentCalls += 1;
        audit.calls.push({ generation: audit.currentApiGeneration, owner: "current" });
        if (!audit.current) {
          const requestArgs = [path, ...args];
          return new Promise((resolve, reject) => {
            audit.current = {
              generation: audit.currentApiGeneration,
              reject,
              release: () =>
                Promise.resolve(original(...requestArgs)).then(
                  (value) => {
                    audit.current.settled = true;
                    resolve(value);
                    return true;
                  },
                  (error) => {
                    audit.current.settled = true;
                    reject(error);
                    throw error;
                  },
                ),
            };
          });
        }
      }
      return original(path, ...args);
    };
    return true;
  `);
  await fixtureCall(page, "failCurrentItem", ["MEDIA_LICENSE"]);
  await required(
    page,
    "window.__ARLET_AUDIT_PROBES__?.current !== null",
    "New account probe did not start while the old probe remained pending",
  );
  const currentProbe = await page.evaluate(`
    const audit = window.__ARLET_AUDIT_PROBES__;
    return { generation: audit.current.generation, calls: audit.currentCalls };
  `);

  await page.evaluate(`
    const error = new Error("403");
    error.status = 403;
    error.errorCode = "ACCESS_DENIED";
    error.reason = "ACCESS_DENIED";
    window.__ARLET_AUDIT_PROBES__.old.reject(error);
    return true;
  `);
  await sleep(150);
  const afterOldFailure = await state(page);
  const newProbeStillPending = await page.evaluate(
    "const audit = window.__ARLET_AUDIT_PROBES__; return audit.currentCalls === 1 && audit.current.settled !== true;",
  );
  const preconditions = {
    oldProbeHeld: oldProbe.calls === 1,
    newAccountGeneration: freshSignIn.apiGeneration > before.apiGeneration,
    newProbeStarted: currentProbe.calls === 1,
    probeEpochChanged: currentProbe.generation > oldProbe.generation,
  };
  const preconditionsMet = Object.values(preconditions).filter(Boolean).length;
  check(
    "an old 403 probe cannot expire a newly signed-in account",
    preconditionsMet === Object.keys(preconditions).length &&
      afterOldFailure.authorized &&
      !afterOldFailure.banner &&
      afterOldFailure.status.includes("Connected") &&
      newProbeStillPending,
    {
      preconditions,
      preconditionsMet,
      expectedPreconditions: Object.keys(preconditions).length,
      before,
      oldProbe,
      freshSignIn,
      currentProbe,
      afterOldFailure,
      newProbeStillPending,
    },
  );

  await page.evaluate(
    "return await window.__ARLET_AUDIT_PROBES__.current.release();",
  );
  return {
    before,
    oldProbe,
    freshSignIn,
    currentProbe,
    afterOldFailure,
    preconditions,
  };
}

async function lateAuthorization(page, check) {
  await fresh(page);
  await fixtureCall(page, "configure", [{ hangAuthorize: true }]);
  await fixtureCall(page, "emitAuthorizationStatus", [false]);
  await required(
    page,
    `Boolean(document.querySelector(${q(NOTICE)}))`,
    "Expired-session notice did not appear",
  );
  await settings(page);
  const authorizeCountBefore = await page.evaluate(`
    return window.__ARLET_E2E_MUSIC__.snapshot().transitions
      .filter((item) => item.type === "authorize").length;
  `);
  await clickEnabled(page, "Sign in again");
  await required(
    page,
    "window.__ARLET_E2E_MUSIC__.snapshot().authorizeHeld === 1",
    "Reauthorization did not remain pending",
  );
  const pending = await page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot().authorizeHeld;",
  );

  let result;
  try {
    await clickEnabled(page, "Sign out");
    await required(
      page,
      `window.__ARLET_E2E_MUSIC__.snapshot().authorized === false && [...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "Sign in")`,
      "Explicit Sign out did not produce the signed-out state",
      15_000,
    );
    const signedOut = await state(page);
    const blockedAction = await page.evaluate(`
      const button = [...document.querySelectorAll("button")]
        .find((node) => node.textContent.trim() === "Sign in");
      const action = { present: Boolean(button), disabled: button?.disabled ?? null, clicked: false };
      if (button && !button.disabled) {
        button.click();
        action.clicked = true;
      }
      return action;
    `);
    await sleep(200);
    const afterBlockedAttempt = await page.evaluate(`
      const trace = window.__ARLET_E2E_MUSIC__.snapshot();
      return {
        authorized: trace.authorized,
        authorizeHeld: trace.authorizeHeld,
        authorizeCount: trace.transitions.filter((item) => item.type === "authorize").length,
      };
    `);
    const signInBlocked =
      afterBlockedAttempt.authorizeHeld === 1 &&
      afterBlockedAttempt.authorizeCount === authorizeCountBefore + 1 &&
      !afterBlockedAttempt.authorized;

    await fixtureCall(page, "configure", [{ hangAuthorize: false }]);
    const releaseCount = await fixtureCall(page, "releaseAuthorize");
    await required(
      page,
      "window.__ARLET_E2E_MUSIC__.snapshot().authorizeHeld === 0 && window.__ARLET_E2E_MUSIC__.snapshot().authorized === false",
      "Late authorization cleanup did not preserve sign-out",
      15_000,
    );
    const afterOldAuthorization = await state(page);

    await required(
      page,
      `[...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "Sign in" && !button.disabled)`,
      "Sign-in control did not become available after the old attempt settled",
      15_000,
    );
    const newSignInAction = await clickEnabled(page, "Sign in");
    await required(
      page,
      `window.__ARLET_E2E_MUSIC__.snapshot().authorized === true && document.querySelector(${q(STATUS)})?.textContent.includes("Connected")`,
      "Fresh sign-in did not succeed after old authorization settled",
      15_000,
    );
    const afterFreshSignIn = await state(page);
    const preconditions = {
      authorizationWasHeld: pending === 1,
      signOutSettled:
        !signedOut.authorized && !signedOut.status.includes("Connected"),
      heldAttemptReleased: releaseCount === 1,
    };
    const preconditionsMet =
      Object.values(preconditions).filter(Boolean).length;
    check(
      "late authorization after explicit Sign out stays signed out, then a new sign-in succeeds",
      preconditionsMet === Object.keys(preconditions).length &&
        signInBlocked &&
        !afterOldAuthorization.authorized &&
        !afterOldAuthorization.status.includes("Connected") &&
        afterFreshSignIn.authorized &&
        afterFreshSignIn.status.includes("Connected") &&
        !afterFreshSignIn.banner &&
        newSignInAction.accepted,
      {
        preconditions,
        preconditionsMet,
        expectedPreconditions: Object.keys(preconditions).length,
        signedOut,
        blockedAction,
        afterBlockedAttempt,
        signInBlocked,
        releaseCount,
        afterOldAuthorization,
        newSignInAction,
        afterFreshSignIn,
      },
    );
    result = {
      signedOut,
      blockedAction,
      afterBlockedAttempt,
      afterOldAuthorization,
      afterFreshSignIn,
      preconditions,
    };
  } finally {
    await fixtureCall(page, "configure", [{ hangAuthorize: false }]);
    await fixtureCall(page, "releaseAuthorize");
  }
  return result;
}

async function staleQueueRetry(page, check) {
  await fresh(page);
  await route(
    page,
    "#/album/album-1",
    `document.querySelector(".library-track-row")?.textContent.includes("Album Track A")`,
    15_000,
  );
  await page.evaluate(`
    const instance = window.MusicKit.getInstance();
    const original = instance.setQueue.bind(instance);
    const audit = window.__ARLET_AUDIT_QUEUE__ = {
      armed: true,
      held: false,
      released: false,
      retries: [],
    };
    instance.setQueue = async (options) => {
      if (audit.armed && JSON.stringify(options).includes('"album-a"')) {
        audit.armed = false;
        audit.held = true;
        await new Promise((_resolve, reject) => { audit.reject = reject; });
      }
      if (audit.released) audit.retries.push(JSON.parse(JSON.stringify(options)));
      return original(options);
    };
    document.querySelector(".library-track-row")?.click();
    return true;
  `);
  await required(
    page,
    "window.__ARLET_AUDIT_QUEUE__?.held === true",
    "Old album queue setup was not captured",
  );
  const oldQueueHeld = await page.evaluate(
    "return window.__ARLET_AUDIT_QUEUE__.held;",
  );
  await route(
    page,
    "#/playlist/playlist-1",
    `document.querySelector(".library-track-row")?.textContent.includes("Track A")`,
    15_000,
  );
  await page.evaluate(
    'document.querySelector(".library-track-row")?.click(); return true;',
  );
  await required(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().queue.items[0]?.id === "song-a" && document.querySelector(${q(NOW_PLAYING)})?.textContent === "Track A"`,
    "New playlist queue did not start on Track A",
    15_000,
  );
  const newerQueue = await state(page);
  await page.evaluate(`
    const error = new Error("One or more items could not be resolved: album-a");
    error.errorCode = "NOT_FOUND";
    error.data = [{ id: "album-a" }];
    const audit = window.__ARLET_AUDIT_QUEUE__;
    audit.released = true;
    audit.reject(error);
    return true;
  `);
  await sleep(600);
  const afterOldFailure = await state(page);
  const retriedCalls = await page.evaluate(
    "return window.__ARLET_AUDIT_QUEUE__.retries;",
  );
  const preconditions = {
    oldQueueHeld,
    newerQueueOwned: newerQueue.queueIds[0] === "song-a",
    newerTrackVisible: newerQueue.current === "Track A",
  };
  const preconditionsMet = Object.values(preconditions).filter(Boolean).length;
  check(
    "an unresolved queue from an older Play cannot retry after a newer Play succeeds",
    preconditionsMet === Object.keys(preconditions).length &&
      retriedCalls.length === 0 &&
      afterOldFailure.queueIds[0] === "song-a" &&
      afterOldFailure.current === "Track A",
    {
      preconditions,
      preconditionsMet,
      expectedPreconditions: Object.keys(preconditions).length,
      newerQueue,
      afterOldFailure,
      retriedCalls,
    },
  );
  return { newerQueue, afterOldFailure, retriedCalls, preconditions };
}

async function releaseNotesWork(page, check) {
  await fresh(page);
  const assetsDir = path.join(ROOT, "dist", "assets");
  const asset = fs
    .readdirSync(assetsDir)
    .find((name) => /^ReleaseNotes-.*\.js$/u.test(name));
  if (!asset) throw new Error("Bundled release notes module is missing");
  const observation = await page.evaluate(
    `
      const module = await import(${q(`/assets/${asset}`)});
      const textOf = (node) => {
        if (typeof node === "string" || typeof node === "number") return String(node);
        if (Array.isArray(node)) return node.map(textOf).join("");
        if (!node || typeof node !== "object") return "";
        return textOf(node.props?.children);
      };
      const inspect = (node, tags, attributes) => {
        if (Array.isArray(node)) {
          for (const child of node) inspect(child, tags, attributes);
          return;
        }
        if (!node || typeof node !== "object") return;
        if (typeof node.type === "string") tags.add(node.type);
        for (const key of Object.keys(node.props ?? {})) {
          if (key === "href" || key === "src") attributes.add(key);
        }
        inspect(node.props?.children, tags, attributes);
      };
      const timings = [];
      for (const length of [2048, 4096, 8192, 16384, 32768, 65520]) {
        const markdown = "prefix " + String.fromCharCode(96).repeat(length);
        const bytes = new TextEncoder().encode(markdown).length;
        const started = performance.now();
        const tree = module.ReleaseNotes({ markdown });
        const durationMs = performance.now() - started;
        timings.push({
          length,
          bytes,
          durationMs,
          retained: textOf(tree) === markdown,
        });
      }
      const sample = module.ReleaseNotes({
        markdown: "**bold** *italic* " + String.fromCharCode(96) + "code" + String.fromCharCode(96) + " [label](https://example.invalid/path)",
      });
      const tags = new Set();
      const attributes = new Set();
      inspect(sample, tags, attributes);
      return {
        timings,
        maxBytes: timings.at(-1)?.bytes ?? 0,
        largestRunRetained: timings.at(-1)?.retained === true,
        ordinaryText: textOf(sample),
        tags: [...tags],
        attributes: [...attributes],
      };
    `,
    { timeoutMs: 30_000 },
  );
  const largest = observation.timings.at(-1);
  const ordinaryInlineAndLinks =
    observation.ordinaryText === "bold italic code label" &&
    observation.tags.includes("strong") &&
    observation.tags.includes("em") &&
    observation.tags.includes("code") &&
    observation.tags.includes("span") &&
    !observation.tags.includes("a") &&
    !observation.tags.includes("img") &&
    observation.attributes.length === 0;
  check(
    "unmatched release-note backticks stay literal within the large-input budget",
    observation.maxBytes === 65_527 &&
      observation.largestRunRetained &&
      observation.timings.every((entry) => entry.retained) &&
      (largest?.durationMs ?? Number.POSITIVE_INFINITY) <= 1000,
    observation,
  );
  check(
    "release-note inline markup remains safe and inert",
    ordinaryInlineAndLinks,
    observation,
  );
  return observation;
}

function settingsSaveFailureCount(logPath) {
  if (!fs.existsSync(logPath)) return 0;
  const content = fs.readFileSync(logPath, "utf8");
  return content.match(/Settings save failed:/gu)?.length ?? 0;
}

function readSettings(settingsPath) {
  return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
}

function removeOwnedEmptyDirectory(directory, owned) {
  if (!owned || !fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      "Owned settings fault path is no longer an empty directory",
    );
  }
  if (fs.readdirSync(directory).length > 0) {
    throw new Error(
      "Owned settings fault directory contains unexpected entries",
    );
  }
  fs.rmdirSync(directory);
}

async function waitForSettingsValue(
  settingsPath,
  key,
  value,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  let settingsValue;
  while (Date.now() < deadline) {
    settingsValue = readSettings(settingsPath)[key];
    if (settingsValue === value) return true;
    await sleep(50);
  }
  return false;
}

async function selectTheme(page, theme) {
  const selected = await page.evaluate(`
    const select = document.querySelector(${q(`${SETTINGS_SECTION} select`)});
    if (!select) return false;
    select.value = ${q(theme)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  `);
  if (!selected) throw new Error("Appearance theme selector is missing");
}

async function volumeSaveFailure(
  page,
  check,
  settingsPath,
  logPath,
  faultPath,
  artifactDir,
) {
  const before = readSettings(settingsPath);
  const failureCountBefore = settingsSaveFailureCount(logPath);
  const targetVolume = before.volume > 0.5 ? 0.42 : 0.73;
  const targetLabel = `${Math.round(targetVolume * 100)}%`;
  await page.evaluate(`
    window.__ARLET_AUDIT_VOLUME_UNHANDLED__ = [];
    window.addEventListener("unhandledrejection", (event) => {
      window.__ARLET_AUDIT_VOLUME_UNHANDLED__.push(String(event.reason?.message ?? event.reason));
    });
    const slider = document.querySelector('input[aria-label="Volume"]');
    if (!slider) throw new Error("Volume slider is missing");
    slider.value = ${q(String(targetVolume))};
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  await required(
    page,
    `document.querySelector('input[aria-label="Volume"]')?.getAttribute("aria-valuetext") === ${q(targetLabel)}`,
    "Volume change did not reach playback state",
  );
  const deadline = Date.now() + 5000;
  while (
    settingsSaveFailureCount(logPath) <= failureCountBefore &&
    Date.now() < deadline
  ) {
    await sleep(50);
  }
  await sleep(350);
  const failureCountAfter = settingsSaveFailureCount(logPath);
  const fileVolume = readSettings(settingsPath).volume;
  const ui = await page.evaluate(`
    return {
      volumeText: document.querySelector('input[aria-label="Volume"]')?.getAttribute("aria-valuetext") ?? null,
      unhandled: window.__ARLET_AUDIT_VOLUME_UNHANDLED__ ?? [],
      errors: [...document.querySelectorAll(".action-toast:not(.action-toast-success) .action-toast-message")]
        .map((node) => node.textContent),
    };
  `);
  const observation = {
    beforeVolume: before.volume,
    requestedVolume: targetVolume,
    persistedVolume: fileVolume,
    failureCountBefore,
    failureCountAfter,
    faultPathPresent: fs.existsSync(faultPath),
    ui,
  };
  check(
    "volume save failure is recorded without an unhandled input rejection",
    failureCountAfter > failureCountBefore &&
      fileVolume === before.volume &&
      ui.volumeText === targetLabel &&
      ui.unhandled.length === 0,
    observation,
  );
  await saveScreenshot(
    page,
    artifactDir,
    "screenshot-audit-regressions-volume-error.png",
  );
  await page.evaluate(`
    for (const button of document.querySelectorAll('.action-toast button[aria-label="Dismiss"]')) button.click();
    return true;
  `);
  await waitFor(page, "!document.querySelector('.action-toast')", 2000);
  return observation;
}

async function settingsSave(page, check, dataDir, logDir, artifactDir) {
  await fresh(page);
  await settings(page);
  const settingsPath = path.join(dataDir, "settings.json");
  const logPath = path.join(logDir, "arlet.log");
  const faultPath = path.join(dataDir, "settings.json.tmp");
  const before = readSettings(settingsPath);
  const rejectedTheme = THEMES.find((theme) => theme !== before.theme);
  const recoveredTheme = THEMES.find(
    (theme) => theme !== before.theme && theme !== rejectedTheme,
  );
  if (!rejectedTheme || !recoveredTheme) {
    throw new Error(`Unexpected saved theme: ${String(before.theme)}`);
  }
  if (fs.existsSync(faultPath)) {
    throw new Error(
      "Settings temporary path is already occupied; fault not installed",
    );
  }
  fs.mkdirSync(faultPath);
  const faultOwned = true;
  let volume;
  let failedSave;
  try {
    volume = await volumeSaveFailure(
      page,
      check,
      settingsPath,
      logPath,
      faultPath,
      artifactDir,
    );
    const failureCountBefore = settingsSaveFailureCount(logPath);
    await selectTheme(page, rejectedTheme);
    const deadline = Date.now() + 5000;
    while (
      settingsSaveFailureCount(logPath) <= failureCountBefore &&
      Date.now() < deadline
    ) {
      await sleep(50);
    }
    await required(
      page,
      `document.querySelector(${q(`${SETTINGS_SECTION} select`)})?.value === ${q(rejectedTheme)}`,
      "Requested theme was not reflected in Settings",
    );
    const nativeFailureObserved =
      settingsSaveFailureCount(logPath) > failureCountBefore;
    const visibleError = await waitFor(
      page,
      `Boolean(document.querySelector(".action-toast:not(.action-toast-success) .action-toast-message"))`,
      3000,
    );
    const saved = readSettings(settingsPath);
    const ui = await page.evaluate(`
      return {
        theme: document.documentElement.dataset.theme ?? null,
        errors: [...document.querySelectorAll(".action-toast:not(.action-toast-success) .action-toast-message")]
          .map((node) => node.textContent),
      };
    `);
    failedSave = {
      nativeFailureObserved,
      beforeTheme: before.theme,
      requestedTheme: rejectedTheme,
      savedTheme: saved.theme,
      visibleError,
      ui,
    };
    check(
      "failed native settings saves keep the persisted value and show visible error feedback",
      nativeFailureObserved &&
        saved.theme === before.theme &&
        visibleError &&
        ui.errors.length > 0,
      failedSave,
    );
    await saveScreenshot(
      page,
      artifactDir,
      "screenshot-audit-regressions-settings-error.png",
    );
  } finally {
    removeOwnedEmptyDirectory(faultPath, faultOwned);
  }

  await selectTheme(page, recoveredTheme);
  const recovered = await waitForSettingsValue(
    settingsPath,
    "theme",
    recoveredTheme,
  );
  const afterRecovery = readSettings(settingsPath);
  check(
    "settings writes recover after the owned native fault path is removed",
    recovered &&
      afterRecovery.theme === recoveredTheme &&
      !fs.existsSync(faultPath),
    {
      recovered,
      recoveredTheme,
      afterRecovery,
      faultPathPresent: fs.existsSync(faultPath),
    },
  );
  return { before, volume, failedSave, recoveredTheme, afterRecovery };
}

function writeObservations(artifactDir, results) {
  fs.writeFileSync(
    path.join(artifactDir, "audit-regressions-observations.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
}

export async function runAuditRegressions({
  page,
  check,
  artifactDir,
  dataDir,
  logDir,
}) {
  fs.mkdirSync(artifactDir, { recursive: true });
  const results = {};
  const cases = [
    ["stale-probe", (p, c) => staleProbe(p, c)],
    ["late-authorization", (p, c) => lateAuthorization(p, c)],
    ["stale-queue-retry", (p, c) => staleQueueRetry(p, c)],
    ["release-notes-work", (p, c) => releaseNotesWork(p, c)],
    [
      "settings-save",
      (p, c) => settingsSave(p, c, dataDir, logDir, artifactDir),
    ],
  ];
  for (const [name, run] of cases) {
    try {
      results[name] = await run(page, check);
    } catch (error) {
      results[name] = { setupError: String(error?.message ?? error) };
      check(`audit regressions: ${name} completes`, false, results[name]);
    } finally {
      try {
        await saveScreenshot(
          page,
          artifactDir,
          `screenshot-audit-regressions-${name}.png`,
        );
      } catch (error) {
        results[name] ??= {};
        results[name].screenshotError = String(error?.message ?? error);
      }
      writeObservations(artifactDir, results);
      try {
        await fresh(page);
      } catch (error) {
        results[name].cleanupError = String(error?.message ?? error);
        writeObservations(artifactDir, results);
        check(
          `audit regressions: ${name} cleanup reloads a healthy fixture`,
          false,
          {
            error: results[name].cleanupError,
          },
        );
      }
    }
  }
  const final = await state(page);
  check(
    "audit regressions end with a healthy signed-in fixture",
    final.authorized && final.status.includes("Connected") && !final.banner,
    final,
  );
  results.final = final;
  writeObservations(artifactDir, results);
}
