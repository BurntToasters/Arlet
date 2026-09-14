import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiagnosticsStore,
  formatDiagnosticEntries,
} from "../diagnostics/store.ts";

describe("DiagnosticsStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts before retaining and persisting entries", async () => {
    const appendLocalLog = vi.fn().mockResolvedValue(undefined);
    const store = new DiagnosticsStore({
      persistence: { appendLocalLog },
      now: () => new Date("2026-09-13T23:49:00.000Z"),
    });

    store.log("Authorization: Bearer eyJdeveloper.secret user=eyJuser.secret", {
      level: "error",
      source: "auth",
    });
    await Promise.resolve();

    const snapshot = store.getSnapshot();
    expect(snapshot.entries[0]?.message).not.toContain("eyJ");
    expect(snapshot.failures[0]).not.toContain("eyJ");
    expect(appendLocalLog).toHaveBeenCalledWith(
      expect.not.stringContaining("eyJ"),
    );
    expect(formatDiagnosticEntries(snapshot.entries)).not.toContain("eyJ");
  });

  it("redacts metadata and freezes the returned snapshot", () => {
    const store = new DiagnosticsStore({
      environment: {
        version: "0.1.0-eyJsecret",
        tauriVersion: "2.11.5",
        os: "windows",
        arch: "x86_64",
        webviewVersion: null,
        windowsBuild: null,
        debug: true,
      },
      observedHosts: ["api.music.apple.com/eyJsecret"],
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.environment?.version).not.toContain("eyJ");
    expect(snapshot.observedHosts[0]).not.toContain("eyJ");
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.observedHosts)).toBe(true);
  });

  it("keeps only the newest 1000 entries", () => {
    const store = new DiagnosticsStore({ maxEntries: 1000 });
    for (let index = 0; index < 1005; index += 1) {
      store.log(`line ${index}`);
    }

    const snapshot = store.getSnapshot();
    expect(snapshot.entries).toHaveLength(1000);
    expect(snapshot.entries[0]?.message).toBe("line 5");
    expect(snapshot.entries.at(-1)?.message).toBe("line 1004");
  });

  it("notifies subscribers and supports unsubscribe", () => {
    const store = new DiagnosticsStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.log("first");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.log("second");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("clears only session entries and failures", () => {
    const store = new DiagnosticsStore({ tracksPlayed: 4 });
    store.log("network error", { level: "error" });
    store.clearSession();

    const snapshot = store.getSnapshot();
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.failures).toEqual([]);
    expect(snapshot.tracksPlayed).toBe(4);
  });

  it("isolates synchronous and rejected persistence failures", async () => {
    const rejected = new DiagnosticsStore({
      persistence: {
        appendLocalLog: () => Promise.reject(new Error("disk full")),
        clearLogs: () => Promise.reject(new Error("locked")),
        getLogDir: () => Promise.reject(new Error("unavailable")),
      },
    });
    const synchronous = new DiagnosticsStore({
      persistence: {
        appendLocalLog: () => {
          throw new Error("ipc failed");
        },
        clearLogs: () => {
          throw new Error("locked");
        },
        getLogDir: () => {
          throw new Error("unavailable");
        },
      },
    });

    expect(() => rejected.log("ordinary entry")).not.toThrow();
    expect(() => synchronous.log("ordinary entry")).not.toThrow();
    await expect(rejected.clearLocalLogs()).resolves.toBe(false);
    await expect(synchronous.clearLocalLogs()).resolves.toBe(false);
    await expect(rejected.getLogDirectory()).resolves.toBeNull();
    await expect(synchronous.getLogDirectory()).resolves.toBeNull();
    expect(rejected.getSnapshot().entries).toHaveLength(1);
    expect(synchronous.getSnapshot().entries).toHaveLength(1);
  });

  it("captures error-shaped messages without retaining raw values", () => {
    const store = new DiagnosticsStore();
    store.log(new Error("DRM failed for eyJsecret"));
    store.log("normal status");

    expect(store.getSnapshot().failures).toHaveLength(1);
    expect(store.getSnapshot().failures[0]).toContain("DRM failed");
    expect(store.getSnapshot().failures[0]).not.toContain("eyJ");
  });
});
