import { describe, expect, it } from "vitest";
import {
  SUPPORT_REPORT_MAX_ENTRIES,
  createSupportReport,
} from "../diagnostics/support-report.ts";
import type { DiagnosticsSnapshot } from "../diagnostics/types.ts";

function snapshot(
  overrides: Partial<DiagnosticsSnapshot> = {},
): DiagnosticsSnapshot {
  return {
    entries: [],
    failures: [],
    environment: {
      version: "0.1.0",
      tauriVersion: "2.11.0",
      os: "windows",
      arch: "x86_64",
      webviewVersion: "154.0.4258.48",
      windowsBuild: "25H2 build 26200.9457",
      debug: false,
    },
    observedHosts: [],
    sessionStartedAt: new Date("2026-10-03T00:00:00Z"),
    tracksPlayed: 3,
    playbackKind: "full",
    playbackStatus: "paused",
    ...overrides,
  };
}

// Failure modes: release users have no way to hand over evidence; the
// report omits the environment needed to reproduce; it carries tokens; it
// grows without bound; it breaks before native diagnostics arrive.
describe("support report", () => {
  it("includes the environment, playback facts, and recent entries", () => {
    const report = createSupportReport(
      snapshot({
        entries: [
          {
            id: 1,
            timestamp: "2026-10-03T00:00:01Z",
            level: "error",
            message: "Play failed: CONTENT_UNAVAILABLE",
            source: "app",
          },
        ],
        failures: ["Play failed: CONTENT_UNAVAILABLE"],
      }),
      new Date("2026-10-03T01:00:00Z"),
    );
    expect(report).toContain("Arlet 0.1.0");
    expect(report).toContain("WebView2 154.0.4258.48");
    expect(report).toContain("25H2 build 26200.9457");
    expect(report).toContain("Tracks played: 3");
    expect(report).toContain("Play failed: CONTENT_UNAVAILABLE");
  });

  it("redacts tokens again and keeps only the newest entries", () => {
    const entries = Array.from(
      { length: SUPPORT_REPORT_MAX_ENTRIES + 50 },
      (_, index) => ({
        id: index,
        timestamp: `t${index}`,
        level: "info" as const,
        message:
          index === SUPPORT_REPORT_MAX_ENTRIES + 49
            ? "Music-User-Token: AqmL0f7xY2Zp9wR3kT8vN1bC4dE6gH"
            : `line ${index}`,
      }),
    );
    const report = createSupportReport(snapshot({ entries }));
    expect(report).not.toContain("AqmL0f7xY2Zp9wR3kT8vN1bC4dE6gH");
    expect(report).not.toContain("line 0\n");
    expect(report).toContain(`line ${SUPPORT_REPORT_MAX_ENTRIES + 48}`);
    expect(report.split("\n").filter((l) => l.startsWith("[t"))).toHaveLength(
      SUPPORT_REPORT_MAX_ENTRIES,
    );
  });

  it("works before native diagnostics are available", () => {
    const report = createSupportReport(snapshot({ environment: null }));
    expect(report).toContain("Environment: unavailable");
  });
});
