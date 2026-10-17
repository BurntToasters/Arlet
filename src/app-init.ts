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
import { safeErrorMessage } from "./app/controller-support.ts";

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

/** Long sessions re-check so a music app left open for days still updates. */
export const UPDATE_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Uncaught errors logged per session; one that repeats every frame stops here. */
export const MAX_UNCAUGHT_ERRORS_LOGGED = 20;

let diagnosticsStarted = false;
let stopUncaughtErrorLogging: (() => void) | undefined;
let stopPeriodicUpdateChecks: (() => void) | undefined;
let stopLifecycleDiagnostics: (() => void) | undefined;
let stopNetworkDiagnostics: (() => void) | undefined;

export interface InitializeApplicationOptions {
  /** Override the Vite mode only for deterministic startup integration tests. */
  isDevelopment?: boolean;
}

async function logNativeDiagnostics(controller: AppController): Promise<void> {
  try {
    const info = await invoke<NativeDiagnostics>("get_app_info");
    controller.setDiagnosticsEnvironment(mapNativeDiagnostics(info));
    controller.log(
      `App ${info.version} / Tauri ${info.tauri_version} / ${info.os}-${info.arch} / ` +
        `WebView2 ${info.webview_version ?? "unknown"} / Windows ${info.windows_build ?? "unknown"} / ` +
        `${info.debug ? "debug" : "release"}`,
    );
  } catch {
    controller.setDiagnosticsEnvironment(fallbackDiagnosticsEnvironment());
    controller.log(
      "Running outside the Tauri shell; native diagnostics unavailable.",
    );
  }
}

/**
 * Release builds have no open console, so uncaught errors and unhandled
 * rejections go to the app log, where support reports can see them.
 */
function logUncaughtErrors(log: (message: string) => void): () => void {
  let logged = 0;
  const report = (kind: string, reason: unknown): void => {
    const message = safeErrorMessage(reason);
    // Chromium reports this when a ResizeObserver callback resizes what it
    // observes; it is harmless and frequent.
    if (message.includes("ResizeObserver loop")) return;
    logged += 1;
    if (logged > MAX_UNCAUGHT_ERRORS_LOGGED) return;
    log(`${kind}: ${message}`);
    if (logged === MAX_UNCAUGHT_ERRORS_LOGGED) {
      log("Further uncaught errors in this session are not logged.");
    }
  };
  const onError = (event: ErrorEvent): void => {
    report("Uncaught error", event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    report("Unhandled promise rejection", event.reason);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

/** Mounting is deliberately separate from this async startup path. */
export async function initializeApplication(
  controller = createAppController(),
  diagnosticsStore?: DiagnosticsStore,
  options: InitializeApplicationOptions = {},
): Promise<AppController> {
  if (!diagnosticsStarted) {
    diagnosticsStarted = true;
    stopUncaughtErrorLogging = logUncaughtErrors(controller.log);
    if (diagnosticsStore) {
      stopNetworkDiagnostics = registerDiagnosticsNetwork(diagnosticsStore);
      stopLifecycleDiagnostics = registerDiagnosticsLifecycle(diagnosticsStore);
    } else {
      stopNetworkDiagnostics = startNetworkObserver();
      stopLifecycleDiagnostics = registerLifecycleDiagnostics(controller.log);
    }
  }

  // Native diagnostics are informational; they must not delay settings or
  // MusicKit startup.
  const diagnosticsSettled = logNativeDiagnostics(controller);
  const settingsSettled = controller.loadSettings().catch((error: unknown) => {
    controller.log(
      `Settings initialization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  await Promise.all([
    diagnosticsSettled,
    settingsSettled,
    controller.initialize(),
  ]);
  controller.log("Arlet shell ready. Sign in to begin listening.");
  controller.log(
    "Developer diagnostics: Ctrl+Shift+D (development builds only).",
  );
  // Updates are deliberately kicked off only after both persisted settings and
  // MusicKit are ready. The updater service no-ops in development builds and
  // coalesces this startup check with a user-triggered Settings check.
  if (!(options.isDevelopment ?? import.meta.env.DEV)) {
    const runUpdateCheck = (): void => {
      void controller.startupUpdateCheck().catch((error: unknown) => {
        controller.log(
          `Startup update check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    };
    runUpdateCheck();
    // Same silent path as startup: honours the auto-check setting, reuses a
    // downloaded update, and opens the dialog only once an installer is ready.
    stopPeriodicUpdateChecks?.();
    const timer = setInterval(runUpdateCheck, UPDATE_RECHECK_INTERVAL_MS);
    stopPeriodicUpdateChecks = () => clearInterval(timer);
  }
  return controller;
}

export function disposeApplication(): void {
  stopUncaughtErrorLogging?.();
  stopUncaughtErrorLogging = undefined;
  stopPeriodicUpdateChecks?.();
  stopPeriodicUpdateChecks = undefined;
  stopLifecycleDiagnostics?.();
  stopLifecycleDiagnostics = undefined;
  stopNetworkDiagnostics?.();
  stopNetworkDiagnostics = undefined;
  diagnosticsStarted = false;
}
