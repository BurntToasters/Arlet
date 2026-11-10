const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 60_000;

function detail(error) {
  const code = error?.cause?.code ?? error?.code;
  if (code && error?.message) return `${code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  if (typeof error?.message === "string" && error.message) return error.message;
  if (typeof error === "string") return error;
  return "unknown transport error";
}

function childFailure(child) {
  if (child?.spawnError)
    return `Arlet could not start: ${detail(child.spawnError)}`;
  if (child?.exitCode !== null && child?.exitCode !== undefined) {
    return `Arlet exited during startup (exit code ${child.exitCode})`;
  }
  if (child?.signalCode) {
    return `Arlet exited during startup (signal ${child.signalCode})`;
  }
  return undefined;
}

/** Fetches and parses JSON with a deadline that also covers JSON decoding. */
export async function fetchJsonWithTimeout(
  url,
  { timeoutMs = 2_000, fetchImpl = fetch } = {},
) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error(`request timed out after ${timeoutMs}ms: ${url}`);
      error.code = "ETIMEDOUT";
      reject(error);
    }, timeoutMs);
  });
  const request = (async () => {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while requesting ${url}`);
    }
    return response.json();
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Finds the app page without allowing a stuck request to exceed startup time. */
export async function findPageTarget({
  port = 9333,
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  requestTimeoutMs = 2_000,
  launched,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastSeen = "port never answered";
  while (now() < deadline) {
    const failure = childFailure(launched);
    if (failure) throw new Error(`[e2e-cdp] ${failure}`);
    const remaining = deadline - now();
    try {
      const targets = await fetchJsonWithTimeout(
        `http://127.0.0.1:${port}/json/list`,
        {
          timeoutMs: Math.max(1, Math.min(requestTimeoutMs, remaining)),
          fetchImpl,
        },
      );
      if (!Array.isArray(targets)) {
        throw new Error("DevTools target list was not an array");
      }
      lastSeen = `targets: ${JSON.stringify(
        targets.map((target) => ({ type: target.type, url: target.url })),
      ).slice(0, 300)}`;
      const page = targets.find(
        (target) =>
          target.type === "page" &&
          /^(https?:\/\/tauri\.localhost|tauri:\/\/localhost)/u.test(
            target.url,
          ),
      );
      if (page) return page;
    } catch (error) {
      lastSeen = detail(error);
    }
    const afterRequestFailure = childFailure(launched);
    if (afterRequestFailure)
      throw new Error(`[e2e-cdp] ${afterRequestFailure}`);
    const remainingAfterRequest = deadline - now();
    if (remainingAfterRequest > 0) {
      await sleep(Math.min(250, remainingAfterRequest));
    }
  }
  const failure = childFailure(launched);
  if (failure) throw new Error(`[e2e-cdp] ${failure}`);
  throw new Error(
    `[e2e-cdp] app webview never exposed a debugging target on port ${port} (${lastSeen})`,
  );
}

/** A bounded CDP connection which rejects every waiter on transport failure. */
export function connectCdp(
  url,
  {
    WebSocketImpl = globalThis.WebSocket,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    openTimeoutMs = 10_000,
  } = {},
) {
  if (typeof WebSocketImpl !== "function") {
    throw new Error("this Node runtime does not provide WebSocket");
  }
  const socket = new WebSocketImpl(url);
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  let openedOnce = false;
  let openTimer;
  let settleOpened;
  let rejectOpened;
  const opened = new Promise((resolve, reject) => {
    settleOpened = resolve;
    rejectOpened = reject;
  });

  const rejectPending = (error) => {
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer);
      pending.delete(id);
      waiter.reject(error);
    }
  };
  const closeWithError = (error) => {
    if (closed) return;
    closed = true;
    clearTimeout(openTimer);
    if (!openedOnce) rejectOpened(error);
    rejectPending(error);
  };

  socket.addEventListener(
    "open",
    () => {
      if (closed || openedOnce) return;
      openedOnce = true;
      clearTimeout(openTimer);
      settleOpened();
    },
    { once: true },
  );
  socket.addEventListener("error", (event) => {
    closeWithError(new Error(`DevTools transport error: ${detail(event)}`));
    try {
      socket.close();
    } catch {
      // Pending commands are already rejected.
    }
  });
  socket.addEventListener("close", (event) => {
    const reason = event?.reason ? `: ${detail(event.reason)}` : "";
    closeWithError(new Error(`DevTools socket closed${reason}`));
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch (error) {
      closeWithError(new Error(`invalid DevTools message: ${detail(error)}`));
      try {
        socket.close();
      } catch {
        // The transport is already marked failed.
      }
      return;
    }
    if (!Number.isInteger(message?.id)) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(
        new Error(message.error.message ?? "DevTools command failed"),
      );
    } else {
      waiter.resolve(message.result);
    }
  });

  openTimer = setTimeout(() => {
    const error = new Error(
      `DevTools socket did not open within ${openTimeoutMs}ms`,
    );
    closeWithError(error);
    try {
      socket.close();
    } catch {
      // The open deadline already rejected the connection.
    }
  }, openTimeoutMs);

  const send = (method, params = {}, options = {}) => {
    if (closed || socket.readyState !== WebSocketImpl.OPEN) {
      return Promise.reject(new Error("DevTools socket is closed or not open"));
    }
    const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(
        new Error("DevTools command timeout must be positive"),
      );
    }
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error(
          `DevTools command ${method} timed out after ${timeoutMs}ms`,
        );
        error.code = "ETIMEDOUT";
        reject(error);
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(
          new Error(
            `DevTools command ${method} could not be sent: ${detail(error)}`,
          ),
        );
      }
    });
  };

  const evaluate = async (expression, options) => {
    const response = await send(
      "Runtime.evaluate",
      {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
      },
      options,
    );
    if (response?.exceptionDetails) {
      throw new Error(
        `page script threw: ${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}`,
      );
    }
    return response?.result?.value;
  };

  return {
    opened,
    send,
    evaluate,
    close() {
      closeWithError(new Error("DevTools socket closed by harness"));
      try {
        socket.close();
      } catch {
        // Closing is best effort after all pending waiters have been rejected.
      }
    },
    get pendingCount() {
      return pending.size;
    },
  };
}
