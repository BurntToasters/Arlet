import { invoke } from "@tauri-apps/api/core";
import { registerLifecycleDiagnostics } from "./phase0/lifecycle.ts";
import { startNetworkObserver } from "./phase0/gate-session.ts";
import { createAppController, type AppController } from "./app/controller.ts";
import {
  fallbackDiagnosticsEnvironment,
  mapNativeDiagnostics,
} from "./diagnostics/environment.ts";
import {
  registerDiagnosticsLifecycle,
  registerDiagnosticsNetwork,
} from "./diagnostics/index.ts";
import type { DiagnosticsStore } from "./diagnostics/store.ts";

interface NativeDiagnostics {
  version: string;
  tauri_version: string;
  os: string;
  arch: string;
  webview_version: string | null;
  rustc_version: string | null;
  windows_build: string | null;
  debug: boolean;
}

let diagnosticsStarted = false;
let stopLifecycleDiagnostics: (() => void) | undefined;
let stopNetworkDiagnostics: (() => void) | undefined;

async function logNativeDiagnostics(controller: AppController): Promise<void> {
  try {
    const info = await invoke<NativeDiagnostics>("get_app_info");
    controller.setDiagnosticsEnvironment?.(mapNativeDiagnostics(info));
    controller.log(
      `App ${info.version} / Tauri ${info.tauri_version} / ${info.os}-${info.arch} / ` +
        `WebView2 ${info.webview_version ?? "unknown"} / Windows ${info.windows_build ?? "unknown"} / ` +
        `${info.debug ? "debug" : "release"}`,
    );
  } catch {
    controller.setDiagnosticsEnvironment?.(fallbackDiagnosticsEnvironment());
    controller.log(
      "Running outside the Tauri shell; native diagnostics unavailable.",
    );
  }
}

/** Mounting is deliberately separate from this async startup path. */
export async function initializeApplication(
  controller = createAppController(),
  diagnosticsStore?: DiagnosticsStore,
): Promise<AppController> {
  if (!diagnosticsStarted) {
    diagnosticsStarted = true;
    if (diagnosticsStore) {
      stopNetworkDiagnostics = registerDiagnosticsNetwork(diagnosticsStore);
      stopLifecycleDiagnostics = registerDiagnosticsLifecycle(diagnosticsStore);
    } else {
      stopNetworkDiagnostics = startNetworkObserver();
      stopLifecycleDiagnostics = registerLifecycleDiagnostics(controller.log);
    }
  }

  await logNativeDiagnostics(controller);
  try {
    await controller.loadSettings();
  } catch (error) {
    controller.log(
      `Settings initialization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await controller.initialize();
  controller.log("Arlet shell ready. Sign in to begin listening.");
  controller.log(
    "Developer diagnostics: Ctrl+Shift+D (development builds only).",
  );
  // Updates are deliberately kicked off only after both persisted settings and
  // MusicKit are ready. The updater service no-ops in development builds and
  // coalesces this startup check with a user-triggered Settings check.
  if (!import.meta.env.DEV) {
    void controller.startupUpdateCheck().catch((error: unknown) => {
      controller.log(
        `Startup update check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  return controller;
}

export function disposeApplication(): void {
  stopLifecycleDiagnostics?.();
  stopLifecycleDiagnostics = undefined;
  stopNetworkDiagnostics?.();
  stopNetworkDiagnostics = undefined;
  diagnosticsStarted = false;
}
