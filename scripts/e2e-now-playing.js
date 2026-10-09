/* Failure modes live in docs/TESTING.md ("Now Playing and lyrics"). Hostile
 * TTML is served by the music fixture; the checks prove it stays inert. */

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

async function lyricsRequests(page) {
  const snapshot = await fixtureCall(page, "snapshot");
  return (snapshot?.requests ?? []).filter((request) =>
    String(request.path).includes("/lyrics"),
  );
}

/** Run Now Playing and lyrics checks against the native WebView2 fixture. */
export async function runNowPlaying({ page, check }) {
  await fixtureCall(page, "reset");
  await fixtureCall(page, "setCurrentTrack", ["song-a"]);
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

  // Hostile TTML renders as inert text: no script or handler runs.
  const lyricsText = await waitFor(
    page,
    `document.querySelector('.lyrics-text') && document.querySelector('.lyrics-text').textContent.includes('Opening line')`,
    10_000,
  );
  const inert = await page.evaluate(`
    const text = document.querySelector('.lyrics-text')?.textContent ?? '';
    return {
      sentinelUnset: typeof window.__ARLET_TTML_SENTINEL === 'undefined',
      noMarkupElements: document.querySelectorAll('.lyrics-text img, .lyrics-text b, .lyrics-text script').length === 0,
      textRendered: text.includes('Opening line') && text.includes('Unsynced hostile line') && text.includes('Chorus line at forty'),
      cdataAsText: text.includes('<b>Markup stays text</b>'),
    };
  `);
  check(
    "hostile TTML runs no script and renders as text",
    lyricsText &&
      inert.sentinelUnset &&
      inert.noMarkupElements &&
      inert.textRendered &&
      inert.cdataAsText,
    inert,
  );

  // Seek to 42 s through the real progress slider. The line starting at 40 s
  // is the active one; it must be the only aria-current line.
  await fixtureCall(page, "setPlaybackTime", [0]);
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
  const highlighted = await waitFor(
    page,
    `document.querySelector('.lyrics-text [aria-current="true"]')?.textContent === 'Chorus line at forty'`,
    5_000,
  );
  const highlight = await page.evaluate(`
    const active = document.querySelectorAll('.lyrics-text [aria-current="true"]');
    const node = active[0];
    const container = document.querySelector('.lyrics-text');
    const rect = node?.getBoundingClientRect();
    const box = container?.getBoundingClientRect();
    return {
      count: active.length,
      text: node?.textContent ?? null,
      visible: Boolean(rect && box && rect.top >= box.top && rect.bottom <= box.bottom),
    };
  `);
  check(
    "seeking to 42 s highlights the line starting at 40 s, scrolled into view",
    highlighted &&
      highlight.count === 1 &&
      highlight.text === "Chorus line at forty" &&
      highlight.visible,
    { highlighted, highlight },
  );

  // Denied lyrics: "song-c" answers 403 and shows the fallback.
  await fixtureCall(page, "setCurrentTrack", ["song-c"]);
  const fallback = await waitFor(
    page,
    `document.querySelector('.lyrics-status') && document.querySelector('.lyrics-status').textContent.includes("available for this song")`,
    10_000,
  );
  const afterForbidden = await lyricsRequests(page);
  const forbiddenRequests = afterForbidden.filter((request) =>
    request.path.includes("/songs/song-c/lyrics"),
  );

  // Two more track changes, one with lyrics and one denied. The 403 must stop
  // all further lyrics requests for the rest of the session.
  await fixtureCall(page, "setCurrentTrack", ["song-e"]);
  await sleep(300);
  await fixtureCall(page, "setCurrentTrack", ["song-c"]);
  await sleep(300);
  const afterSwitches = await lyricsRequests(page);
  check(
    "403 shows the fallback and no lyrics request follows it",
    fallback &&
      forbiddenRequests.length === 1 &&
      afterSwitches.length === afterForbidden.length,
    {
      fallback,
      forbiddenRequests: forbiddenRequests.length,
      requestsAtForbidden: afterForbidden.length,
      requestsAfterSwitches: afterSwitches.length,
    },
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
