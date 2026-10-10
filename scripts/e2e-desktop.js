/* Desktop controls: sleep timer, system-media routing, and autoplay. Failure
 * modes live in docs/TESTING.md ("Desktop controls"). Native SMTC and tray
 * items cannot be driven from DevTools, so the system-media checks inject the
 * same Tauri events the Rust side emits, through the listeners the app has
 * registered. The tray and the SMTC flyout are release-only evidence. */

const PAUSED = 4;
const PLAYING = 5;
const FIFTEEN_MINUTES_MS = 15 * 60_000;
// The 15-minute timer is shortened only while the scenario runs, so the
// fire path is exercised without waiting a quarter of an hour.
const FAST_TIMER_MS = 1500;

/**
 * Injected before the app loads. Records the Tauri listen registrations
 * (event name and handler id) from the IPC request, so the scenario can emit
 * events to the same callbacks Rust would reach. Tauri's `invoke` is not
 * writable, so the transport is observed instead: the custom-protocol fetch,
 * or the WebView2 postMessage fallback.
 */
export function recordTauriEvents() {
  if (window.__ARLET_E2E_TAURI_EVENTS__) return;
  const handlers = new Map();
  const seen = [];
  const record = (command, args) => {
    seen.push(command);
    if (seen.length > 50) seen.shift();
    if (
      command === "plugin:event|listen" &&
      typeof args?.event === "string" &&
      typeof args.handler === "number"
    ) {
      handlers.set(args.event, [
        ...(handlers.get(args.event) ?? []),
        args.handler,
      ]);
    }
  };
  const parse = (body) => {
    try {
      return typeof body === "string" ? JSON.parse(body) : undefined;
    } catch {
      return undefined;
    }
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const url = new URL(String(input?.url ?? input));
      if (url.hostname === "ipc.localhost") {
        record(decodeURIComponent(url.pathname.slice(1)), parse(init?.body));
      }
    } catch {
      // Recording must never break the app's own IPC.
    }
    return nativeFetch(input, init);
  };
  const webview = window.chrome?.webview;
  if (webview && typeof webview.postMessage === "function") {
    const nativePost = webview.postMessage.bind(webview);
    try {
      webview.postMessage = (message) => {
        try {
          const parsed = parse(message);
          if (parsed?.cmd) record(parsed.cmd, parsed.payload);
        } catch {
          // Recording must never break the app's own IPC.
        }
        return nativePost(message);
      };
    } catch {
      // A read-only postMessage leaves only the fetch path recorded.
    }
  }
  window.__ARLET_E2E_TAURI_EVENTS__ = {
    emit(event, payload) {
      const ids = handlers.get(event) ?? [];
      for (const id of ids) {
        window.__TAURI_INTERNALS__.runCallback(id, { event, id: 0, payload });
      }
      return ids.length;
    },
    debug() {
      return { events: [...handlers.keys()], commands: [...seen] };
    },
  };
}

export const desktopEventRecorderSource = `(${recordTauriEvents.toString()})();`;

async function waitFor(page, expression, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(`return Boolean(${expression});`)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

const transitionTypes = (page) =>
  page.evaluate(
    "return window.__ARLET_E2E_MUSIC__.snapshot().transitions.map((t) => t.type);",
  );

async function pauseCount(page) {
  return (await transitionTypes(page)).filter((type) => type === "pause")
    .length;
}

async function startPlayback(page, songs) {
  await page.evaluate(`
    const music = window.MusicKit.getInstance();
    await music.setQueue({ songs: ${JSON.stringify(songs)} });
    await music.play();
    return true;`);
  return waitFor(
    page,
    "window.MusicKit.getInstance().playbackState === " + PLAYING,
  );
}

async function resumePlayback(page) {
  await page.evaluate(
    "await window.MusicKit.getInstance().play(); return true;",
  );
  return waitFor(
    page,
    "window.MusicKit.getInstance().playbackState === " + PLAYING,
  );
}

/** Opens the sleep menu if needed and clicks the item with this label. */
async function chooseSleepOption(page, label) {
  await page.evaluate(`
    if (!document.querySelector('.sleep-timer-menu')) {
      document.querySelector('button[aria-label="Sleep timer"]')?.click();
    }
    return true;`);
  const menuShown = await waitFor(
    page,
    "document.querySelector('.sleep-timer-menu')",
  );
  const clicked = await page.evaluate(`
    const item = [...document.querySelectorAll('.sleep-timer-menu [role=menuitem]')]
      .find((node) => node.textContent.trim() === ${JSON.stringify(label)});
    item?.click();
    return Boolean(item);`);
  return menuShown && clicked;
}

const sleepLabelShown = (page, text) =>
  waitFor(
    page,
    `[...document.querySelectorAll('.sleep-timer-label')].some((node) => node.textContent.trim() === ${JSON.stringify(text)})`,
    2000,
  );

const sleepLabelCleared = (page) =>
  waitFor(page, "!document.querySelector('.sleep-timer-label')", 3000);

async function openSettings(page) {
  await page.evaluate(
    "document.querySelector('button[aria-label=Settings]')?.click(); return true;",
  );
  return waitFor(page, "document.querySelector('.settings-layout')", 5000);
}

const labelExists = (text) =>
  `[...document.querySelectorAll('label')].some((node) => node.textContent.includes(${JSON.stringify(text)}))`;

function clickToggle(text) {
  return `
    const input = [...document.querySelectorAll('label')]
      .find((node) => node.textContent.includes(${JSON.stringify(text)}))
      ?.querySelector('input[type=checkbox]');
    input?.click();
    return Boolean(input);`;
}

const savedSettings = (page) =>
  page.evaluate(
    'return JSON.parse(await window.__TAURI_INTERNALS__.invoke("load_settings"));',
  );

/** Saves are asynchronous; poll the file until the key reads as expected. */
async function waitForSetting(page, key, value, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await savedSettings(page))[key] === value) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Emits a system-media event the way the Rust side does. */
const emitNative = (page, event, payload) =>
  page.evaluate(
    `return window.__ARLET_E2E_TAURI_EVENTS__.emit(${JSON.stringify(event)}, ${JSON.stringify(payload)}) > 0;`,
  );

export async function runDesktop({ page, check }) {
  try {
    await page.evaluate(`
      window.__ARLET_E2E_MUSIC__.reset();
      window.__ARLET_E2E_NATIVE_SET_TIMEOUT__ ??= window.setTimeout;
      const native = window.__ARLET_E2E_NATIVE_SET_TIMEOUT__;
      window.setTimeout = (callback, delay, ...rest) =>
        native(callback, delay === ${FIFTEEN_MINUTES_MS} ? ${FAST_TIMER_MS} : delay, ...rest);
      return true;`);

    // Minutes timer: fires and pauses.
    await startPlayback(page, ["song-a", "song-c"]);
    const beforeFire = await pauseCount(page);
    const picked = await chooseSleepOption(page, "15 minutes");
    const armed = await sleepLabelShown(page, "15 min");
    const paused = await waitFor(
      page,
      `window.__ARLET_E2E_MUSIC__.snapshot().transitions.filter((t) => t.type === "pause").length > ${beforeFire}`,
      5000,
    );
    const cleared = await sleepLabelCleared(page);
    check(
      "sleep timer pauses when its minutes elapse",
      picked && armed && paused && cleared,
      { picked, armed, paused, cleared },
    );

    // Cancel: the armed timer must never pause playback.
    await resumePlayback(page);
    const beforeCancel = await pauseCount(page);
    await chooseSleepOption(page, "15 minutes");
    const armedAgain = await sleepLabelShown(page, "15 min");
    const cancelled = await chooseSleepOption(page, "Off");
    await new Promise((resolve) => setTimeout(resolve, FAST_TIMER_MS + 700));
    const pausedAfterCancel = (await pauseCount(page)) > beforeCancel;
    const stillPlaying = await page.evaluate(
      `return window.MusicKit.getInstance().playbackState === ${PLAYING};`,
    );
    check(
      "cancelling the sleep timer prevents the pause",
      armedAgain && cancelled && !pausedAfterCancel && stillPlaying,
      { armedAgain, cancelled, pausedAfterCancel, stillPlaying },
    );

    // End of track: pauses at the next item change, before the next song's start.
    await startPlayback(page, ["song-a", "song-c"]);
    const armedEnd = await chooseSleepOption(page, "End of track");
    const endLabel = await sleepLabelShown(page, "End of track");
    await page.evaluate(
      "window.__ARLET_E2E_MUSIC__.finishCurrentTrack(); return true;",
    );
    const pausedAtNext = await waitFor(
      page,
      `(() => {
        const t = window.__ARLET_E2E_MUSIC__.snapshot().transitions;
        const next = t.findIndex((x) => x.type === "finishNext");
        return next >= 0 && t.slice(next + 1).some((x) => x.type === "pause");
      })()`,
      3000,
    );
    const pausedState = await page.evaluate(
      `return window.MusicKit.getInstance().playbackState === ${PAUSED};`,
    );
    const endCleared = await sleepLabelCleared(page);
    check(
      "end of track pauses at the next track change",
      armedEnd && endLabel && pausedAtNext && pausedState && endCleared,
      { armedEnd, endLabel, pausedAtNext, pausedState, endCleared },
    );

    // End of track at queue end: the timer ends with playback and clears.
    await startPlayback(page, ["song-c"]);
    await chooseSleepOption(page, "End of track");
    await sleepLabelShown(page, "End of track");
    await page.evaluate(
      "window.__ARLET_E2E_MUSIC__.finishCurrentTrack(); return true;",
    );
    const queueEndCleared = await sleepLabelCleared(page);
    check(
      "end of track clears the timer when the queue runs out",
      queueEndCleared,
      { queueEndCleared },
    );

    // Autoplay keeps playback going past the queue end when it is enabled.
    await startPlayback(page, ["song-c"]);
    await page.evaluate(
      "window.__ARLET_E2E_MUSIC__.finishWithAutoplay(); return true;",
    );
    const continued = await waitFor(
      page,
      `window.MusicKit.getInstance().playbackState === ${PLAYING} && window.__ARLET_E2E_MUSIC__.snapshot().transitions.some((t) => t.type === "finishAutoplay")`,
      3000,
    );
    check("autoplay continues past the queue end when enabled", continued);

    // System-media requests route to the controller; invalid seeks are dropped.
    await startPlayback(page, ["song-a", "song-c"]);
    await page.evaluate(
      "window.MusicKit.getInstance().seekToTime(10); return true;",
    );
    await waitFor(
      page,
      "window.__ARLET_E2E_MUSIC__.snapshot().transitions.some((t) => t.type === 'seekToTime' && t.seconds === 10)",
      3000,
    );
    const seeksBefore = await page.evaluate(
      "return window.__ARLET_E2E_MUSIC__.snapshot().transitions.filter((t) => t.type === 'seekToTime').length;",
    );
    const emitted = await page.evaluate(`
      const events = window.__ARLET_E2E_TAURI_EVENTS__;
      if (!events) return false;
      events.emit("windows-media-seek", 999);
      events.emit("windows-media-seek", NaN);
      events.emit("windows-media-seek", -5);
      // Sentinel: handled after the bad requests, so once it lands any
      // seek they caused would already be recorded.
      events.emit("windows-media-seek", 10);
      return true;`);
    const seekApplied = await waitFor(
      page,
      "window.__ARLET_E2E_MUSIC__.snapshot().transitions.some((t) => t.type === 'seekToTime' && t.seconds === 10)",
      3000,
    );
    const seeks = await page.evaluate(
      "return window.__ARLET_E2E_MUSIC__.snapshot().transitions.filter((t) => t.type === 'seekToTime').map((t) => t.seconds);",
    );
    check(
      "system seek clamps to the duration and drops NaN or negative requests",
      emitted &&
        seekApplied &&
        seeks.length === seeksBefore + 2 &&
        seeks.at(-2) === 180 &&
        seeks.at(-1) === 10,
      {
        emitted,
        seekApplied,
        seeksBefore,
        seeks,
        recorder: await page.evaluate(
          "return window.__ARLET_E2E_TAURI_EVENTS__?.debug?.();",
        ),
      },
    );

    const shuffleOn = await emitNative(page, "windows-media-shuffle", true);
    const shuffleOnApplied = await waitFor(
      page,
      "window.__ARLET_E2E_MUSIC__.snapshot().modes.shuffle === true",
      3000,
    );
    const repeatAll = await emitNative(page, "windows-media-repeat", "all");
    const repeatAllApplied = await waitFor(
      page,
      "window.__ARLET_E2E_MUSIC__.snapshot().modes.repeat === 1",
      3000,
    );
    const repeatOne = await emitNative(page, "windows-media-repeat", "one");
    const repeatOneApplied = await waitFor(
      page,
      "window.__ARLET_E2E_MUSIC__.snapshot().modes.repeat === 2",
      3000,
    );
    await emitNative(page, "windows-media-repeat", "loop");
    // Sentinel: the shuffle event is handled after "loop", so once it lands
    // the unknown repeat value has been processed too.
    await emitNative(page, "windows-media-shuffle", false);
    await waitFor(
      page,
      "window.__ARLET_E2E_MUSIC__.snapshot().modes.shuffle === false",
      3000,
    );
    const unknownRepeatIgnored = await page.evaluate(
      "return window.__ARLET_E2E_MUSIC__.snapshot().modes.repeat === 2;",
    );
    await emitNative(page, "windows-media-repeat", "off");
    check(
      "system shuffle and repeat requests reach MusicKit",
      shuffleOn &&
        shuffleOnApplied &&
        repeatAll &&
        repeatAllApplied &&
        repeatOne &&
        repeatOneApplied &&
        unknownRepeatIgnored,
      {
        shuffleOnApplied,
        repeatAllApplied,
        repeatOneApplied,
        unknownRepeatIgnored,
      },
    );

    // Settings: autoplay is applied, saved on success, and hidden when the
    // runtime has no writable autoplay.
    const settingsOpen = await openSettings(page);
    const autoplayShown = await waitFor(page, labelExists("Autoplay"), 5000);
    const trayToggleShown = await waitFor(
      page,
      labelExists("Show tray icon"),
      3000,
    );
    await page.evaluate(clickToggle("Autoplay"));
    const autoplayOff = await waitFor(
      page,
      "window.MusicKit.getInstance().autoplayEnabled === false",
      3000,
    );
    const savedOff = await waitForSetting(page, "autoplay", false);
    await page.evaluate(clickToggle("Autoplay"));
    const autoplayOn = await waitFor(
      page,
      "window.MusicKit.getInstance().autoplayEnabled === true",
      3000,
    );
    const savedOn = await waitForSetting(page, "autoplay", true);
    check(
      "autoplay toggle applies and saves the runtime setting",
      settingsOpen &&
        autoplayShown &&
        autoplayOff &&
        savedOff &&
        autoplayOn &&
        savedOn,
      {
        settingsOpen,
        autoplayShown,
        autoplayOff,
        savedOff,
        autoplayOn,
        savedOn,
      },
    );

    await page.evaluate(
      "window.__ARLET_E2E_MUSIC__.setAutoplayAvailable(false); return true;",
    );
    const hiddenWhenUnsupported = await waitFor(
      page,
      `!(${labelExists("Autoplay")})`,
      3000,
    );
    await page.evaluate(
      "window.__ARLET_E2E_MUSIC__.setAutoplayAvailable(true); return true;",
    );
    const shownAgain = await waitFor(page, labelExists("Autoplay"), 3000);
    check(
      "autoplay toggle is hidden when the runtime lacks autoplay",
      hiddenWhenUnsupported && shownAgain,
      { hiddenWhenUnsupported, shownAgain },
    );

    // The tray is on by default; turning it off and on again exercises the
    // runtime icon removal and reinstall.
    await page.evaluate(clickToggle("Show tray icon"));
    const trayOff = await waitForSetting(page, "trayIcon", false);
    await page.evaluate(clickToggle("Show tray icon"));
    const trayOn = await waitForSetting(page, "trayIcon", true);
    check(
      "tray icon toggle saves its setting",
      trayToggleShown && trayOff && trayOn,
      { trayToggleShown, trayOff, trayOn },
    );

    await page.evaluate("location.hash = '#/home'; return true;");
  } finally {
    await page.evaluate(`
      if (window.__ARLET_E2E_NATIVE_SET_TIMEOUT__) {
        window.setTimeout = window.__ARLET_E2E_NATIVE_SET_TIMEOUT__;
      }
      window.__ARLET_E2E_MUSIC__?.setAutoplayAvailable(true);
      return true;`);
  }
}
