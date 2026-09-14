import { redactSensitive } from "../platform/redact.ts";
import type { GateEnvironment } from "../phase0/gate-session.ts";

/** Redaction shared by store, reports, and the prop-driven drawer. */
export function sanitizeDiagnosticsText(value: string): string {
  return redactSensitive(value)
    .replace(/[\r\n]+/g, "\\n")
    .trim();
}

export function sanitizeDiagnosticsEnvironment(
  environment: GateEnvironment | null | undefined,
): GateEnvironment | null {
  if (!environment) return null;
  return {
    ...environment,
    version: sanitizeDiagnosticsText(environment.version),
    tauriVersion: sanitizeDiagnosticsText(environment.tauriVersion),
    os: sanitizeDiagnosticsText(environment.os),
    arch: sanitizeDiagnosticsText(environment.arch),
    webviewVersion: environment.webviewVersion
      ? sanitizeDiagnosticsText(environment.webviewVersion)
      : null,
    windowsBuild: environment.windowsBuild
      ? sanitizeDiagnosticsText(environment.windowsBuild)
      : null,
    ...(environment.nodeVersion
      ? { nodeVersion: sanitizeDiagnosticsText(environment.nodeVersion) }
      : {}),
    ...(environment.npmVersion
      ? { npmVersion: sanitizeDiagnosticsText(environment.npmVersion) }
      : {}),
    ...(environment.rustToolchain
      ? { rustToolchain: sanitizeDiagnosticsText(environment.rustToolchain) }
      : {}),
    ...(environment.rustcVersion
      ? { rustcVersion: sanitizeDiagnosticsText(environment.rustcVersion) }
      : {}),
  };
}

export function sanitizeDiagnosticsList(values: readonly string[]): string[] {
  return values.map(sanitizeDiagnosticsText).filter(Boolean);
}

export function sanitizeDiagnosticsHosts(hosts: readonly string[]): string[] {
  return [...new Set(sanitizeDiagnosticsList(hosts))].sort((a, b) =>
    a.localeCompare(b),
  );
}
