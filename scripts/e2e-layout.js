/* Failure modes live in docs/TESTING.md ("Layout" and "Playback
 * correctness"): shuffle relabelling the playing song, long pinned names,
 * and stray horizontal scrollbars. */

const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const TITLE = `document.querySelector(".player-bar .player-track-copy strong")?.textContent`;
const BIG_PLAYLIST = "playlist-big";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixtureCall(page, method, args = []) {
  return page.evaluate(`
    return await ${FIXTURE}[${JSON.stringify(method)}](...${JSON.stringify(args)});
  `);
}

async function waitFor(page, expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(`return Boolean(${expression});`)) return true;
    await sleep(50);
  }
  return false;
}

async function clickMenuItem(page, target, itemId) {
  await fixtureCall(page, "selectContext", [target]);
  const ready = await waitFor(
    page,
    `document.querySelector('.context-menu [data-menu-item="${itemId}"]:not(:disabled)')`,
  );
  if (!ready) return false;
  await page.evaluate(
    `document.querySelector('.context-menu [data-menu-item="${itemId}"]').click(); return true;`,
  );
  return true;
}

/** Elements that would show a horizontal scrollbar, with their boxes. */
const OVERFLOW_PROBE = `
  const offenders = [];
  for (const node of document.querySelectorAll("*")) {
    const style = getComputedStyle(node);
    if (!["auto", "scroll"].includes(style.overflowX)) continue;
    if (node.scrollWidth <= node.clientWidth + 1) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    offenders.push({
      tag: node.tagName.toLowerCase(),
      className: String(node.className).slice(0, 80),
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
    });
  }
  const root = document.documentElement;
  if (root.scrollWidth > root.clientWidth + 1) {
    offenders.push({ tag: "html", scrollWidth: root.scrollWidth, clientWidth: root.clientWidth });
  }
  return offenders;
`;

export async function runLayout({ page, check }) {
  try {
    // Shuffle mid-song keeps the playing song's title and artist.
    await fixtureCall(page, "reset");
    await page.evaluate(
      `location.hash = "#/playlist/playlist-1"; return true;`,
    );
    await waitFor(
      page,
      `document.querySelectorAll(".library-track-row").length >= 4`,
    );
    await page.evaluate(`
      document.querySelectorAll(".library-track-row")[2]?.click();
      return true;
    `);
    const playing = await waitFor(page, `${TITLE} === "Track C"`);
    await fixtureCall(page, "shuffleLikeMusicKit");
    // The fixture announces shuffle last; once the button shows it, the
    // player bar has rendered every queue event before it.
    await waitFor(
      page,
      `document.querySelector('[aria-label="Toggle shuffle"]')?.getAttribute("aria-pressed") === "true"`,
    );
    const titleAfter = await page.evaluate(`return ${TITLE};`);
    const snap = await fixtureCall(page, "snapshot");
    check(
      "turning shuffle on mid-song keeps the playing song's title",
      playing &&
        titleAfter === "Track C" &&
        snap.queue.index === 0 &&
        snap.queue.activeId === "song-c",
      { playing, titleAfter, index: snap.queue.index },
    );

    // A long pinned playlist name ends in an ellipsis on one line.
    await page.evaluate(
      `location.hash = "#/playlist/${BIG_PLAYLIST}"; return true;`,
    );
    await waitFor(
      page,
      `document.querySelector(".library-detail-hero h1")?.textContent?.startsWith("Big Playlist")`,
      15_000,
    );
    const pinned = await clickMenuItem(
      page,
      { id: BIG_PLAYLIST, kind: "playlist", source: "library" },
      "pin-playlist",
    );
    const pinShown = await waitFor(
      page,
      `[...document.querySelectorAll('.sidebar-group[aria-label="Pinned playlists"] .sidebar-link')].some((node) => node.textContent.startsWith("Big Playlist"))`,
    );
    const pinBox = await page.evaluate(`
      const link = [...document.querySelectorAll('.sidebar-group[aria-label="Pinned playlists"] .sidebar-link')]
        .find((node) => node.textContent.startsWith("Big Playlist"));
      const label = link?.querySelector("span:last-child");
      return link && label ? {
        height: Math.round(link.getBoundingClientRect().height),
        truncated: label.scrollWidth > label.clientWidth,
        textOverflow: getComputedStyle(label).textOverflow,
        title: link.getAttribute("title"),
      } : null;
    `);
    check(
      "a long pinned playlist name stays on one line with an ellipsis",
      pinned &&
        pinShown &&
        pinBox?.height <= 40 &&
        pinBox.truncated &&
        pinBox.textOverflow === "ellipsis" &&
        pinBox.title?.startsWith("Big Playlist With A Very Long Name"),
      { pinned, pinShown, pinBox },
    );

    // The sidebar and the page end above the player bar, not under it.
    const bounds = await page.evaluate(`
      const bar = document.querySelector(".player-bar")?.getBoundingClientRect();
      const account = document.querySelector(".account-link")?.getBoundingClientRect();
      const content = document.querySelector(".content-scroll")?.getBoundingClientRect();
      return bar && account && content ? {
        barTop: Math.round(bar.top),
        accountBottom: Math.round(account.bottom),
        contentBottom: Math.round(content.bottom),
      } : null;
    `);
    check(
      "the sidebar account row and the page end above the player bar",
      Boolean(bounds) &&
        bounds.accountBottom <= bounds.barTop + 1 &&
        bounds.contentBottom <= bounds.barTop + 1,
      bounds,
    );

    // With a song playing, a long pin, and long rows, nothing scrolls sideways.
    await page.evaluate(`
      document.querySelectorAll(".library-track-row")[0]?.click();
      return true;
    `);
    await waitFor(
      page,
      `${FIXTURE}.snapshot().transitions.some((item) => item.type === "play")`,
      15_000,
    );
    const offenders = await page.evaluate(OVERFLOW_PROBE);
    check("no element shows a horizontal scrollbar", offenders.length === 0, {
      offenders,
    });
  } finally {
    // Pins persist on disk; later scenarios expect none of this one.
    await clickMenuItem(
      page,
      { id: BIG_PLAYLIST, kind: "playlist", source: "library" },
      "unpin-playlist",
    ).catch(() => false);
    await fixtureCall(page, "reset");
  }
}
