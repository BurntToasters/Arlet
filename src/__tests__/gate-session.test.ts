import { describe, it, expect, vi } from "vitest";
import {
  GATE_CHECKLIST,
  formatFeasibilityReport,
  formatNetworkSurfaceMarkdown,
  formatSessionDuration,
  categorizeObservedHost,
  getObservedHosts,
  startNetworkObserver,
} from "../phase0/gate-session.ts";
import type { AppState } from "../state.ts";

const baseState: AppState = {
  auth: { status: "authorized", musicUserToken: "user-token" },
  playback: {
    status: "playing",
    current: { id: "1", title: "Track", artistName: "Artist" },
    positionSeconds: 12,
    durationSeconds: 240,
    volume: 0.5,
    queue: [],
    queueIndex: 0,
  },
  tracksPlayed: 3,
};

describe("gate-session", () => {
  it("formats session duration", () => {
    const started = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date("2026-01-01T02:05:07.000Z");
    expect(formatSessionDuration(started, now)).toBe("2h 5m 7s");
  });

  it("builds feasibility report with checklist and environment", () => {
    const checklist = Object.fromEntries(
      GATE_CHECKLIST.map((item) => [item.id, item.id.startsWith("auth-")]),
    );
    const report = formatFeasibilityReport({
      environment: {
        version: "0.1.0",
        tauriVersion: "2.11.0",
        os: "windows",
        arch: "x86_64",
        webviewVersion: "152.0.0.0",
        debug: true,
        nodeVersion: "v24.0.0",
        rustToolchain: "rustc 1.88.0",
      },
      appState: baseState,
      sessionStartedAt: new Date("2026-09-11T00:00:00.000Z"),
      diagLog: "[2026-09-11] MusicKit initialized successfully.",
      checklist,
      observedHosts: ["api.music.apple.com", "js-cdn.music.apple.com"],
      failures: ["Play failed: DRM error"],
    });

    expect(report).toContain("# MusicKit + Tauri v2 Feasibility Report");
    expect(report).toContain("WebView2 Version      | 152.0.0.0");
    expect(report).toContain("- [x] MusicKit initializes without errors");
    expect(report).toContain("- [ ] Full protected track plays");
    expect(report).toContain("api.music.apple.com");
    expect(report).toContain("Play failed: DRM error");
    expect(report).toContain("Tracks played: 3");
  });

  it("categorizes observed hosts for network surface export", () => {
    expect(categorizeObservedHost("js-cdn.music.apple.com")).toBe("script");
    expect(categorizeObservedHost("authorize.music.apple.com")).toBe("auth");
    expect(categorizeObservedHost("api.music.apple.com")).toBe("api");
    expect(categorizeObservedHost("is1-ssl.mzstatic.com")).toBe("media");
  });

  it("records fetch hosts for the network-surface export", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    window.fetch = fetchMock as unknown as typeof fetch;
    const stop = startNetworkObserver();
    await window.fetch("https://api.music.apple.com/v1/catalog/us/songs");
    expect(getObservedHosts()).toContain("api.music.apple.com");
    stop();
  });

  it("builds network surface markdown from hosts", () => {
    const markdown = formatNetworkSurfaceMarkdown([
      "js-cdn.music.apple.com",
      "api.music.apple.com",
      "authorize.music.apple.com",
      "is1-ssl.mzstatic.com",
    ]);

    expect(markdown).toContain("# MusicKit Network Surface");
    expect(markdown).toContain("`js-cdn.music.apple.com`");
    expect(markdown).toContain("`authorize.music.apple.com`");
    expect(markdown).toContain("`is1-ssl.mzstatic.com`");
  });
});
