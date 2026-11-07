#!/usr/bin/env node

/* UI audit fixes against the MusicKit fixture (docs/TESTING.md "UI audit
 * fixes"): Up Next spacing, the narrow player's queue button, shelf card
 * widths, heading focus after keyboard navigation, the Playing Next active
 * row, the Search source tab color, the licenses and shared modal dialogs,
 * Home refresh announcements and its Try again notice, the collapsed record
 * label description, a failed Windows media control written to the log, the
 * minimum text size in the main views, and the content column width. Each
 * check's measured values go to ui-audit-trace.json in the artifact folder.
 * The run ends with every fixture control reset and the app on Home. */

import { writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fixtureCall, sleep, waitFor } from "./e2e-helpers.js";

const CHECKS = {
  upNext:
    "Up Next rows in Now Playing stack without gaps when only a few songs are queued",
  narrowPlayer: "at 360 px the queue button does not cover the Favorite button",
  shelf: "a shelf with two cards keeps the same card width as a full shelf",
  headingFocus:
    "the page heading shows no focus outline after keyboard navigation",
  activeRow: "the playing row in Playing Next has one even highlight",
  searchTab: "the selected Search source tab uses the main text color",
  licenses:
    "the licenses dialog keeps Tab inside, returns focus to its opener, and shows an error when licenses fail to load",
  modals: "modal dialogs keep Tab inside and return focus to their opener",
  homeStatus:
    "Home announces refreshes in one status line instead of the whole feed",
  homeRetry: "Home's refresh notice offers a Try again button",
  labelMore: "a long record label description is collapsed behind More",
  mediaLog: "a failed Windows media control command is written to the log",
  textSize: "no text in the main views is smaller than 11 px",
  contentWidth: "the content column grows to 1180 px on wide windows",
  ready: "ui-audit leaves the app ready for the next scenario",
};

const UP_NEXT_IDS = ["song-a", "song-c", "song-e", "song-f"];
const SEARCH_HASH = "#/search?q=artwork";
const SHELF_HASH = "#/artist/artist-views?source=catalog";
const LABEL_HASH = "#/label/rl-fixture-1";
const LABEL_DESCRIPTION_START = "releases, reissues, and archival collections";
const LICENSE_URLS = ["*licenses.json*", "*licenses-cargo.json*"];
const HOME_HISTORY_PATH = "/v1/me/history/heavy-rotation";
const NOTICE_TEXT = "Some Home sections could not be refreshed.";
const MEDIA_TEXT = "Media control next failed: Fixture skip rejected";
const CONTENT_MAX = 1180;
const NARROW_WIDTH = 360;
const WIDE_WIDTH = 1600;
const MID_WIDTH = 1000;
const REFRESH_HOME = `document.querySelector('button[aria-label="Refresh Home"]')`;
const HOME_READY = `document.querySelector('.home-feed') && ${REFRESH_HOME} && !${REFRESH_HOME}.disabled`;

const q = (value) => JSON.stringify(value);
const snapshot = (page) => fixtureCall(page, "snapshot");

function readPage(page, body) {
  return page.evaluate(`return (() => { ${body} })();`);
}

function go(page, hash) {
  return page.evaluate(`location.hash = ${q(hash)}; return true;`);
}

/** Escape to every open overlay, then wait until none is left. */
async function closeOverlays(page) {
  await page.evaluate(`
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;`);
  await waitFor(
    page,
    `!document.querySelector(".now-playing") && !document.querySelector(".playlist-dialog-backdrop") && !document.querySelector(".shortcut-backdrop") && !document.querySelector(".song-info-dialog") && !document.querySelector(".context-menu")`,
    3000,
  );
}

async function openHome(page) {
  await go(page, "#/home");
  return waitFor(page, HOME_READY, 15_000);
}

/** Real key through CDP. Modifiers: 1 Alt, 2 Ctrl, 8 Shift. */
async function pressKey(
  page,
  key,
  { code, keyCode, modifiers = 0, text } = {},
) {
  const common = {
    key,
    code: code ?? key,
    windowsVirtualKeyCode: keyCode,
    modifiers,
  };
  await page.send("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    text,
    unmodifiedText: text,
    ...common,
  });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

const pressTab = (page, shift = false) =>
  pressKey(page, "Tab", { code: "Tab", keyCode: 9, modifiers: shift ? 8 : 0 });
const pressEscape = (page) =>
  pressKey(page, "Escape", { code: "Escape", keyCode: 27 });

async function saveScreenshot(page, artifactDir, file) {
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    path.join(artifactDir, file),
    Buffer.from(shot.data, "base64"),
  );
}

/** Parses the alpha channel of a computed color; 1 when none is given. */
function alphaOf(color) {
  const rgb = /rgba?\(([^)]+)\)/u.exec(color);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/u).filter(Boolean);
    return parts.length === 4 ? Number(parts[3]) : 1;
  }
  const modern = /\/\s*([\d.]+)\s*\)/u.exec(color);
  if (modern) return Number(modern[1]);
  return color === "transparent" ? 0 : 1;
}

function logCount(logDir, text) {
  try {
    return (
      fs.readFileSync(path.join(logDir, "arlet.log"), "utf8").split(text)
        .length - 1
    );
  } catch {
    return 0;
  }
}

/** Runs one check body; a throw becomes one failed check with its message. */
async function runCheck(check, trace, name, body) {
  try {
    const result = await body();
    trace[name] = result.detail;
    check(name, result.passed, result.detail);
  } catch (error) {
    const message = String(error?.message ?? error);
    trace[name] = { error: message };
    check(name, false, message);
  }
}

async function upNextGaps(page, check, trace, artifactDir) {
  await runCheck(check, trace, CHECKS.upNext, async () => {
    await fixtureCall(page, "reset");
    await page.evaluate(`
      const music = window.MusicKit.getInstance();
      await music.setQueue({ songs: ${q(UP_NEXT_IDS)} });
      await music.play();
      return true;`);
    await waitFor(
      page,
      `document.querySelector('.player-artwork-button:not(:disabled)')`,
      10_000,
    );
    await page.evaluate(
      `document.querySelector('.player-artwork-button').click(); return true;`,
    );
    const opened = await waitFor(
      page,
      `document.querySelector('.now-playing-queue > li:not([aria-hidden])')`,
      8_000,
    );
    const measured = await readPage(
      page,
      `const list = document.querySelector(".now-playing-queue");
       const rows = [...list.querySelectorAll(":scope > li:not([aria-hidden])")].map((row) => row.getBoundingClientRect());
       const gaps = rows.slice(1).map((row, index) => Math.round((row.top - rows[index].bottom) * 10) / 10);
       return {
         rowCount: rows.length,
         gaps,
         topOffset: rows.length ? Math.round((rows[0].top - list.getBoundingClientRect().top) * 10) / 10 : null,
         listHeight: Math.round(list.getBoundingClientRect().height),
       };`,
    );
    await saveScreenshot(
      page,
      artifactDir,
      "screenshot-ui-audit-now-playing.png",
    );
    await closeOverlays(page);
    const passed =
      opened &&
      measured.rowCount >= 3 &&
      measured.gaps.every((gap) => gap <= 4) &&
      Math.abs(measured.topOffset) <= 4;
    return { passed, detail: { opened, ...measured } };
  });
}

async function narrowPlayer(page, check, trace, artifactDir) {
  await runCheck(check, trace, CHECKS.narrowPlayer, async () => {
    await fixtureCall(page, "reset");
    await page.evaluate(`
      const music = window.MusicKit.getInstance();
      await music.setQueue({ songs: ${q(UP_NEXT_IDS)} });
      await music.play();
      return true;`);
    await waitFor(
      page,
      `document.querySelector('.player-bar .player-track-copy strong')`,
      10_000,
    );
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: NARROW_WIDTH,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false,
    });
    try {
      const sized = await waitFor(
        page,
        `window.innerWidth === ${NARROW_WIDTH}`,
        3000,
      );
      await sleep(250);
      const favorite = await waitFor(
        page,
        `document.querySelector('.player-track button[aria-label="Favorite"], .player-track button[aria-label="Undo Favorite"]')`,
        5000,
      );
      const boxes = await readPage(
        page,
        `const rect = (node) => {
           const box = node.getBoundingClientRect();
           return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
         };
         const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).display !== "none";
         const favorite = document.querySelector('.player-track button[aria-label="Favorite"], .player-track button[aria-label="Undo Favorite"]');
         const title = document.querySelector(".player-bar .player-track-copy strong");
         const actions = [...document.querySelectorAll(".player-actions button")].filter(visible);
         const transport = document.querySelector(".transport-controls");
         return {
           innerWidth: window.innerWidth,
           favorite: favorite && visible(favorite) ? rect(favorite) : null,
           title: title ? rect(title) : null,
           actions: actions.map((node) => ({ label: node.getAttribute("aria-label"), box: rect(node) })),
           transport: transport ? rect(transport) : null,
         };`,
      );
      await saveScreenshot(
        page,
        artifactDir,
        "screenshot-ui-audit-narrow-player.png",
      );
      const overlaps = (a, b) =>
        Boolean(a && b) &&
        a.left < b.right &&
        b.left < a.right &&
        a.top < b.bottom &&
        b.top < a.bottom;
      const conflicts = [];
      if (boxes.favorite) {
        for (const action of boxes.actions) {
          if (overlaps(boxes.favorite, action.box))
            conflicts.push(`favorite vs ${action.label}`);
        }
        if (overlaps(boxes.favorite, boxes.transport))
          conflicts.push("favorite vs transport");
        if (overlaps(boxes.favorite, boxes.title))
          conflicts.push("favorite vs title");
      }
      for (const action of boxes.actions) {
        if (overlaps(boxes.title, action.box))
          conflicts.push(`title vs ${action.label}`);
      }
      if (overlaps(boxes.title, boxes.transport))
        conflicts.push("title vs transport");
      return {
        passed:
          sized &&
          favorite &&
          boxes.favorite !== null &&
          conflicts.length === 0,
        detail: { sized, favoriteFound: favorite, conflicts, ...boxes },
      };
    } finally {
      await page.send("Emulation.clearDeviceMetricsOverride", {});
      await waitFor(page, `window.innerWidth !== ${NARROW_WIDTH}`, 3000);
    }
  });
}

async function shelfWidths(page, check, trace, artifactDir) {
  await runCheck(check, trace, CHECKS.shelf, async () => {
    await go(page, SHELF_HASH);
    await waitFor(
      page,
      `document.querySelectorAll('.library-card-grid').length >= 2`,
      15_000,
    );
    await sleep(300);
    const grids = await readPage(
      page,
      `return [...document.querySelectorAll(".content-scroll .library-card-grid")].map((grid) => {
         const cards = [...grid.children].filter((card) => card.getClientRects().length > 0);
         const boxes = cards.map((card) => card.getBoundingClientRect());
         return {
           label: grid.getAttribute("aria-label"),
           count: cards.length,
           widths: boxes.map((box) => Math.round(box.width * 10) / 10),
           gaps: boxes.slice(1).map((box, index) => Math.round((box.left - boxes[index].right) * 10) / 10),
           columnGap: parseFloat(getComputedStyle(grid).columnGap),
         };
       });`,
    );
    await saveScreenshot(page, artifactDir, "screenshot-ui-audit-shelf.png");
    const twoCard = grids.find((grid) => grid.count === 2);
    const full = grids.find((grid) => grid.count >= 5);
    const widthOf = (grid) => grid.widths[0];
    const passed =
      Boolean(twoCard && full) &&
      Math.abs(widthOf(twoCard) - widthOf(full)) <= 2 &&
      twoCard.widths.every((width) => Math.abs(width - widthOf(full)) <= 2) &&
      Math.abs(twoCard.gaps[0] - twoCard.columnGap) <= 2;
    return {
      passed,
      detail: {
        route: SHELF_HASH,
        twoCard,
        full,
        grids: grids.map(({ label, count, widths }) => ({
          label,
          count,
          widths,
        })),
      },
    };
  });
}

async function headingFocus(page, check, trace) {
  await runCheck(check, trace, CHECKS.headingFocus, async () => {
    await openHome(page);
    await go(page, "#/library/albums");
    await waitFor(
      page,
      `document.querySelector('.content-scroll h1[tabindex="-1"]')`,
      10_000,
    );
    await sleep(200);
    await pressKey(page, "ArrowLeft", {
      code: "ArrowLeft",
      keyCode: 37,
      modifiers: 1,
    });
    const focused = await waitFor(
      page,
      `document.activeElement?.tagName === "H1" && document.activeElement.getAttribute("tabindex") === "-1"`,
      5000,
    );
    const style = await readPage(
      page,
      `const node = document.activeElement;
       const cs = getComputedStyle(node);
       return {
         tag: node?.tagName ?? null,
         text: node?.textContent?.trim() ?? null,
         outlineStyle: cs.outlineStyle,
         outlineWidth: cs.outlineWidth,
         focusVisible: node?.matches(":focus-visible") ?? null,
       };`,
    );
    const noOutline =
      style.outlineStyle === "none" || style.outlineWidth === "0px";
    return { passed: focused && noOutline, detail: { focused, ...style } };
  });
}

async function activeRow(page, check, trace, artifactDir) {
  await runCheck(check, trace, CHECKS.activeRow, async () => {
    await fixtureCall(page, "reset");
    await page.evaluate(`
      const music = window.MusicKit.getInstance();
      await music.setQueue({ songs: ["song-a", "song-c", "song-e"] });
      await music.play();
      return true;`);
    await waitFor(
      page,
      `document.querySelector('.player-bar .player-track-copy strong')`,
      10_000,
    );
    const toggled = await page.evaluate(`
      if (!document.querySelector("aside.queue-drawer")) {
        document.querySelector('button[aria-label="Toggle Playing Next"]')?.click();
      }
      return true;`);
    const shown = await waitFor(
      page,
      `document.querySelector('.queue-row-shell.is-active .queue-row')`,
      8000,
    );
    const measured = await readPage(
      page,
      `const shell = document.querySelector(".queue-row-shell.is-active");
       const row = shell?.querySelector(".queue-row");
       return {
         shellBackground: shell ? getComputedStyle(shell).backgroundColor : null,
         rowBackground: row ? getComputedStyle(row).backgroundColor : null,
         rowText: row?.getAttribute("aria-label") ?? null,
       };`,
    );
    await saveScreenshot(page, artifactDir, "screenshot-ui-audit-queue.png");
    await page.evaluate(
      `document.querySelector('aside.queue-drawer button[aria-label="Close Playing Next"]')?.click(); return true;`,
    );
    await waitFor(page, `!document.querySelector("aside.queue-drawer")`, 3000);
    const passed =
      toggled &&
      shown &&
      alphaOf(measured.rowBackground ?? "") === 0 &&
      alphaOf(measured.shellBackground ?? "") > 0;
    return {
      passed,
      detail: {
        shown,
        ...measured,
        rowAlpha: alphaOf(measured.rowBackground ?? ""),
        shellAlpha: alphaOf(measured.shellBackground ?? ""),
      },
    };
  });
}

async function searchTab(page, check, trace) {
  await runCheck(check, trace, CHECKS.searchTab, async () => {
    await go(page, SEARCH_HASH);
    const ready = await waitFor(
      page,
      `document.querySelector('.search-source-tabs button[aria-selected="true"]')`,
      15_000,
    );
    const colors = await readPage(
      page,
      `const probe = (value) => {
         const node = document.createElement("span");
         node.style.color = value;
         document.body.appendChild(node);
         const color = getComputedStyle(node).color;
         node.remove();
         return color;
       };
       const selected = document.querySelector('.search-source-tabs button[aria-selected="true"]');
       return {
         selected: selected ? getComputedStyle(selected).color : null,
         text: probe("var(--text)"),
         accentStrong: probe("var(--accent-strong)"),
       };`,
    );
    return {
      passed:
        ready &&
        colors.selected === colors.text &&
        colors.selected !== colors.accentStrong,
      detail: { ready, ...colors },
    };
  });
}

async function openSettings(page) {
  await go(page, "#/settings");
  return waitFor(
    page,
    `document.querySelector('.settings-section[aria-labelledby="appearance-heading"]')`,
    15_000,
  );
}

/** Tab through the dialog and report every press that left it. */
async function tabInside(page, dialogSelector, presses) {
  const leaks = [];
  const seen = new Set();
  for (let index = 0; index < presses; index += 1) {
    await pressTab(page);
    const state = await readPage(
      page,
      `const dialog = document.querySelector(${q(dialogSelector)});
       const active = document.activeElement;
       const label = active ? (active.getAttribute("aria-label") || active.textContent.trim().slice(0, 30) || active.tagName) : null;
       return { inside: Boolean(dialog && active && dialog.contains(active)), label };`,
    );
    if (!state.inside) leaks.push({ press: index + 1, active: state.label });
    if (state.label) seen.add(state.label);
  }
  return { leaks, distinct: seen.size };
}

async function licensesCheck(page, check, trace, artifactDir) {
  await runCheck(check, trace, CHECKS.licenses, async () => {
    const parts = {};
    await openSettings(page);
    await waitFor(page, `document.activeElement?.tagName === "H1"`, 3000);
    await page.evaluate(`
      const opener = [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === "Open-source licenses");
      if (!opener) throw new Error("Open-source licenses button is missing");
      opener.focus();
      window.__uiAuditOpener = opener;
      opener.click();
      return true;`);
    parts.opened = await waitFor(
      page,
      `document.querySelector(".licenses-dialog")`,
      10_000,
    );
    parts.loaded = await waitFor(
      page,
      `document.querySelector(".licenses-dialog .licenses-entry")`,
      10_000,
    );
    parts.tab = await tabInside(page, ".licenses-dialog", 30);
    await pressEscape(page);
    parts.closed = await waitFor(
      page,
      `!document.querySelector(".licenses-dialog")`,
      5000,
    );
    parts.focusReturned = await readPage(
      page,
      `return document.activeElement === window.__uiAuditOpener;`,
    );

    // A failed inventory request (both files blocked) must read as an error.
    await page.send("Network.setBlockedURLs", { urls: LICENSE_URLS });
    try {
      await page.evaluate(`
        [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === "Open-source licenses")?.click();
        return true;`);
      await waitFor(page, `document.querySelector(".licenses-dialog")`, 10_000);
      await waitFor(
        page,
        `document.querySelector(".licenses-dialog [role='alert'], .licenses-dialog .licenses-list .playlist-dialog-feedback:not([role='status'])")`,
        10_000,
      );
      await sleep(300);
      parts.failure = await readPage(
        page,
        `const alert = document.querySelector(".licenses-dialog [role='alert']");
         return {
           alertText: alert?.textContent.trim() ?? null,
           feedback: [...document.querySelectorAll(".licenses-dialog .playlist-dialog-feedback")].map((node) => node.textContent.trim()),
         };`,
      );
      await saveScreenshot(
        page,
        artifactDir,
        "screenshot-ui-audit-licenses-failed.png",
      );
    } finally {
      await page.send("Network.setBlockedURLs", { urls: [] });
      await pressEscape(page);
      await waitFor(page, `!document.querySelector(".licenses-dialog")`, 5000);
    }
    const tabOk = parts.tab.leaks.length === 0 && parts.tab.distinct >= 2;
    const failureOk =
      parts.failure?.alertText === "Licenses could not be loaded.";
    return {
      passed:
        parts.opened &&
        parts.loaded &&
        tabOk &&
        parts.closed &&
        parts.focusReturned &&
        failureOk,
      detail: parts,
    };
  });
}

/** Short description of an element for the trace. */
const DESCRIBE = `(el) => el ? el.tagName + (el.getAttribute("aria-label") ? "[" + el.getAttribute("aria-label") + "]" : "") + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/u).slice(0, 2).join(".") : "") : null`;

/**
 * Waits for RouteView's navigation focus. A page navigation focuses its h1
 * once the view renders (a lazy view later, via RouteView's loadedCount
 * effect), which can land after a test focuses its opener. Bounded: a route
 * that does not change never focuses the h1, so this costs at most the timeout.
 */
async function settleRouteFocus(page) {
  await waitFor(page, `document.activeElement?.tagName === "H1"`, 1500);
  await sleep(150);
}

/** Home, with the route's own focus settled. */
async function openHomeSettled(page) {
  const ready = await openHome(page);
  await settleRouteFocus(page);
  return ready;
}

/**
 * Focuses the opener and confirms it holds focus, re-focusing while a late
 * route focus or a disabled button gets in the way. Returns what it saw.
 */
async function focusOpener(page, openerExpression) {
  let attempts = 0;
  for (; attempts < 10; attempts += 1) {
    const focused = await page.evaluate(
      `const opener = ${openerExpression};
       window.__uiAuditOpener = opener;
       if (!opener) return false;
       opener.focus();
       return document.activeElement === opener;`,
    );
    if (focused) {
      // Stays focused across a short settle, so a late route focus shows up here.
      await sleep(200);
      const held = await page.evaluate(
        `return document.activeElement === window.__uiAuditOpener;`,
      );
      if (held) return { focused: true, attempts: attempts + 1 };
    }
    await sleep(100);
  }
  return { focused: false, attempts };
}

async function modalsCheck(page, check, trace) {
  await runCheck(check, trace, CHECKS.modals, async () => {
    const results = {};
    const dialogs = [
      {
        name: "shortcut overlay",
        dialog: ".shortcut-overlay",
        open: async (detail) => {
          await openHomeSettled(page);
          detail.opener = await focusOpener(page, REFRESH_HOME);
          detail.activeBeforeKey = await readPage(
            page,
            `const describe = ${DESCRIBE}; return describe(document.activeElement);`,
          );
          await pressKey(page, "?", {
            code: "Slash",
            keyCode: 191,
            modifiers: 8,
            text: "?",
          });
        },
      },
      {
        name: "Get Info",
        dialog: ".song-info-dialog",
        open: async (detail) => {
          await fixtureCall(page, "reset");
          await openHomeSettled(page);
          detail.opener = await focusOpener(page, REFRESH_HOME);
          // The menu is anchored to a button, as the app's own card and row
          // action buttons anchor it (requestContextMenu), so Get Info returns
          // focus to that button.
          await fixtureCall(page, "selectContext", ["get-info-song"]);
          await page.evaluate(`
            const opener = window.__uiAuditOpener;
            const target = [...document.querySelectorAll('div[data-context-id="get-info-song"]')].pop();
            const rect = opener.getBoundingClientRect();
            window.dispatchEvent(new CustomEvent("arlet:open-context-menu", { detail: { target, x: rect.right - 4, y: rect.bottom - 4, restoreFocus: opener } }));
            return true;`);
          await waitFor(
            page,
            `document.querySelector('.context-menu [data-menu-item="get-info"]:not(:disabled)')`,
            8000,
          );
          await page.evaluate(
            `document.querySelector('.context-menu [data-menu-item="get-info"]').click(); return true;`,
          );
        },
      },
      {
        name: "playlist dialog",
        dialog: ".playlist-dialog[role='dialog']",
        open: async (detail) => {
          await openHomeSettled(page);
          detail.opener = await focusOpener(page, REFRESH_HOME);
          await page.evaluate(`
            window.dispatchEvent(new CustomEvent("arlet:playlist-dialog", { detail: { mode: "create", tracks: [], restoreFocus: window.__uiAuditOpener } }));
            return true;`);
        },
      },
      {
        name: "reset settings",
        dialog: "[aria-labelledby='reset-settings-title']",
        open: async (detail) => {
          await openSettings(page);
          await settleRouteFocus(page);
          await page.evaluate(`
            const advanced = document.querySelector('.settings-section[aria-labelledby="advanced-heading"] button[aria-controls="advanced-details"]');
            if (advanced?.getAttribute("aria-expanded") !== "true") advanced?.click();
            return true;`);
          await waitFor(
            page,
            `document.querySelector('.settings-section[aria-labelledby="advanced-heading"] button[aria-expanded="true"]')`,
            5000,
          );
          detail.opener = await focusOpener(
            page,
            `[...document.querySelectorAll("button")].find((node) => node.textContent.trim() === "Reset settings…")`,
          );
          await page.evaluate(`window.__uiAuditOpener?.click(); return true;`);
        },
      },
    ];
    for (const entry of dialogs) {
      const detail = {};
      try {
        await closeOverlays(page);
        await entry.open(detail);
        detail.opened = await waitFor(
          page,
          `document.querySelector(${q(entry.dialog)})`,
          10_000,
        );
        detail.openerAtOpen = await readPage(
          page,
          `const describe = ${DESCRIBE};
           const opener = window.__uiAuditOpener;
           return { opener: describe(opener), openerConnected: Boolean(opener?.isConnected), openerDisabled: Boolean(opener?.disabled), active: describe(document.activeElement) };`,
        );
        if (detail.opened) {
          detail.tab = await tabInside(page, entry.dialog, 14);
        }
        if (entry.name === "reset settings") {
          // Cancel only; the reset itself is never confirmed.
          await page.evaluate(`
            [...document.querySelectorAll("[aria-labelledby='reset-settings-title'] button")].find((node) => node.textContent.trim() === "Cancel")?.click();
            return true;`);
        } else {
          await pressEscape(page);
        }
        detail.closed = await waitFor(
          page,
          `!document.querySelector(${q(entry.dialog)})`,
          5000,
        );
        detail.focusReturned = await readPage(
          page,
          `return document.activeElement === window.__uiAuditOpener;`,
        );
        detail.activeAfterClose = await readPage(
          page,
          `const describe = ${DESCRIBE}; return describe(document.activeElement);`,
        );
      } catch (error) {
        detail.error = String(error?.message ?? error);
      }
      detail.passed =
        Boolean(detail.opener?.focused) &&
        Boolean(detail.opened) &&
        Boolean(detail.tab) &&
        detail.tab.leaks.length === 0 &&
        detail.tab.distinct >= 1 &&
        Boolean(detail.closed) &&
        Boolean(detail.focusReturned) &&
        !detail.error;
      results[entry.name] = detail;
    }
    await closeOverlays(page);
    await page.evaluate(`window.__uiAuditOpener = undefined; return true;`);
    return {
      passed: Object.values(results).every((item) => item.passed),
      detail: results,
    };
  });
}

async function homeStatus(page, check, trace, artifactDir) {
  await runCheck(check, trace, CHECKS.homeStatus, async () => {
    await openHome(page);
    const feed = await readPage(
      page,
      `const feed = document.querySelector(".home-feed");
       return { live: feed?.getAttribute("aria-live") ?? null, role: feed?.getAttribute("role") ?? null };`,
    );
    await page.evaluate(`${REFRESH_HOME}.click(); return true;`);
    const seen = [];
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const text = await readPage(
        page,
        `const nodes = [...document.querySelectorAll('.sr-only[role="status"]')];
         return nodes.map((node) => node.textContent.trim()).find((value) => value.startsWith("Loading Home") || value.startsWith("Home updated")) ?? "";`,
      );
      if (text && seen[seen.length - 1] !== text) seen.push(text);
      if (text === "Home updated.") break;
      await sleep(25);
    }
    await sleep(200);
    await saveScreenshot(page, artifactDir, "screenshot-ui-audit-home.png");
    const feedLive = feed.live !== null;
    return {
      passed:
        !feedLive &&
        seen.length > 0 &&
        seen[seen.length - 1] === "Home updated.",
      detail: { feedAriaLive: feed.live, feedRole: feed.role, sequence: seen },
    };
  });
}

async function homeRetry(page, check, trace) {
  await runCheck(check, trace, CHECKS.homeRetry, async () => {
    try {
      await fixtureCall(page, "reset");
      await openHome(page);
      await fixtureCall(page, "configure", [
        { rejectPaths: [HOME_HISTORY_PATH] },
      ]);
      await page.evaluate(`${REFRESH_HOME}.click(); return true;`);
      const noticeShown = await waitFor(
        page,
        `[...document.querySelectorAll(".home-section-stale")].some((node) => node.textContent.includes(${q(NOTICE_TEXT)}))`,
        15_000,
      );
      const hasButton = await readPage(
        page,
        `const notice = [...document.querySelectorAll(".home-section-stale")].find((node) => node.textContent.includes(${q(NOTICE_TEXT)}));
         return { button: notice?.querySelector("button")?.textContent.trim() ?? null };`,
      );
      await fixtureCall(page, "configure", [{ rejectPaths: [] }]);
      await page.evaluate(`
        const notice = [...document.querySelectorAll(".home-section-stale")].find((node) => node.textContent.includes(${q(NOTICE_TEXT)}));
        notice?.querySelector("button")?.click();
        return true;`);
      const cleared = await waitFor(
        page,
        `!([...document.querySelectorAll(".home-section-stale")].some((node) => node.textContent.includes(${q(NOTICE_TEXT)})))`,
        15_000,
      );
      return {
        passed: noticeShown && hasButton.button === "Try again" && cleared,
        detail: { noticeShown, ...hasButton, cleared },
      };
    } finally {
      await fixtureCall(page, "configure", [{ rejectPaths: [] }]);
    }
  });
}

async function labelMore(page, check, trace) {
  await runCheck(check, trace, CHECKS.labelMore, async () => {
    try {
      await fixtureCall(page, "configure", [{ longLabelDescription: true }]);
      await go(page, LABEL_HASH);
      await waitFor(
        page,
        `document.querySelector('.record-label-page .library-detail-hero h1')`,
        15_000,
      );
      const before = await readPage(
        page,
        `const hero = document.querySelector(".record-label-page .library-detail-hero");
         const toggle = document.querySelector(".record-label-notes .library-detail-more-toggle");
         return {
           heroHasDescription: hero?.textContent.includes(${q(LABEL_DESCRIPTION_START)}) ?? null,
           toggleFound: Boolean(toggle),
           expanded: toggle?.getAttribute("aria-expanded") ?? null,
           panelVisible: Boolean(document.getElementById("record-label-notes-panel")) && !document.getElementById("record-label-notes-panel").hidden,
         };`,
      );
      await page.evaluate(
        `document.querySelector(".record-label-notes .library-detail-more-toggle")?.click(); return true;`,
      );
      const revealed = await waitFor(
        page,
        `document.querySelector(".record-label-notes .library-detail-more-toggle")?.getAttribute("aria-expanded") === "true" && document.querySelector("#record-label-notes-panel")?.textContent.includes(${q(LABEL_DESCRIPTION_START)})`,
        5000,
      );
      const after = await readPage(
        page,
        `return { expanded: document.querySelector(".record-label-notes .library-detail-more-toggle")?.getAttribute("aria-expanded") ?? null };`,
      );
      return {
        passed:
          before.heroHasDescription === false &&
          before.toggleFound &&
          before.expanded === "false" &&
          revealed &&
          after.expanded === "true",
        detail: { ...before, revealed, expandedAfterClick: after.expanded },
      };
    } finally {
      await fixtureCall(page, "configure", [{ longLabelDescription: false }]);
    }
  });
}

async function mediaLog(page, check, trace, logDir) {
  await runCheck(check, trace, CHECKS.mediaLog, async () => {
    try {
      await fixtureCall(page, "reset");
      await page.evaluate(`
        const music = window.MusicKit.getInstance();
        await music.setQueue({ songs: ${q(UP_NEXT_IDS)} });
        await music.play();
        return true;`);
      await waitFor(
        page,
        `document.querySelector('.player-bar .player-track-copy strong')`,
        10_000,
      );
      await fixtureCall(page, "configure", [{ rejectSkip: true }]);
      const before = logCount(logDir, MEDIA_TEXT);
      // The page cannot call plugin:event|emit (the ACL refuses it), so the
      // harness hook runs the listeners the app registered for the event.
      const listeners = await page.evaluate(
        `return window.__ARLET_E2E_TAURI_EVENTS__.emit("windows-media-control", "next");`,
      );
      const emitted = listeners > 0 ? "emitted" : "no listeners";
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && logCount(logDir, MEDIA_TEXT) <= before) {
        await sleep(100);
      }
      const after = logCount(logDir, MEDIA_TEXT);
      const transitions = (await snapshot(page)).transitions.filter(
        (item) => item.type === "skipRejected",
      ).length;
      return {
        passed: emitted === "emitted" && after > before && transitions >= 1,
        detail: {
          emitted,
          before,
          after,
          skipRejections: transitions,
          expected: MEDIA_TEXT,
        },
      };
    } finally {
      await fixtureCall(page, "configure", [{ rejectSkip: false }]);
    }
  });
}

/** Walks every visible text node of the page and reports those under 11 px. */
const TEXT_SIZE_SCAN = `
  const pathOf = (node) => {
    const parts = [];
    let current = node;
    while (current && current !== document.body && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      if (current.id) part += "#" + current.id;
      else if (current.classList.length) part += "." + [...current.classList].slice(0, 2).join(".");
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const offenders = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.textContent.trim()) continue;
    const element = node.parentElement;
    if (!element || element.closest('[aria-hidden="true"], .sr-only, script, style, [hidden], [inert]')) continue;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") continue;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const size = parseFloat(style.fontSize);
    if (!(size < 11)) continue;
    const path = pathOf(element);
    if (seen.has(path)) continue;
    seen.add(path);
    offenders.push({ path, size, text: node.textContent.trim().slice(0, 40) });
  }
  return offenders;
`;

async function textSize(page, check, trace) {
  await runCheck(check, trace, CHECKS.textSize, async () => {
    await fixtureCall(page, "reset");
    await page.evaluate(`
      const music = window.MusicKit.getInstance();
      await music.setQueue({ songs: ${q(UP_NEXT_IDS)} });
      await music.play();
      return true;`);
    await waitFor(
      page,
      `document.querySelector('.player-bar .player-track-copy strong')`,
      10_000,
    );
    const views = [
      { name: "home", open: () => openHome(page) },
      {
        name: "search",
        open: () =>
          go(page, SEARCH_HASH).then(() =>
            waitFor(
              page,
              `document.querySelector('.search-source-tabs')`,
              15_000,
            ),
          ),
      },
      {
        name: "album",
        open: () =>
          go(page, "#/album/album-1?source=library").then(() =>
            waitFor(
              page,
              `document.querySelector('.content-scroll h1')`,
              15_000,
            ),
          ),
      },
      {
        name: "library albums",
        open: () =>
          go(page, "#/library/albums").then(() =>
            waitFor(
              page,
              `document.querySelector('.content-scroll h1')`,
              15_000,
            ),
          ),
      },
      { name: "settings", open: () => openSettings(page) },
      {
        name: "queue drawer",
        open: async () => {
          await go(page, "#/home");
          await openHome(page);
          await page.evaluate(
            `if (!document.querySelector("aside.queue-drawer")) document.querySelector('button[aria-label="Toggle Playing Next"]')?.click(); return true;`,
          );
          return waitFor(
            page,
            `document.querySelector("aside.queue-drawer .queue-row")`,
            8000,
          );
        },
      },
      {
        name: "now playing",
        open: async () => {
          await page.evaluate(
            `document.querySelector('.player-artwork-button')?.click(); return true;`,
          );
          return waitFor(page, `document.querySelector(".now-playing")`, 8000);
        },
      },
    ];
    const results = {};
    const offenders = [];
    for (const view of views) {
      await closeOverlays(page);
      const ready = await view.open();
      await sleep(400);
      const found = await readPage(page, TEXT_SIZE_SCAN);
      results[view.name] = { ready: Boolean(ready), offenders: found.length };
      for (const item of found) offenders.push({ view: view.name, ...item });
    }
    await closeOverlays(page);
    await waitFor(page, `!document.querySelector("aside.queue-drawer")`, 3000);
    return {
      passed: offenders.length === 0,
      detail: {
        views: results,
        offenders: offenders.slice(0, 60),
        total: offenders.length,
      },
    };
  });
}

async function contentWidth(page, check, trace) {
  await runCheck(check, trace, CHECKS.contentWidth, async () => {
    const measure = () =>
      readPage(
        page,
        `const scroll = document.querySelector(".content-scroll");
         const style = getComputedStyle(scroll);
         const block = [...scroll.children].find((node) => node.getClientRects().length > 0 && getComputedStyle(node).position !== "fixed");
         return {
           innerWidth: window.innerWidth,
           blockWidth: block ? Math.round(block.getBoundingClientRect().width * 10) / 10 : null,
           contentBox: Math.round((scroll.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) * 10) / 10,
         };`,
      );
    const setWidth = async (width) => {
      await page.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await waitFor(page, `window.innerWidth === ${width}`, 3000);
      await sleep(300);
    };
    try {
      await openHome(page);
      await setWidth(WIDE_WIDTH);
      const wide = await measure();
      await setWidth(MID_WIDTH);
      const mid = await measure();
      const wideOk =
        wide.blockWidth !== null &&
        Math.abs(wide.blockWidth - CONTENT_MAX) <= 2;
      const midOk =
        mid.blockWidth !== null &&
        mid.blockWidth < CONTENT_MAX &&
        Math.abs(mid.blockWidth - mid.contentBox) <= 2;
      return {
        passed: wideOk && midOk,
        detail: { wide, mid, expectedWide: CONTENT_MAX },
      };
    } finally {
      await page.send("Emulation.clearDeviceMetricsOverride", {});
      await sleep(200);
    }
  });
}

async function readyForNext(page, check, trace, baseline) {
  let detail;
  let passed = false;
  try {
    await fixtureCall(page, "reset");
    await page.send("Network.setBlockedURLs", { urls: [] });
    await page.send("Emulation.clearDeviceMetricsOverride", {});
    await closeOverlays(page);
    await page.evaluate(`
      document.querySelector('aside.queue-drawer button[aria-label="Close Playing Next"]')?.click();
      return true;`);
    await openHome(page);
    const state = await readPage(
      page,
      `return {
         signedInUi: document.querySelector(".titlebar-status")?.textContent.trim() ?? null,
         shell: Boolean(document.querySelector(".app-shell")),
         miniPlayer: Boolean(document.querySelector(".mini-player")),
         overlays: [".now-playing", ".playlist-dialog-backdrop", ".shortcut-backdrop", ".song-info-dialog", ".licenses-dialog", "aside.queue-drawer"].filter((sel) => document.querySelector(sel)),
         width: window.innerWidth,
       };`,
    );
    const snap = await snapshot(page);
    const controls = snap.controls ?? {};
    const held =
      snap.queueEdit?.setQueueHeld === 0 &&
      snap.seekHeld === 0 &&
      snap.authorizeHeld === 0;
    const leftover = {
      rejectPaths: controls.rejectPaths,
      rejectSkip: controls.rejectSkip,
      longLabelDescription: controls.longLabelDescription,
      rejectPlay: controls.rejectPlay,
      rejectSetQueue: controls.rejectSetQueue,
    };
    const leftoversOk = Object.values(leftover).every(
      (value) =>
        value === false ||
        value === undefined ||
        (Array.isArray(value) && value.length === 0),
    );
    passed =
      String(state.signedInUi ?? "").includes("Connected") &&
      snap.authorized === true &&
      state.shell &&
      !state.miniPlayer &&
      state.overlays.length === 0 &&
      state.width === baseline.width &&
      held &&
      leftoversOk;
    detail = { ...state, baselineWidth: baseline.width, held, leftover };
  } catch (error) {
    detail = { error: String(error?.message ?? error) };
  }
  check(CHECKS.ready, passed, detail);
}

export async function runUiAudit({ page, check, artifactDir, logDir }) {
  const trace = {};
  const baseline = await readPage(page, `return { width: window.innerWidth };`);
  try {
    await fixtureCall(page, "reset");
    await upNextGaps(page, check, trace, artifactDir);
    await narrowPlayer(page, check, trace, artifactDir);
    await shelfWidths(page, check, trace, artifactDir);
    await headingFocus(page, check, trace);
    await activeRow(page, check, trace, artifactDir);
    await searchTab(page, check, trace);
    await licensesCheck(page, check, trace, artifactDir);
    await modalsCheck(page, check, trace);
    await homeStatus(page, check, trace, artifactDir);
    await homeRetry(page, check, trace);
    await labelMore(page, check, trace);
    await mediaLog(page, check, trace, logDir);
    await textSize(page, check, trace);
    await contentWidth(page, check, trace);
  } finally {
    await readyForNext(page, check, trace, baseline);
    const fixture = await snapshot(page).catch((error) => ({
      error: String(error?.message ?? error),
    }));
    await writeFile(
      path.join(artifactDir, "ui-audit-trace.json"),
      `${JSON.stringify({ baseline, checks: trace, fixture }, null, 2)}\n`,
    );
  }
}
