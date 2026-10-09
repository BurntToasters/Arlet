#!/usr/bin/env node

// Keyboard and transport over the injected MusicKit fixture. Keys go through
// CDP Input events so the real window keydown listener and focus rules run.
const ALBUM_ID = "album-1";
const ALBUM_TRACK_IDS = ["album-a", "album-b", "album-c", "album-d"];
const CTRL = 2;
const SHIFT = 8;

const KEY = {
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  m: { key: "m", code: "KeyM", keyCode: 77, text: "m" },
  k: { key: "k", code: "KeyK", keyCode: 75 },
  arrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  arrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
};

async function waitFor(page, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(`return Boolean(${expression});`)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function press(page, key, modifiers = 0) {
  const base = {
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    modifiers,
  };
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...base,
    ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
  });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(150);
}

async function clickButton(page, label) {
  return page.evaluate(`
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === ${JSON.stringify(label)},
    );
    button?.click();
    return Boolean(button);
  `);
}

async function snapshot(page) {
  return page.evaluate("return window.__ARLET_E2E_MUSIC__.snapshot();");
}

function since(before, after) {
  return after.transitions.slice(before.transitions.length);
}

const TITLE = `document.querySelector(".player-bar .player-track-copy strong")?.textContent`;
const PLAY_LABEL = `document.querySelector(".play-button")?.getAttribute("aria-label")`;
const VOLUME_VALUE = `document.querySelector('input[aria-label="Volume"]')?.value`;
const MUTE_PRESSED = `document.querySelector(".volume-mute-button")?.getAttribute("aria-pressed")`;

/** Exercises shortcut routing, transport, mute, and shuffle play end to end. */
export async function runTransport({ page, check }) {
  await page.evaluate(`
    window.__ARLET_E2E_MUSIC__.reset();
    if (!window.__ARLET_E2E_INVOKES__) {
      window.__ARLET_E2E_INVOKES__ = [];
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (command, args, options) => {
        window.__ARLET_E2E_INVOKES__.push(command);
        return invoke.call(window.__TAURI_INTERNALS__, command, args, options);
      };
    }
    location.hash = "#/album/${ALBUM_ID}";
    return true;
  `);
  const albumReady = await waitFor(
    page,
    `document.querySelectorAll(".library-track-row").length >= 2 && document.querySelector(".library-detail-hero h1")?.textContent === "Fixture Album"`,
  );
  check("transport scenario renders the album detail", albumReady);
  if (!albumReady) return;

  await clickButton(page, "Play all");
  const started = await waitFor(
    page,
    `${TITLE} === "Album Track A" && ${PLAY_LABEL} === "Pause"`,
  );
  await page.evaluate(`document.activeElement?.blur(); return true;`);
  check("Play all starts the album and shows Pause", started);
  if (!started) return;

  const beforeSearch = await snapshot(page);
  await press(page, KEY.k, CTRL);
  const searchFocused = await waitFor(
    page,
    `document.activeElement === document.querySelector(".search-form input")`,
  );
  await press(page, KEY.space);
  const searchValue = await page.evaluate(
    `return document.querySelector(".search-form input")?.value ?? null;`,
  );
  const afterSearch = await snapshot(page);
  const searchTransitions = since(beforeSearch, afterSearch);
  check(
    "typing a space in the search box does not toggle playback",
    searchFocused &&
      searchValue === " " &&
      searchTransitions.every(
        (item) => item.type !== "pause" && item.type !== "play",
      ) &&
      (await page.evaluate(`return ${PLAY_LABEL} === "Pause";`)),
    { searchValue, transitions: searchTransitions },
  );
  await page.evaluate(`
    const input = document.querySelector(".search-form input");
    if (input) input.value = "";
    document.activeElement?.blur();
    return true;
  `);

  const beforePause = await snapshot(page);
  await press(page, KEY.space);
  const paused = await waitFor(page, `${PLAY_LABEL} === "Play"`);
  const afterPause = await snapshot(page);
  check(
    "Space pauses playback once",
    paused &&
      since(beforePause, afterPause).filter((item) => item.type === "pause")
        .length === 1,
    { transitions: since(beforePause, afterPause) },
  );
  await press(page, KEY.space);
  const resumed = await waitFor(page, `${PLAY_LABEL} === "Pause"`);
  const afterResume = await snapshot(page);
  check(
    "Space resumes playback once",
    resumed &&
      since(afterPause, afterResume).filter((item) => item.type === "play")
        .length === 1,
    { transitions: since(afterPause, afterResume) },
  );

  const beforeNext = await snapshot(page);
  await press(page, KEY.arrowRight, CTRL);
  const nextShown = await waitFor(page, `${TITLE} === "Album Track B"`);
  const afterNext = await snapshot(page);
  check(
    "Ctrl+ArrowRight advances to the next queue item",
    nextShown &&
      since(beforeNext, afterNext).some(
        (item) => item.type === "next" && item.index === 1,
      ),
    { transitions: since(beforeNext, afterNext) },
  );
  await press(page, KEY.arrowLeft, CTRL);
  const previousShown = await waitFor(page, `${TITLE} === "Album Track A"`);
  const afterPrevious = await snapshot(page);
  check(
    "Ctrl+ArrowLeft returns to the previous queue item",
    previousShown &&
      since(afterNext, afterPrevious).some(
        (item) => item.type === "previous" && item.index === 0,
      ),
    { transitions: since(afterNext, afterPrevious) },
  );

  const beforeSeek = await snapshot(page);
  await press(page, KEY.arrowRight, SHIFT);
  const seekForward = await waitFor(
    page,
    `document.querySelector('[aria-label="Playback position"]')?.value === "10"`,
  );
  await press(page, KEY.arrowLeft, SHIFT);
  const seekBack = await waitFor(
    page,
    `document.querySelector('[aria-label="Playback position"]')?.value === "0"`,
  );
  const seeks = since(beforeSeek, await snapshot(page))
    .filter((item) => item.type === "seekToTime")
    .map((item) => item.seconds);
  check(
    "Shift+ArrowRight and Shift+ArrowLeft seek by 10 seconds",
    seekForward && seekBack && JSON.stringify(seeks) === "[10,0]",
    { seeks },
  );

  const beforeVolume = await snapshot(page);
  await press(page, KEY.arrowDown, CTRL);
  const lowered = await waitFor(page, `${VOLUME_VALUE} === "0.95"`);
  const afterVolume = await snapshot(page);
  check(
    "Ctrl+ArrowDown lowers the volume by 0.05",
    lowered &&
      Math.abs(afterVolume.volume - 0.95) < 1e-6 &&
      since(beforeVolume, afterVolume).some(
        (item) => item.type === "volume" && Math.abs(item.value - 0.95) < 1e-6,
      ),
    { transitions: since(beforeVolume, afterVolume) },
  );

  // Let the debounced settings write from the volume change settle first.
  await sleep(600);
  const savesBeforeMute = await page.evaluate(
    `return window.__ARLET_E2E_INVOKES__.filter((item) => item === "save_settings").length;`,
  );
  await press(page, KEY.m);
  const muted = await waitFor(
    page,
    `${MUTE_PRESSED} === "true" && ${VOLUME_VALUE} === "0"`,
  );
  const mutedSnapshot = await snapshot(page);
  await press(page, KEY.m);
  const unmuted = await waitFor(
    page,
    `${MUTE_PRESSED} === "false" && ${VOLUME_VALUE} === "0.95"`,
  );
  await sleep(600);
  const afterUnmute = await snapshot(page);
  const savesAfterUnmute = await page.evaluate(
    `return window.__ARLET_E2E_INVOKES__.filter((item) => item === "save_settings").length;`,
  );
  check(
    "mute silences output, unmute restores the level, and settings are not rewritten",
    muted &&
      unmuted &&
      mutedSnapshot.volume === 0 &&
      Math.abs(afterUnmute.volume - 0.95) < 1e-6 &&
      savesAfterUnmute === savesBeforeMute,
    {
      muted: mutedSnapshot.volume,
      restored: afterUnmute.volume,
      saves: [savesBeforeMute, savesAfterUnmute],
    },
  );
  await press(page, KEY.arrowUp, CTRL);
  await waitFor(page, `${VOLUME_VALUE} === "1"`);

  await page.evaluate(`
    location.hash = "#/album/${ALBUM_ID}";
    return true;
  `);
  const albumAgain = await waitFor(
    page,
    `document.querySelectorAll(".library-track-row").length >= 2 && [...document.querySelectorAll(".library-detail-actions button")].some((item) => item.textContent?.trim() === "Shuffle")`,
  );
  const beforeShuffle = await snapshot(page);
  await clickButton(page, "Shuffle");
  const shuffleStarted = await waitFor(
    page,
    `document.querySelector('button[aria-label="Toggle shuffle"]')?.getAttribute("aria-pressed") === "true" && ${PLAY_LABEL} === "Pause"`,
  );
  const afterShuffle = await snapshot(page);
  const shuffleSet = since(beforeShuffle, afterShuffle)
    .filter((item) => item.type === "setQueue")
    .at(-1);
  check(
    "Shuffle play keeps shuffle on and queues the full album",
    albumAgain &&
      shuffleStarted &&
      afterShuffle.modes.shuffle === true &&
      JSON.stringify([...(shuffleSet?.ids ?? [])].sort()) ===
        JSON.stringify([...ALBUM_TRACK_IDS].sort()),
    {
      modes: afterShuffle.modes,
      setQueue: shuffleSet,
      queue: afterShuffle.queue,
    },
  );
  await page.evaluate(`
    document.querySelector('button[aria-label="Toggle shuffle"]')?.click();
    return true;
  `);
  await waitFor(
    page,
    `document.querySelector('button[aria-label="Toggle shuffle"]')?.getAttribute("aria-pressed") === "false"`,
  );
}
