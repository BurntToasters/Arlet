import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { DiagnosticsStore } from "../diagnostics/store.ts";
import { createSupportReport } from "../diagnostics/support-report.ts";
import type { GateEnvironment } from "../phase0/gate-session.ts";
import { classifyPlaybackKind } from "../musickit/preview.ts";
import { isSameTrack, type Track } from "../domain/music.ts";
import { redactSensitive } from "../platform/redact.ts";
import { appendDiagnosticLog, getState } from "../state.ts";
import type { InvokeFunction } from "./settings.ts";
import {
  errorMessage,
  safeErrorMessage,
  timestamp,
} from "./controller-support.ts";

/** A clipboard write still pending after this falls through to the next path. */
const CLIPBOARD_PLUGIN_TIMEOUT_MS = 2_000;
const CLIPBOARD_BROWSER_TIMEOUT_MS = 2_000;

/** Rejects with `message` if `pending` has not settled after `ms`. */
async function withClipboardTimeout(
  pending: Promise<void>,
  ms: number,
  message: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Writes to the clipboard: the Tauri plugin first, then the browser clipboard,
 * each with its own timeout, because another app holding the clipboard can
 * leave a write pending. Only when both fail does it throw `busyMessage`.
 * Logs which path succeeded or failed.
 */
async function writeClipboardWithFallback(
  pluginWrite: (text: string) => Promise<void>,
  text: string,
  busyMessage: string,
  log: (message: string) => void,
): Promise<void> {
  try {
    await withClipboardTimeout(
      pluginWrite(text),
      CLIPBOARD_PLUGIN_TIMEOUT_MS,
      "Clipboard plugin timed out.",
    );
    log("Clipboard write succeeded via the Tauri clipboard plugin.");
    return;
  } catch (error) {
    log(
      `Clipboard plugin write failed: ${safeErrorMessage(error)}. Trying the browser clipboard.`,
    );
  }
  try {
    await withClipboardTimeout(
      navigator.clipboard.writeText(text),
      CLIPBOARD_BROWSER_TIMEOUT_MS,
      "Browser clipboard timed out.",
    );
    log("Clipboard write succeeded via navigator.clipboard.");
    return;
  } catch (error) {
    log(`Browser clipboard write failed: ${safeErrorMessage(error)}.`);
  }
  throw new Error(busyMessage);
}

/** Diagnostics log, playback metadata sync, and the copy and diagnostic-window actions. */
export function createControllerDiagnostics(deps: {
  now: () => number;
  diagnosticsStore?: DiagnosticsStore;
  invokeFn: InvokeFunction;
  writeClipboardText?: (text: string) => Promise<void>;
  lastSearchTracks: () => Track[];
}) {
  const { now, diagnosticsStore, invokeFn, lastSearchTracks } = deps;
  const writeClipboardTextFn = deps.writeClipboardText ?? writeText;
  const log = (message: string): void => {
    const line = redactSensitive(`[${timestamp(now)}] ${message}`);
    const failure = /failed|error|denied|unavailable|blocked|drm/i.test(
      message,
    );
    appendDiagnosticLog(line, failure);
    diagnosticsStore?.log(message, {
      level: failure ? "error" : "info",
      source: "app",
    });
    // Keep development diagnostics useful when the drawer is not mounted.
    if (import.meta.env.DEV) console.info(line);
  };

  const syncPlaybackDiagnostics = (): void => {
    if (!diagnosticsStore) return;
    const snapshot = getState();
    const current = snapshot.playback.current;
    const catalogTrack =
      snapshot.playback.queue.find((track) => isSameTrack(track, current)) ??
      lastSearchTracks().find((track) => isSameTrack(track, current)) ??
      current;
    diagnosticsStore.setMetadata({
      tracksPlayed: snapshot.tracksPlayed,
      playbackStatus: snapshot.playback.status,
      playbackKind: classifyPlaybackKind({
        catalogDurationSeconds:
          catalogTrack?.durationMs !== undefined
            ? catalogTrack.durationMs / 1000
            : undefined,
        playbackDurationSeconds: snapshot.playback.durationSeconds,
      }),
    });
  };

  return {
    log,
    syncPlaybackDiagnostics,
    async openMusicDiagnostic(): Promise<string> {
      try {
        const result = await invokeFn<string>("open_music_diagnostic");
        log(`Diagnostic window ${result}.`);
        return result;
      } catch (error) {
        log(`Diagnostic window failed: ${errorMessage(error)}`);
        throw error;
      }
    },

    setDiagnosticsEnvironment(environment: GateEnvironment): void {
      diagnosticsStore?.setMetadata({ environment });
    },

    async copyDiagnosticsReport(): Promise<void> {
      if (!diagnosticsStore) {
        throw new Error("Diagnostics are unavailable in this session.");
      }
      await writeClipboardWithFallback(
        writeClipboardTextFn,
        createSupportReport(diagnosticsStore.getSnapshot()),
        "Couldn't copy the report: the clipboard is busy. Try again.",
        log,
      );
      log("Diagnostics report copied to the clipboard.");
    },

    async copyText(text: string): Promise<void> {
      await writeClipboardWithFallback(
        writeClipboardTextFn,
        text,
        "Couldn't copy: the clipboard is busy. Try again.",
        log,
      );
    },
  };
}
