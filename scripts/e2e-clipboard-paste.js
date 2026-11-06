#!/usr/bin/env node

/*
 * Context-menu Paste. Failure modes guarded:
 *  - Paste is missing or disabled on an editable field, or the text never
 *    reaches the input.
 *  - A synthetic click reads the clipboard; only a trusted user gesture may.
 *  - The generic clipboard-manager read permission survived the hardening, so
 *    any script in the window can read silently again.
 *  - The built bundle still imports the plugin read or the custom read command
 *    is missing from the capability.
 *  - Paste leaves the input, menu, focus, or the tester's clipboard dirty.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { restoreClipboard } from "./e2e-clipboard.js";
import { fixtureCall, sleep, waitFor as pollFor } from "./e2e-helpers.js";

const ASSET_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "assets",
);
const KNOWN_TEXT = "Arlet E2E paste 7f3c";
const INPUT = ".sidebar-search input";
const PASTE_ITEM = `.context-menu [data-menu-item="paste"]:not(:disabled)`;
const PASTE_ITEM_READY = `document.querySelector(${JSON.stringify(PASTE_ITEM)})`;

const waitFor = (page, expression, timeoutMs = 4000) =>
  pollFor(page, expression, timeoutMs, 50);

/** Adds the failing step to a DevTools error so the report names it. */
async function step(label, work) {
  try {
    return await work;
  } catch (error) {
    throw new Error(`${label}: ${error?.message ?? error}`);
  }
}

/** Reads a numeric point from an on-page element, or null when absent. */
function centerOf(page, selector) {
  return page.evaluate(`
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  `);
}

/** Built entrypoints that still import the generic plugin clipboard read. */
function pluginReadAssets() {
  return fs
    .readdirSync(ASSET_DIR)
    .filter((file) => file.endsWith(".js"))
    .filter((file) =>
      fs
        .readFileSync(path.join(ASSET_DIR, file), "utf8")
        .includes("plugin:clipboard-manager|read_text"),
    );
}

async function clickAt(page, point, button = "left") {
  const buttons = button === "right" ? 2 : 1;
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button,
    buttons,
    clickCount: 1,
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button,
    buttons: 0,
    clickCount: 1,
  });
  await sleep(150);
}

/** Reads the clipboard through the same command the Paste action uses. */
function readPasteClipboard(page) {
  return page.evaluate(
    `try {
      return {
        ok: true,
        text: await window.__TAURI_INTERNALS__.invoke("paste_clipboard_text"),
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 300) };
    }`,
    { timeoutMs: 3000 },
  );
}

/** Seeds the fixture text through the still-allowed native write command. */
function seedClipboard(page) {
  return page.evaluate(
    `let lastError = null;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      try {
        await window.__TAURI_INTERNALS__.invoke(
          "plugin:clipboard-manager|write_text",
          { text: ${JSON.stringify(KNOWN_TEXT)} },
        );
        return { ok: true, attempts: attempt };
      } catch (error) {
        lastError = String(error?.message ?? error).slice(0, 300);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return { ok: false, error: lastError };`,
    { timeoutMs: 5000 },
  );
}

/** Focuses and clears the sidebar search, returning whether it owns focus. */
function focusInput(page) {
  return page.evaluate(`
    const input = document.querySelector(${JSON.stringify(INPUT)});
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    return document.activeElement === input;
  `);
}

export async function runClipboardPaste({ page, check, artifactDir }) {
  await fixtureCall(page, "reset");
  await page.evaluate(`location.hash = "#/home"; return true;`);
  const shellReady = await waitFor(
    page,
    `document.querySelector(".app-shell .player-bar")`,
    12_000,
  );
  const inputReady = await waitFor(
    page,
    `document.querySelector(${JSON.stringify(INPUT)})`,
    8000,
  );
  check(
    "clipboard paste has a ready shell and text field",
    shellReady && inputReady,
    {
      shellReady,
      inputReady,
    },
  );
  if (!shellReady || !inputReady) return;

  // The generic plugin read must be gone: any script in the main window could
  // otherwise read the clipboard without a gesture.
  const pluginRead = await page.evaluate(`
    try {
      await window.__TAURI_INTERNALS__.invoke("plugin:clipboard-manager|read_text");
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 300) };
    }
  `);
  check(
    "the clipboard-manager read permission is not granted",
    pluginRead.ok === false,
    { pluginRead },
  );
  const readImports = pluginReadAssets();
  check(
    "the built bundle has no clipboard-manager read import",
    readImports.length === 0,
    { readImports },
  );

  const previousRead = await readPasteClipboard(page);
  const previous =
    previousRead.ok && typeof previousRead.text === "string"
      ? previousRead.text
      : null;
  // An image-only or empty clipboard has no text to preserve. That is not a
  // permission failure; anything else is.
  const previousEmpty = /contents were not available|clipboard is empty/i.test(
    previousRead.error ?? "",
  );
  check(
    "the paste command can read the clipboard or finds it empty",
    previousRead.ok === true || previousEmpty,
    { ...previousRead, previousEmpty },
  );
  if (previousRead.ok !== true && !previousEmpty) return;

  const seeded = await seedClipboard(page);
  check("the clipboard write permission seeds the fixture text", seeded.ok, {
    seeded,
  });
  if (!seeded.ok) return;

  const seededRead = await readPasteClipboard(page);
  check(
    "the paste command returns the seeded clipboard text",
    seededRead.ok === true && seededRead.text === KNOWN_TEXT,
    seededRead,
  );
  if (seededRead.ok !== true || seededRead.text !== KNOWN_TEXT) {
    restoreClipboard(previous, KNOWN_TEXT);
    return;
  }

  const focused = await step("focus input", focusInput(page));
  const inputPoint = await step("input point", centerOf(page, INPUT));
  if (!focused || !inputPoint) {
    check("clipboard paste can focus the text field", false, {
      focused,
      inputPoint,
    });
    return;
  }

  // 1. A synthetic click closes the menu but must not read or insert anything.
  await step("right click input", clickAt(page, inputPoint, "right"));
  const untrustedMenu = await step(
    "wait for paste item",
    waitFor(page, PASTE_ITEM_READY),
  );
  const untrustedClicked = untrustedMenu
    ? await step(
        "synthetic paste click",
        page.evaluate(`
        const item = document.querySelector(${JSON.stringify(PASTE_ITEM)});
        if (!item) return false;
        item.click();
        return true;
      `),
      )
    : false;
  await sleep(300);
  const untrustedValue = await step(
    "read input after synthetic click",
    page.evaluate(
      `return document.querySelector(${JSON.stringify(INPUT)})?.value ?? null;`,
    ),
  );
  check(
    "a synthetic Paste click does not read the clipboard",
    untrustedMenu && untrustedClicked && untrustedValue === "",
    { untrustedMenu, untrustedClicked, untrustedValue },
  );
  await waitFor(page, `!document.querySelector(".context-menu")`, 2000);

  // 2. A real click pastes the seeded text into the focused field.
  await focusInput(page);
  await clickAt(page, inputPoint, "right");
  const pasteMenu = await waitFor(page, PASTE_ITEM_READY);
  const pastePoint = await centerOf(page, PASTE_ITEM);
  if (pasteMenu && pastePoint) await clickAt(page, pastePoint);
  const pasted = await waitFor(
    page,
    `document.querySelector(${JSON.stringify(INPUT)})?.value === ${JSON.stringify(KNOWN_TEXT)}`,
    5000,
  );
  const inputValue = await page.evaluate(
    `return document.querySelector(${JSON.stringify(INPUT)})?.value ?? null;`,
  );
  const focusAfterPaste = await page.evaluate(
    `return document.activeElement === document.querySelector(${JSON.stringify(INPUT)});`,
  );
  check(
    "a trusted Paste click inserts the clipboard text",
    pasteMenu && pasted && inputValue === KNOWN_TEXT,
    { pasteMenu, pasted, inputValue },
  );
  check("Paste returns focus to the text field", focusAfterPaste, {
    focusAfterPaste,
  });

  // 3. Leave the next scenario a clean field and menu.
  await page.evaluate(`
    const input = document.querySelector(${JSON.stringify(INPUT)});
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
    }
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    return true;
  `);

  // Restore only while the clipboard still holds this check's text. The helper
  // also keeps the restore out of clipboard history and cloud sync.
  const clipboardRestore = restoreClipboard(previous, KNOWN_TEXT);
  check(
    "the clipboard is restored or left safe after Paste",
    ["restored", "cleared", "changed"].includes(clipboardRestore),
    {
      clipboardRestore,
      hadPreviousText: previous !== null,
    },
  );

  fs.writeFileSync(
    path.join(artifactDir, "clipboard-paste.json"),
    `${JSON.stringify(
      {
        knownText: KNOWN_TEXT,
        pluginRead,
        readImports,
        previousRead: {
          ok: previousRead.ok,
          hadText: previous !== null,
          empty: previousEmpty,
        },
        seeded,
        seedVerified: seededRead,
        untrusted: { untrustedMenu, untrustedClicked, untrustedValue },
        paste: {
          pasteMenu,
          pasted,
          inputValue,
          focusAfterPaste,
          clipboardRestore,
        },
      },
      null,
      2,
    )}\n`,
  );
}
