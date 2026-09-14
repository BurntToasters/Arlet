import {
  formatFeasibilityReport,
  formatNetworkSurfaceMarkdown,
  getSessionStartedAt,
  loadChecklistState,
  type GateEnvironment,
} from "../phase0/gate-session.ts";
import { fallbackDiagnosticsEnvironment } from "./environment.ts";
import {
  sanitizeDiagnosticsEnvironment,
  sanitizeDiagnosticsHosts,
  sanitizeDiagnosticsList,
} from "./sanitize.ts";
import { formatDiagnosticEntries } from "./store.ts";
import type { DiagnosticsAppSnapshot, DiagnosticsSnapshot } from "./types.ts";

export interface DiagnosticsReportData {
  readonly appSnapshot?: DiagnosticsAppSnapshot;
  readonly storeSnapshot?: DiagnosticsSnapshot;
  readonly checklist?: Readonly<Record<string, boolean>>;
}

function chooseEnvironment(
  appSnapshot: DiagnosticsAppSnapshot | undefined,
  storeSnapshot: DiagnosticsSnapshot | undefined,
): GateEnvironment {
  return (
    sanitizeDiagnosticsEnvironment(
      appSnapshot?.environment ?? storeSnapshot?.environment,
    ) ?? fallbackDiagnosticsEnvironment()
  );
}

function chooseSessionStart(
  appSnapshot: DiagnosticsAppSnapshot | undefined,
  storeSnapshot: DiagnosticsSnapshot | undefined,
): Date {
  return (
    appSnapshot?.sessionStartedAt ??
    storeSnapshot?.sessionStartedAt ??
    getSessionStartedAt()
  );
}

function chooseChecklist(data: DiagnosticsReportData): Record<string, boolean> {
  return {
    ...loadChecklistState(),
    ...(data.appSnapshot?.checklist ?? {}),
    ...(data.checklist ?? {}),
  };
}

function chooseTracksPlayed(
  appSnapshot: DiagnosticsAppSnapshot | undefined,
  storeSnapshot: DiagnosticsSnapshot | undefined,
): number {
  return appSnapshot?.tracksPlayed ?? storeSnapshot?.tracksPlayed ?? 0;
}

function chooseHosts(
  appSnapshot: DiagnosticsAppSnapshot | undefined,
  storeSnapshot: DiagnosticsSnapshot | undefined,
): readonly string[] {
  return sanitizeDiagnosticsHosts(
    appSnapshot?.observedHosts ?? storeSnapshot?.observedHosts ?? [],
  );
}

function chooseFailures(
  appSnapshot: DiagnosticsAppSnapshot | undefined,
  storeSnapshot: DiagnosticsSnapshot | undefined,
): readonly string[] {
  return sanitizeDiagnosticsList(
    appSnapshot?.failures ?? storeSnapshot?.failures ?? [],
  );
}

export function createFeasibilityReport(data: DiagnosticsReportData): string {
  const { appSnapshot, storeSnapshot } = data;
  const entries = storeSnapshot?.entries ?? [];
  return formatFeasibilityReport({
    environment: chooseEnvironment(appSnapshot, storeSnapshot),
    // Gate reports need only this aggregate. Keeping the input narrow makes
    // it impossible for a Music User Token to enter through this path.
    appState: { tracksPlayed: chooseTracksPlayed(appSnapshot, storeSnapshot) },
    sessionStartedAt: chooseSessionStart(appSnapshot, storeSnapshot),
    diagLog: formatDiagnosticEntries(entries),
    checklist: chooseChecklist(data),
    observedHosts: chooseHosts(appSnapshot, storeSnapshot),
    failures: chooseFailures(appSnapshot, storeSnapshot),
  });
}

export function createNetworkReport(data: DiagnosticsReportData): string {
  const { appSnapshot, storeSnapshot } = data;
  return formatNetworkSurfaceMarkdown(chooseHosts(appSnapshot, storeSnapshot));
}

export function createConsoleReport(
  snapshot: DiagnosticsSnapshot | undefined,
): string {
  return formatDiagnosticEntries(snapshot?.entries ?? []);
}
