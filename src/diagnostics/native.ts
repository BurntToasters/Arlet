import { invoke } from "@tauri-apps/api/core";
import { createSerialQueue } from "../platform/serial.ts";
import type { DiagnosticsPersistenceAdapter } from "./store.ts";

export type DiagnosticsInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/**
 * Thin command adapter kept separate from the store so tests and browser
 * development can provide a no-op adapter without importing Tauri globals.
 */
export function createTauriDiagnosticsAdapter(
  call: DiagnosticsInvoke = invoke,
): DiagnosticsPersistenceAdapter {
  // Log writes run off the UI thread; the queue keeps lines in order.
  const writes = createSerialQueue();
  return {
    appendLocalLog: (entry) =>
      writes(() => call<void>("append_local_log", { entry })),
    clearLogs: () => writes(() => call<void>("clear_logs")),
    getLogDir: () => call<string>("get_log_dir"),
  };
}

export interface NativeDiagnosticsInfo {
  version: string;
  tauri_version: string;
  os: string;
  arch: string;
  webview_version: string | null;
  rustc_version: string | null;
  windows_build: string | null;
  debug: boolean;
}

export function createTauriEnvironmentAdapter(
  call: DiagnosticsInvoke = invoke,
): () => Promise<NativeDiagnosticsInfo> {
  return () => call<NativeDiagnosticsInfo>("get_app_info");
}

export function createMusicDiagnosticAdapter(
  call: DiagnosticsInvoke = invoke,
): () => Promise<string> {
  return () => call<string>("open_music_diagnostic");
}
