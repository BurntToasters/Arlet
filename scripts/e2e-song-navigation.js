/* Failure modes live in docs/TESTING.md; the injected fixture makes these
 * navigation checks repeatable against the production WebView components. */

const FIXTURE = "window.__ARLET_E2E_MUSIC__";

function evaluateFixtureCall(method, args = []) {
  return `
    const fixture = ${FIXTURE};
    if (!fixture || typeof fixture[${JSON.stringify(method)}] !== "function") {
      throw new Error("Music E2E fixture does not expose ${method}()");
    }
    return await fixture[${JSON.stringify(method)}](...${JSON.stringify(args)});
  `;
}

async function waitFor(page, expression, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(`return Boolean(${expression});`)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function pressEnter(page) {
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
}

async function openPlayerContextMenu(page) {
  return page.evaluate(`
    const target = document.querySelector('.player-track');
    if (!target) return false;
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 120,
    }));
    return true;
  `);
}

async function openSongRowContextMenu(page) {
  return page.evaluate(`
    const target = document.querySelector('.song-row-shell[data-context-id="nav-multi"]');
    if (!target) return false;
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 120,
    }));
    return true;
  `);
}

function playbackSnapshot(snapshot) {
  return {
    queue: snapshot?.queue,
    modes: snapshot?.modes,
    transitions: snapshot?.transitions,
    currentTrack: snapshot?.currentTrack,
  };
}

/** Run song destination checks against the native WebView2 fixture. */
export async function runSongNavigation({ page, check }) {
  const fixtureCall = (method, ...args) =>
    page.evaluate(evaluateFixtureCall(method, args));
  const routeFor = async (kind, id, source) =>
    page.evaluate(
      `return location.hash === ${JSON.stringify(`#/${kind}/${id}${source === "catalog" ? "?source=catalog" : ""}`)};`,
    );

  await fixtureCall("reset");
  await fixtureCall("setCurrentTrack", "nav-multi");
  const playerHasAlbum = await waitFor(
    page,
    `document.querySelector('.player-track [data-player-navigation="album"][data-player-navigation-id="nav-album"]')`,
  );
  const artists = await page.evaluate(`
    return [...document.querySelectorAll('.player-track [data-player-navigation="artist"]')]
      .map((node) => ({ id: node.dataset.playerNavigationId, label: node.textContent.trim() }));
  `);
  check(
    "player exposes the related album and each related artist as destinations",
    playerHasAlbum &&
      artists.some((artist) => artist.id === "nav-artist-one") &&
      artists.some((artist) => artist.id === "nav-artist-two") &&
      artists.length === 2,
    { playerHasAlbum, artists },
  );

  await fixtureCall("stripCurrentRelationships");
  const refsRetained = await waitFor(
    page,
    `document.querySelector('.player-track [data-player-navigation="album"][data-player-navigation-id="nav-album"]') && document.querySelector('.player-track [data-player-navigation="artist"][data-player-navigation-id="nav-artist-one"]') && document.querySelector('.player-track [data-player-navigation="artist"][data-player-navigation-id="nav-artist-two"]')`,
  );
  check(
    "MusicKit queue refresh retains navigation refs when its current item omits relationships",
    refsRetained,
  );

  const beforeNavigation = playbackSnapshot(await fixtureCall("snapshot"));

  await page.evaluate(`
    document.querySelector('.player-track [data-player-navigation="album"]')?.click();
    return true;
  `);
  await waitFor(page, `location.hash === "#/album/nav-album?source=catalog"`);
  check(
    "player album destination opens the related album route",
    await routeFor("album", "nav-album", "catalog"),
  );

  await page.evaluate(`
    document.querySelector('.player-track [data-player-navigation="artist"][data-player-navigation-id="nav-artist-two"]')?.click();
    return true;
  `);
  await waitFor(
    page,
    `location.hash === "#/artist/nav-artist-two?source=catalog"`,
  );
  check(
    "player keeps the second artist relationship independently navigable",
    await routeFor("artist", "nav-artist-two", "catalog"),
  );
  const afterNavigation = playbackSnapshot(await fixtureCall("snapshot"));
  check(
    "album and artist navigation leaves playback queue and modes unchanged",
    JSON.stringify(afterNavigation) === JSON.stringify(beforeNavigation),
    { beforeNavigation, afterNavigation },
  );

  await openPlayerContextMenu(page);
  const contextDestinations = await waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item="go-to-album"]') && document.querySelector('.context-menu [data-menu-item="go-to-artist-nav-artist-one"]') && document.querySelector('.context-menu [data-menu-item="go-to-artist-nav-artist-two"]')`,
  );
  if (contextDestinations) {
    await page.evaluate(`
      document.querySelector('.context-menu [data-menu-item="go-to-artist-nav-artist-one"]')?.focus();
      return true;
    `);
    await pressEnter(page);
    await waitFor(page, `location.hash === "#/artist/nav-artist-one"`);
  }
  check(
    "song context menu exposes each artist and keyboard activation navigates",
    contextDestinations && (await routeFor("artist", "nav-artist-one")),
  );

  await openPlayerContextMenu(page);
  const contextAlbum = await waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item="go-to-album"]')`,
  );
  if (contextAlbum) {
    await page.evaluate(`
      document.querySelector('.context-menu [data-menu-item="go-to-album"]')?.focus();
      return true;
    `);
    await pressEnter(page);
    await waitFor(page, `location.hash === "#/album/nav-album?source=catalog"`);
  }
  check(
    "song context menu album action opens the related album route by keyboard",
    contextAlbum && (await routeFor("album", "nav-album", "catalog")),
  );

  await page.evaluate(`location.hash = "#/library/songs"; return true;`);
  const songRowReady = await waitFor(
    page,
    `document.querySelector('.song-row-shell[data-context-id="nav-multi"]')`,
    10_000,
  );
  await openSongRowContextMenu(page);
  const rowMenu = await waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item="go-to-album"]') && document.querySelector('.context-menu [data-menu-item="go-to-artist-nav-artist-two"]')`,
  );
  if (rowMenu) {
    await page.evaluate(`
      document.querySelector('.context-menu [data-menu-item="go-to-artist-nav-artist-two"]')?.focus();
      return true;
    `);
    await pressEnter(page);
    await waitFor(
      page,
      `location.hash === "#/artist/nav-artist-two?source=catalog"`,
    );
  }
  check(
    "library song rows preserve relationship IDs and source in their context menu",
    songRowReady &&
      rowMenu &&
      (await routeFor("artist", "nav-artist-two", "catalog")),
    { songRowReady, rowMenu },
  );

  await fixtureCall("setCurrentTrack", "nav-missing");
  const missingTrackRendered = await waitFor(
    page,
    `document.querySelector('.player-track-copy strong')?.textContent.trim() && document.querySelector('.player-track-copy strong')?.textContent.trim() !== 'Nothing playing'`,
  );
  const missingTrackDestinations = await page.evaluate(`
    return document.querySelectorAll('.player-track [data-player-navigation]').length;
  `);
  check(
    "missing song relationships leave the player usable without broken destinations",
    missingTrackRendered && missingTrackDestinations === 0,
    { missingTrackRendered, missingTrackDestinations },
  );

  await fixtureCall("configure", {
    delayPaths: ["/v1/me/library/songs/nav-delayed"],
  });
  await fixtureCall("setCurrentTrack", "nav-delayed");
  await waitFor(
    page,
    `document.querySelector('.player-track [data-player-navigation="album"][data-player-navigation-id="nav-delayed-album"]')`,
    10_000,
  );
  await openPlayerContextMenu(page);
  await waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item="go-to-album"]')`,
  );
  const delayedSnapshot = await fixtureCall("snapshot");
  const delayedRequests = (delayedSnapshot?.requests ?? []).filter((request) =>
    String(request?.path ?? request?.url ?? request).includes(
      "/v1/me/library/songs/nav-delayed",
    ),
  );
  check(
    "player and context menu share the cached song relationship lookup",
    delayedRequests.length === 1,
    { delayedRequestCount: delayedRequests.length, requests: delayedRequests },
  );

  await fixtureCall("configure", {
    delayPaths: ["/v1/me/library/songs/nav-race"],
    delayMs: 1000,
  });
  await fixtureCall("setCurrentTrack", "nav-race");
  const raceLookupStarted = await waitFor(
    page,
    `window.__ARLET_E2E_MUSIC__.snapshot().requests.some((request) => String(request?.path ?? request?.url ?? request).includes('/v1/me/library/songs/nav-race'))`,
    5000,
  );
  await openPlayerContextMenu(page);
  await waitFor(page, `document.querySelector('.context-menu')`);
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await fixtureCall("setCurrentTrack", "nav-multi");
  await openPlayerContextMenu(page);
  await waitFor(
    page,
    `document.querySelector('.player-track[data-context-id="nav-multi"]') && document.querySelector('.context-menu [data-menu-item="go-to-album"]')`,
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const staleNavigation = await page.evaluate(`
    const playerHasStaleAlbum = [...document.querySelectorAll('.player-track [data-player-navigation]')]
      .some((node) => node.dataset.playerNavigationId === 'nav-race-album');
    const menuHasStaleAlbum = [...document.querySelectorAll('.context-menu [data-menu-item]')]
      .some((node) => node.dataset.menuTargetId === 'nav-race-album');
    return { playerHasStaleAlbum, menuHasStaleAlbum };
  `);
  check(
    "slow previous-song lookup cannot change player links or a replaced menu",
    raceLookupStarted &&
      !staleNavigation.playerHasStaleAlbum &&
      !staleNavigation.menuHasStaleAlbum,
    { raceLookupStarted, ...staleNavigation },
  );

  await fixtureCall("configure", {
    rejectPaths: ["/v1/me/library/songs/nav-error"],
  });
  await fixtureCall("setCurrentTrack", "nav-error");
  const errorFeedback = await waitFor(
    page,
    `document.querySelector('.action-toasts .action-toast-message')`,
    10_000,
  );
  const toastText = await page.evaluate(
    `return document.querySelector('.action-toasts .action-toast-message')?.textContent ?? '';`,
  );
  check(
    "relationship lookup failures use existing action feedback",
    errorFeedback && toastText.length > 0,
    { errorFeedback, toastText },
  );
}
