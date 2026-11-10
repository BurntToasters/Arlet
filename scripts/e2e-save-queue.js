// Saving a long queue as a playlist: one create with the first batch, then the
// remaining tracks in sequential add requests. A failed add keeps the playlist
// with what already arrived, reports the counts, and stops. The same scenario
// checks that a short save still goes out as one create with its tracks inline.

import { fixtureCall, sleep, waitFor } from "./e2e-helpers.js";

const CHUNK_SIZE = 100;
const LONG_QUEUE = 600;
const SHORT_QUEUE = 5;
const CREATE_PATH = "/v1/me/library/playlists";
const LAST_ROW_NUMBER = `(() => {
  const scroller = document.querySelector(".content-scroll");
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  const numbers = [...document.querySelectorAll(".library-row-number")];
  return numbers.at(-1)?.textContent?.trim() ?? null;
})()`;

const q = (value) => JSON.stringify(value);
const snapshot = (page) => fixtureCall(page, "snapshot");
const expectedIds = (count) =>
  Array.from({ length: count }, (_, index) => `bulk-${index}`);

function typeInto(page, selector, value) {
  return page.evaluate(`
    const field = document.querySelector(${q(selector)});
    if (!field) return false;
    field.focus();
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(field),
      "value",
    ).set;
    setter.call(field, ${q(value)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
}

async function dismissToasts(page) {
  await page.evaluate(`
    for (const button of document.querySelectorAll('.action-toast button')) {
      button.click();
    }
    return true;`);
}

async function openQueue(page) {
  const alreadyOpen = await waitFor(
    page,
    `document.querySelector(".queue-drawer[data-state='open']")`,
    2500,
  );
  if (!alreadyOpen) {
    await page.evaluate(
      `document.querySelector('button[aria-label="Toggle Playing Next"]')?.click(); return true;`,
    );
  }
  return waitFor(
    page,
    `document.querySelector(".queue-drawer[data-state='open'] .queue-toolbar")`,
    8000,
  );
}

/** Opens the save dialog, names it, and submits; returns the request mark. */
async function submitSave(page, name, count) {
  const marked = (await snapshot(page)).requests.length;
  await page.evaluate(`
    [...document.querySelectorAll(".queue-toolbar button")]
      .find((node) => node.textContent.trim() === "Save as playlist")?.click();
    return true;`);
  const offered = await waitFor(
    page,
    `document.querySelector(".playlist-dialog")?.textContent.includes(${q(`${count} selected songs`)})`,
    10_000,
  );
  const typed = await typeInto(
    page,
    ".playlist-dialog-form input[type='text']",
    name,
  );
  await page.evaluate(
    `document.querySelector(".playlist-dialog-form")?.requestSubmit(); return true;`,
  );
  const closed = await waitFor(
    page,
    `!document.querySelector(".playlist-dialog-backdrop")`,
    15_000,
  );
  return { mark: marked, offered, typed, closed };
}

function postRequests(snapshotValue, pathname, mark) {
  return snapshotValue.requests
    .slice(mark)
    .filter(
      (request) =>
        request.method === "POST" && request.path.split("?", 1)[0] === pathname,
    );
}

function addRequests(snapshotValue, mark) {
  return snapshotValue.requests
    .slice(mark)
    .filter(
      (request) =>
        request.method === "POST" &&
        /^\/v1\/me\/library\/playlists\/[^/]+\/tracks$/u.test(
          request.path.split("?", 1)[0],
        ),
    );
}

async function openSavedPlaylist(page, name, count) {
  await page.evaluate(`location.hash = "#/library/playlists"; return true;`);
  await sleep(150);
  await page.evaluate(
    `location.hash = "#/playlist/saved-playlist-1"; return true;`,
  );
  const titled = await waitFor(
    page,
    `document.querySelector(".library-detail-hero h1")?.textContent === ${q(name)}`,
    15_000,
  );
  const counted = await waitFor(
    page,
    `document.querySelector(".library-detail-meta")?.textContent.includes(${q(`${count} songs`)})`,
    20_000,
  );
  const lastRow = await waitFor(
    page,
    `${LAST_ROW_NUMBER} === ${q(String(count))}`,
    20_000,
  );
  return { titled, counted, lastRow };
}

async function longSave(page, check) {
  await fixtureCall(page, "reset");
  await dismissToasts(page);
  await fixtureCall(page, "seedQueue", [LONG_QUEUE]);
  const drawer = await openQueue(page);
  const save = await submitSave(page, "Long Queue Save", LONG_QUEUE);
  const toast = await waitFor(
    page,
    `[...document.querySelectorAll(".action-toast-message")].some((node) => node.textContent.includes(${q(`Saved ${LONG_QUEUE} songs to`)}) )`,
    10_000,
  );
  const result = await snapshot(page);
  const creates = postRequests(result, CREATE_PATH, save.mark);
  const adds = addRequests(result, save.mark);
  const createIds = (creates[0]?.body?.relationships?.tracks?.data ?? []).map(
    (ref) => ref.id,
  );
  const addSizes = adds.map((request) => request.body?.data?.length ?? 0);
  const addIds = adds.flatMap((request) =>
    (request.body?.data ?? []).map((ref) => ref.id),
  );
  const sequential = adds.every((request, index) =>
    index === 0
      ? creates[0] !== undefined && request.startedAt >= creates[0].completedAt
      : request.startedAt >= adds[index - 1].completedAt,
  );
  const created = result.playlistMutations.created[0];
  const expected = expectedIds(LONG_QUEUE);
  const savedAll =
    JSON.stringify(created?.trackIds ?? []) === JSON.stringify(expected);
  const detail = await openSavedPlaylist(page, "Long Queue Save", LONG_QUEUE);
  check(
    "a 600-song save makes one create and sequential add batches",
    drawer &&
      save.offered &&
      save.typed &&
      save.closed &&
      toast &&
      creates.length === 1 &&
      createIds.length === CHUNK_SIZE &&
      adds.length === LONG_QUEUE / CHUNK_SIZE - 1 &&
      addSizes.every((size) => size > 0 && size <= CHUNK_SIZE) &&
      JSON.stringify([...createIds, ...addIds]) === JSON.stringify(expected) &&
      sequential &&
      savedAll,
    {
      drawer,
      offered: save.offered,
      typed: save.typed,
      closed: save.closed,
      toast,
      creates: creates.length,
      createTracks: createIds.length,
      addSizes,
      sequential,
      savedAll,
      createdCount: created?.trackIds?.length ?? 0,
    },
  );
  check(
    "the created playlist page lists every saved song",
    detail.titled && detail.counted && detail.lastRow,
    detail,
  );
}

async function shortSave(page, check) {
  await fixtureCall(page, "reset");
  await dismissToasts(page);
  await fixtureCall(page, "seedQueue", [SHORT_QUEUE]);
  const drawer = await openQueue(page);
  const save = await submitSave(page, "Short Queue Save", SHORT_QUEUE);
  const result = await snapshot(page);
  const creates = postRequests(result, CREATE_PATH, save.mark);
  const adds = addRequests(result, save.mark);
  const ids = (creates[0]?.body?.relationships?.tracks?.data ?? []).map(
    (ref) => ref.id,
  );
  check(
    "a short save stays one create with its tracks inline",
    drawer &&
      save.offered &&
      save.typed &&
      save.closed &&
      creates.length === 1 &&
      adds.length === 0 &&
      JSON.stringify(ids) === JSON.stringify(expectedIds(SHORT_QUEUE)),
    {
      drawer,
      offered: save.offered,
      typed: save.typed,
      closed: save.closed,
      creates: creates.length,
      adds: adds.length,
      ids,
    },
  );
}

async function partialSave(page, check) {
  await fixtureCall(page, "reset");
  await dismissToasts(page);
  await fixtureCall(page, "configure", [{ failNextPlaylistAdd: { nth: 3 } }]);
  await fixtureCall(page, "seedQueue", [LONG_QUEUE]);
  const drawer = await openQueue(page);
  const save = await submitSave(page, "Partial Queue Save", LONG_QUEUE);
  const savedCount = CHUNK_SIZE * 3;
  const failedCount = LONG_QUEUE - savedCount;
  const toast = await waitFor(
    page,
    `[...document.querySelectorAll(".action-toast-message")].some((node) => node.textContent.includes(${q(`Saved ${savedCount} of ${LONG_QUEUE} songs`)}) && node.textContent.includes(${q(`${failedCount} could not be added`)}) )`,
    10_000,
  );
  // Give any accidental retry time to show up before the counts are frozen.
  await sleep(600);
  const result = await snapshot(page);
  const creates = postRequests(result, CREATE_PATH, save.mark);
  const adds = addRequests(result, save.mark);
  const failedAdds = adds.filter((request) => request.failedPlaylistAdd);
  const created = result.playlistMutations.created[0];
  const detail = await openSavedPlaylist(
    page,
    "Partial Queue Save",
    savedCount,
  );
  check(
    "a failed add keeps the saved tracks, stops, and reports the counts",
    drawer &&
      save.offered &&
      save.typed &&
      save.closed &&
      toast &&
      creates.length === 1 &&
      adds.length === 3 &&
      failedAdds.length === 1 &&
      adds[2]?.failedPlaylistAdd === true &&
      created?.trackIds?.length === savedCount &&
      JSON.stringify(created.trackIds) ===
        JSON.stringify(expectedIds(savedCount)) &&
      detail.titled &&
      detail.counted,
    {
      drawer,
      offered: save.offered,
      typed: save.typed,
      closed: save.closed,
      toast,
      creates: creates.length,
      adds: adds.length,
      failedAdds: failedAdds.length,
      saved: created?.trackIds?.length ?? 0,
      detail,
    },
  );
}

export async function runSaveQueue({ page, check }) {
  try {
    await longSave(page, check);
    await shortSave(page, check);
    await partialSave(page, check);
  } finally {
    await fixtureCall(page, "reset");
    await dismissToasts(page);
  }
}
