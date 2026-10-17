/* Helpers shared by the native E2E scenarios. Each scenario keeps its own
 * failure modes in docs/TESTING.md; these only drive the page. */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Calls one method on the injected MusicKit fixture and returns its result. */
export function fixtureCall(page, method, args = []) {
  return page.evaluate(`
    return await window.__ARLET_E2E_MUSIC__[${JSON.stringify(method)}](...${JSON.stringify(args)});
  `);
}

/** Polls a page expression until it is truthy or the timeout passes. */
export async function waitFor(page, expression, timeoutMs = 8000, pollMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(`return Boolean(${expression});`)) return true;
    await sleep(pollMs);
  }
  return false;
}
