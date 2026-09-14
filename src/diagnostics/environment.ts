import type { GateEnvironment } from "../phase0/gate-session.ts";
import {
  createTauriEnvironmentAdapter,
  type NativeDiagnosticsInfo,
} from "./native.ts";

export interface EnvironmentCaptureResult {
  environment: GateEnvironment;
  error?: string;
}

export function fallbackDiagnosticsEnvironment(debug = true): GateEnvironment {
  return {
    version: "unknown",
    tauriVersion: "unknown",
    os: "unknown",
    arch: "unknown",
    webviewVersion: null,
    windowsBuild: null,
    debug,
    nodeVersion:
      typeof __BUILD_NODE_VERSION__ === "string"
        ? __BUILD_NODE_VERSION__
        : undefined,
    npmVersion:
      typeof __BUILD_NPM_VERSION__ === "string"
        ? __BUILD_NPM_VERSION__
        : undefined,
    rustToolchain: "stable",
    rustcVersion: null,
  };
}

export function mapNativeDiagnostics(
  info: NativeDiagnosticsInfo,
): GateEnvironment {
  return {
    version: info.version,
    tauriVersion: info.tauri_version,
    os: info.os,
    arch: info.arch,
    webviewVersion: info.webview_version,
    windowsBuild: info.windows_build,
    debug: info.debug,
    nodeVersion:
      typeof __BUILD_NODE_VERSION__ === "string"
        ? __BUILD_NODE_VERSION__
        : undefined,
    npmVersion:
      typeof __BUILD_NPM_VERSION__ === "string"
        ? __BUILD_NPM_VERSION__
        : undefined,
    rustToolchain: "stable",
    rustcVersion: info.rustc_version,
  };
}

export async function captureDiagnosticsEnvironment(
  call: () => Promise<NativeDiagnosticsInfo> = createTauriEnvironmentAdapter(),
): Promise<EnvironmentCaptureResult> {
  try {
    const info = await call();
    return { environment: mapNativeDiagnostics(info) };
  } catch (error) {
    return {
      environment: fallbackDiagnosticsEnvironment(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
