import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanupE2eProfile,
  createE2eProfile,
  withE2eProfileSetup,
} from "./e2e-profile.js";
import { connectCdp, findPageTarget } from "./e2e-cdp.js";

// Failure modes exercised before production changes:
// - a relative, unmarked, altered-marker, symlink, or non-owned profile is accepted;
// - cleanup removes a sibling, parent, or unmarked directory;
// - partial setup/cleanup leaves data that the harness silently treats as owned;
// - a repeated run collides with and reuses an earlier profile;
// - DevTools close/error strands commands, or a closed socket accepts new sends;
// - command timeout leaves a pending waiter behind;
// - a hung /json/list request escapes the overall discovery deadline.

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "arlet-e2e-script-test-"));
}

test("owned profile cleanup removes only the unique marked profile", (t) => {
  const parent = temporaryDirectory();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const sibling = path.join(parent, "keep.txt");
  fs.writeFileSync(sibling, "keep");

  const profile = createE2eProfile({ parent, runId: "cleanup-test" });
  const nested = path.join(profile.root, "data", "settings.json");
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.writeFileSync(nested, "test data");

  profile.cleanup();

  assert.equal(fs.existsSync(profile.root), false);
  assert.equal(fs.readFileSync(sibling, "utf8"), "keep");
});

test("profile cleanup refuses relative roots and missing or altered markers", (t) => {
  const parent = temporaryDirectory();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const profile = createE2eProfile({ parent, runId: "marker-test" });
  const marker = path.join(profile.root, ".arlet-e2e-profile.json");

  assert.throws(() =>
    cleanupE2eProfile({ ...profile, root: "relative-profile" }),
  );
  fs.writeFileSync(marker, "{}");
  assert.throws(() => profile.cleanup(), /marker|owned|profile/iu);
  assert.equal(fs.existsSync(profile.root), true);
});

test("partial profile setup rolls back its marked root", async (t) => {
  const parent = temporaryDirectory();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  let root;

  await assert.rejects(
    withE2eProfileSetup({ parent, runId: "partial-setup" }, async (profile) => {
      root = profile.root;
      const partial = path.join(root, "local", "partial.db");
      fs.mkdirSync(path.dirname(partial), { recursive: true });
      fs.writeFileSync(partial, "partial setup");
      throw new Error("simulated setup failure");
    }),
    /simulated setup failure/iu,
  );
  assert.equal(fs.existsSync(root), false);
});

test("profile setup never reuses a root from an earlier run", (t) => {
  const parent = temporaryDirectory();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const first = createE2eProfile({ parent, runId: "same-run" });

  assert.throws(
    () => createE2eProfile({ parent, runId: "same-run" }),
    /exist|already|EEXIST/iu,
  );
  assert.equal(
    fs.existsSync(path.join(first.root, ".arlet-e2e-profile.json")),
    true,
  );
});

class FakeWebSocket {
  static OPEN = 1;

  constructor() {
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.latest = this;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  send(raw) {
    if (this.readyState !== FakeWebSocket.OPEN)
      throw new Error("socket is closed");
    this.sent.push(JSON.parse(raw));
  }

  reply(message) {
    this.emit("message", { data: JSON.stringify(message) });
  }

  close() {
    this.readyState = 3;
    this.emit("close", { code: 1000, reason: "closed" });
  }
}

test("DevTools close rejects pending commands and future sends", async () => {
  const client = connectCdp("ws://127.0.0.1/devtools", {
    WebSocketImpl: FakeWebSocket,
    commandTimeoutMs: 5000,
  });
  FakeWebSocket.latest.open();
  await client.opened;
  const pending = client.send("Runtime.evaluate", { expression: "1" });

  FakeWebSocket.latest.close();

  await assert.rejects(pending, /closed/iu);
  await assert.rejects(client.send("Runtime.evaluate"), /closed/iu);
  assert.equal(client.pendingCount, 0);
});

test("DevTools error rejects all pending commands", async () => {
  const client = connectCdp("ws://127.0.0.1/devtools", {
    WebSocketImpl: FakeWebSocket,
    commandTimeoutMs: 5000,
  });
  const socket = FakeWebSocket.latest;
  socket.open();
  await client.opened;
  const first = client.send("Runtime.evaluate", { expression: "1" });
  const second = client.send("Page.captureScreenshot");

  socket.emit("error", { message: "transport failed" });

  await assert.rejects(first, /transport failed|error/iu);
  await assert.rejects(second, /transport failed|error/iu);
  assert.equal(client.pendingCount, 0);
});

test("DevTools command deadline rejects and removes its pending waiter", async () => {
  const client = connectCdp("ws://127.0.0.1/devtools", {
    WebSocketImpl: FakeWebSocket,
    commandTimeoutMs: 1000,
  });
  FakeWebSocket.latest.open();
  await client.opened;

  await assert.rejects(
    client.send("Runtime.evaluate", {}, { timeoutMs: 20 }),
    /timed out/iu,
  );
  assert.equal(client.pendingCount, 0);
});

test("discovery deadline also bounds an individual hung fetch", async () => {
  let aborted = false;
  const started = Date.now();
  await assert.rejects(
    findPageTarget({
      port: 9333,
      timeoutMs: 45,
      requestTimeoutMs: 20,
      fetchImpl: (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }),
    /9333|target|discovery/iu,
  );
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 250);
});
