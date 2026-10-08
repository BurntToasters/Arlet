import { redactSensitive } from "../platform/redact.ts";
import { formatPersistedEntry } from "./store.ts";
import type { DiagnosticsSnapshot } from "./types.ts";

export const SUPPORT_REPORT_MAX_ENTRIES = 200;

/**
 * Plain-text report a release user can paste into a bug report. Entries are
 * already redacted by the store; they are redacted again here because this
 * text leaves the machine.
 */
export function createSupportReport(
  snapshot: DiagnosticsSnapshot,
  now: Date = new Date(),
): string {
  const env = snapshot.environment;
  const environment = env
    ? [
        `Arlet ${env.version} (${env.debug ? "debug" : "release"})`,
        `Tauri ${env.tauriVersion} / ${env.os}-${env.arch}`,
        `WebView2 ${env.webviewVersion ?? "unknown"}`,
        `Windows ${env.windowsBuild ?? "unknown"}`,
      ]
    : ["Environment: unavailable"];
  const entries = snapshot.entries
    .slice(-SUPPORT_REPORT_MAX_ENTRIES)
    .map((entry) => redactSensitive(formatPersistedEntry(entry)));
  const failures = snapshot.failures
    .slice(-20)
    .map((failure) => `- ${redactSensitive(failure)}`);
  return [
    "# Arlet diagnostics report",
    `Generated: ${now.toISOString()}`,
    "",
    ...environment,
    "",
    `Session started: ${snapshot.sessionStartedAt.toISOString()}`,
    `Playback: ${snapshot.playbackStatus} (${snapshot.playbackKind})`,
    `Tracks played: ${snapshot.tracksPlayed}`,
    "",
    "## Recent failures",
    ...(failures.length ? failures : ["(none)"]),
    "",
    `## Recent log (last ${entries.length})`,
    ...entries,
    "",
  ].join("\n");
}
