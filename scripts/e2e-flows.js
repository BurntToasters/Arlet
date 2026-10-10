/* Failure modes live in docs/TESTING.md ("Search, playlist dialogs, and
 * support report"): search results that cannot be played, playlist dialogs
 * that drop the song or the name, and a support report that leaks tokens. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = "window.__ARLET_E2E_MUSIC__";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
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

/** Types into a Preact-controlled field the way a user would. */
function typeInto(page, selector, value) {
  return page.evaluate(`
    const field = document.querySelector(${JSON.stringify(selector)});
    if (!field) return false;
    field.focus();
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(field),
      "value",
    ).set;
    setter.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
}

function requestsSince(page, since) {
  return page.evaluate(
    `return ${FIXTURE}.snapshot().requests.slice(${since});`,
  );
}

async function searchAndPlay({ page, check }) {
  await fixtureCall(page, "reset");
  // Same route the sidebar search box opens; the view searches its query.
  await page.evaluate(
    `location.hash = "#/search?q=fixture%20top"; return true;`,
  );
  const typed = await waitFor(
    page,
    `document.querySelector('.search-form input[type="search"]')?.value === "fixture top"`,
  );
  const listed = await waitFor(
    page,
    `document.querySelectorAll(".search-results-list .search-row").length >= 3`,
  );
  const titles = await page.evaluate(
    `return [...document.querySelectorAll(".search-results-list .search-row")].map((row) => row.textContent);`,
  );
  await page.evaluate(
    `document.querySelectorAll(".search-results-list .search-row")[1]?.click(); return true;`,
  );
  const queued = await waitFor(
    page,
    `${FIXTURE}.snapshot().transitions.some((item) => item.type === "setQueue" && item.ids?.[0] === "top-2")`,
  );
  check(
    "a search result plays that song first",
    typed &&
      listed &&
      titles.some((title) => title.includes("Top Song 2")) &&
      queued,
    {
      typed,
      listed,
      titles,
      feedback: await page.evaluate(
        `return document.querySelector(".search-feedback")?.textContent ?? null;`,
      ),
      searchRequests: (await fixtureCall(page, "snapshot")).requests
        .filter((request) => request.path.includes("search"))
        .map((request) => ({ path: request.path, error: request.error })),
    },
  );
}

async function addToPlaylist({ page, check }) {
  await fixtureCall(page, "reset");
  await page.evaluate(`location.hash = "#/home"; return true;`);
  const opened = await clickMenuItem(page, "song-a", "add-to-playlist");
  const listed = await waitFor(
    page,
    `[...document.querySelectorAll(".playlist-dialog-option")].some((node) => node.textContent.includes("Fixture Playlist"))`,
  );
  const since = (await fixtureCall(page, "snapshot")).requests.length;
  await page.evaluate(`
    [...document.querySelectorAll(".playlist-dialog-option")]
      .find((node) => node.textContent.includes("Fixture Playlist"))
      ?.click();
    return true;`);
  const closed = await waitFor(
    page,
    `!document.querySelector(".playlist-dialog-backdrop")`,
  );
  const added = (await requestsSince(page, since)).find(
    (request) =>
      request.method === "POST" &&
      request.path.includes("/v1/me/library/playlists/playlist-1/tracks"),
  );
  check(
    "Add to playlist posts the song to the chosen playlist and closes",
    opened &&
      listed &&
      closed &&
      JSON.stringify(added?.body ?? "").includes("song-a"),
    { opened, listed, closed, added },
  );
}

async function createPlaylist({ page, check }) {
  await fixtureCall(page, "reset");
  const opened = await clickMenuItem(page, "song-b", "add-to-playlist");
  await waitFor(page, `document.querySelector(".playlist-dialog-footer")`);
  await page.evaluate(`
    [...document.querySelectorAll(".playlist-dialog-footer button")]
      .find((node) => node.textContent.includes("New playlist"))
      ?.click();
    return true;`);
  const formShown = await waitFor(
    page,
    `document.querySelector(".playlist-dialog-form input[type='text']")`,
  );
  const typed = await typeInto(
    page,
    ".playlist-dialog-form input[type='text']",
    "E2E Mix",
  );
  const since = (await fixtureCall(page, "snapshot")).requests.length;
  await page.evaluate(
    `document.querySelector(".playlist-dialog-form").requestSubmit(); return true;`,
  );
  const closed = await waitFor(
    page,
    `!document.querySelector(".playlist-dialog-backdrop")`,
  );
  const created = (await requestsSince(page, since)).find(
    (request) =>
      request.method === "POST" &&
      request.path.split("?", 1)[0] === "/v1/me/library/playlists",
  );
  const body = JSON.stringify(created?.body ?? "");
  check(
    "New playlist sends the typed name with the selected song",
    opened &&
      formShown &&
      typed &&
      closed &&
      body.includes("E2E Mix") &&
      body.includes("song-b"),
    { opened, formShown, typed, closed, created },
  );
}

async function supportReport({ page, check }) {
  await page.evaluate(`location.hash = "#/settings"; return true;`);
  const shown = await waitFor(
    page,
    `[...document.querySelectorAll("button")].some((node) => node.textContent.includes("Copy diagnostics report"))`,
  );
  await page.evaluate(`
    [...document.querySelectorAll("button")]
      .find((node) => node.textContent.includes("Copy diagnostics report"))
      ?.click();
    return true;`);
  const copied = await waitFor(
    page,
    `[...document.querySelectorAll("button")].some((node) => node.textContent.trim() === "Copied")`,
  );
  // Reads back what the app put on the system clipboard.
  const report = await page.evaluate(`
    try {
      return await window.__TAURI_INTERNALS__.invoke("plugin:clipboard-manager|read_text");
    } catch (error) {
      return "";
    }`);
  const text = String(report ?? "");
  check(
    "the support report names the version and carries no tokens",
    shown &&
      copied &&
      text.startsWith("# Arlet diagnostics report") &&
      text.includes(`Arlet ${VERSION}`) &&
      !/eyJ[\w-]{8,}\.[\w-]+/u.test(text),
    {
      shown,
      copied,
      length: text.length,
      head: text.slice(0, 200),
      toasts: await page.evaluate(
        `return [...document.querySelectorAll(".action-toast-message")].map((node) => node.textContent);`,
      ),
    },
  );
}

/** Search, playlist dialogs, and the support report, through the real UI. */
export async function runFlows({ page, check }) {
  for (const scenario of [
    searchAndPlay,
    addToPlaylist,
    createPlaylist,
    supportReport,
  ]) {
    try {
      await page.evaluate(
        'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;',
      );
      await scenario({ page, check });
    } catch (error) {
      check(
        `${scenario.name} completes`,
        false,
        String(error?.message ?? error),
      );
    }
  }
  await page.evaluate(`location.hash = "#/home"; return true;`);
}
