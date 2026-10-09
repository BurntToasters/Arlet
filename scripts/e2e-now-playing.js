/* Failure modes live in docs/TESTING.md ("Now Playing"). */

const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixtureCall(page, method, args = []) {
  return page.evaluate(`
    const fixture = ${FIXTURE};
    if (!fixture || typeof fixture[${JSON.stringify(method)}] !== "function") {
      throw new Error("Music E2E fixture does not expose ${method}()");
    }
    return await fixture[${JSON.stringify(method)}](...${JSON.stringify(args)});
  `);
}

async function waitFor(page, expression, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(`return Boolean(${expression});`)) return true;
    await sleep(50);
  }
  return false;
}

/** Real pointer click, so the browser moves focus like a user click would. */
async function clickSelector(page, selector) {
  const point = await page.evaluate(`
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  `);
  if (!point) return false;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
  }
  return true;
}

async function pressKey(page, key, code, windowsVirtualKeyCode) {
  for (const type of ["keyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode,
    });
  }
}

async function transitions(page) {
  const snapshot = await fixtureCall(page, "snapshot");
  return snapshot?.transitions ?? [];
}

/** Run Now Playing checks against the native WebView2 fixture. */
export async function runNowPlaying({ page, check }) {
  await fixtureCall(page, "reset");
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

  // Artwork click opens the overlay, and focus moves inside it.
  await clickSelector(page, ".player-artwork-button");
  const opened = await waitFor(
    page,
    `document.querySelector('.now-playing[role="dialog"][aria-modal="true"][aria-label="Now Playing"]')`,
  );
  // Focus moves in an effect after paint, so poll rather than read once.
  const focusInside = await waitFor(
    page,
    `document.querySelector('.now-playing') && document.querySelector('.now-playing').contains(document.activeElement)`,
    5_000,
  );
  check(
    "artwork click opens Now Playing with focus inside the dialog",
    opened && focusInside,
    { opened, focusInside },
  );

  // Up Next lists only the songs after the current one.
  const upNext = await page.evaluate(`
    return [...document.querySelectorAll('.now-playing-queue strong')].map((node) => node.textContent);
  `);
  check(
    "Up Next lists only upcoming songs",
    JSON.stringify(upNext) === JSON.stringify(["Track C", "Track E"]),
    { upNext },
  );

  // Seeking through the overlay slider reaches MusicKit.
  await fixtureCall(page, "emitPlaybackTime", [0]);
  await waitFor(
    page,
    `document.querySelector('.now-playing input[aria-label="Playback position"]:not(:disabled)')`,
    5_000,
  );
  await page.evaluate(`
    const input = document.querySelector('.now-playing input[aria-label="Playback position"]');
    input.value = "42";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  `);
  const seeked = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().transitions.some((item) => item.type === "seekToTime" && item.seconds === 42)`,
    5_000,
  );
  check("seeking in Now Playing reaches MusicKit", seeked);

  // Space still toggles playback while the overlay is open.
  await page.evaluate(`document.activeElement?.blur(); return true;`);
  const beforeSpace = (await transitions(page)).length;
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
    text: " ",
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
  });
  const paused = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().transitions.slice(${beforeSpace}).some((item) => item.type === "pause")`,
    5_000,
  );
  check("Space pauses playback while Now Playing is open", paused);

  // Choosing an Up Next row selects it in place and keeps earlier songs.
  const beforeRow = (await transitions(page)).length;
  await page.evaluate(`
    document.querySelectorAll('.now-playing-queue button')[1]?.click();
    return true;
  `);
  const selected = await waitFor(
    page,
    `document.querySelector(".player-bar .player-track-copy strong")?.textContent === "Track E"`,
    5_000,
  );
  const rowTransitions = (await transitions(page)).slice(beforeRow);
  check(
    "choosing an Up Next row selects it without rebuilding the queue",
    selected &&
      rowTransitions.some(
        (item) => item.type === "selectIndex" && item.index === 2,
      ) &&
      !rowTransitions.some((item) => item.type === "setQueue"),
    { rowTransitions },
  );

  // Return focus to the dialog so Esc reaches it.
  await page.evaluate(
    `document.querySelector('.now-playing button[aria-label="Close Now Playing"]')?.focus(); return true;`,
  );
  // Esc closes the overlay and returns focus to the artwork button.
  await pressKey(page, "Escape", "Escape", 27);
  const closed = await waitFor(
    page,
    `!document.querySelector('.now-playing')`,
    5_000,
  );
  const restored = await waitFor(
    page,
    `document.activeElement && document.activeElement.getAttribute('aria-label') === 'Open Now Playing'`,
    5_000,
  );
  check(
    "Esc closes Now Playing and focus returns to the artwork button",
    closed && restored,
    { closed, restored },
  );
}
