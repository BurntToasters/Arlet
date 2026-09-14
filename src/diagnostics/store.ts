import { getSessionStartedAt } from "../phase0/gate-session.ts";
import type {
  DiagnosticEntry,
  DiagnosticLevel,
  DiagnosticsSnapshot,
} from "./types.ts";
import type { GateEnvironment } from "../phase0/gate-session.ts";
import type { PlaybackKind } from "../musickit/preview.ts";
import {
  sanitizeDiagnosticsEnvironment,
  sanitizeDiagnosticsHosts,
  sanitizeDiagnosticsText,
} from "./sanitize.ts";

export interface DiagnosticsPersistenceAdapter {
  /** Receives an already-redacted, timestamped line. */
  appendLocalLog?: (entry: string) => void | Promise<void>;
  clearLogs?: () => void | Promise<void>;
  getLogDir?: () => string | null | Promise<string | null>;
}

export interface DiagnosticsLogOptions {
  level?: DiagnosticLevel;
  source?: string;
  at?: Date;
}

export interface DiagnosticsStoreOptions {
  maxEntries?: number;
  persistence?: DiagnosticsPersistenceAdapter;
  now?: () => Date;
  sessionStartedAt?: Date;
  environment?: GateEnvironment | null;
  observedHosts?: readonly string[];
  tracksPlayed?: number;
  playbackKind?: PlaybackKind;
  playbackStatus?: string;
}

export type DiagnosticsListener = () => void;

const DEFAULT_MAX_ENTRIES = 1000;
const FAILURE_PATTERN =
  /failed|failure|error|drm|denied|unavailable|exception|stalled/i;

function safeSessionStart(): Date {
  try {
    return getSessionStartedAt();
  } catch {
    return new Date();
  }
}

function safeDate(value: Date | undefined, fallback: () => Date): Date {
  if (value && !Number.isNaN(value.getTime())) return new Date(value);
  const next = fallback();
  return Number.isNaN(next.getTime()) ? new Date(0) : new Date(next);
}

function formatUnknownMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message ? `${value.name}: ${value.message}` : value.name;
  }
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable diagnostic value]";
    }
  }
}

/**
 * Keep each entry on one physical line. This prevents a caller-provided
 * multiline error from confusing the local rolling log format.
 */
function boundedUniqueHosts(hosts: readonly string[]): string[] {
  return sanitizeDiagnosticsHosts(hosts);
}

function immutableSnapshot(snapshot: DiagnosticsSnapshot): DiagnosticsSnapshot {
  return Object.freeze({
    ...snapshot,
    entries: Object.freeze([...snapshot.entries]),
    failures: Object.freeze([...snapshot.failures]),
    observedHosts: Object.freeze([...snapshot.observedHosts]),
    environment: snapshot.environment
      ? Object.freeze({ ...snapshot.environment })
      : null,
    sessionStartedAt: new Date(snapshot.sessionStartedAt),
  });
}

function emptySnapshot(): DiagnosticsSnapshot {
  return {
    entries: [],
    failures: [],
    environment: null,
    observedHosts: [],
    sessionStartedAt: safeSessionStart(),
    tracksPlayed: 0,
    playbackKind: "unknown",
    playbackStatus: "idle",
  };
}

/**
 * Small external store for the debug drawer. It owns only redacted values;
 * MusicKit objects and authentication tokens stay in the application layer.
 */
export class DiagnosticsStore {
  private readonly maxEntries: number;
  private readonly persistence?: DiagnosticsPersistenceAdapter;
  private readonly now: () => Date;
  private readonly listeners = new Set<DiagnosticsListener>();
  private nextId = 1;
  private snapshot: DiagnosticsSnapshot;

  public constructor(options: DiagnosticsStoreOptions = {}) {
    const requestedMax = Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxEntries = Number.isFinite(requestedMax)
      ? Math.max(1, Math.min(DEFAULT_MAX_ENTRIES, requestedMax))
      : DEFAULT_MAX_ENTRIES;
    this.persistence = options.persistence;
    this.now = options.now ?? (() => new Date());

    const base = emptySnapshot();
    const sessionStartedAt = safeDate(
      options.sessionStartedAt,
      () => base.sessionStartedAt,
    );
    this.snapshot = {
      ...base,
      environment: sanitizeDiagnosticsEnvironment(options.environment),
      observedHosts: boundedUniqueHosts(options.observedHosts ?? []),
      sessionStartedAt,
      tracksPlayed: normalizeTrackCount(options.tracksPlayed ?? 0),
      playbackKind: options.playbackKind ?? "unknown",
      playbackStatus: options.playbackStatus ?? "idle",
    };
    this.snapshot = immutableSnapshot(this.snapshot);
  }

  public getSnapshot(): DiagnosticsSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: DiagnosticsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public log(
    message: unknown,
    options: DiagnosticsLogOptions = {},
  ): DiagnosticEntry {
    const at = safeDate(options.at, this.now);
    const entry: DiagnosticEntry = {
      id: this.nextId,
      timestamp: at.toISOString(),
      level: options.level ?? "info",
      message: sanitizeDiagnosticsText(formatUnknownMessage(message)),
      ...(options.source
        ? {
            source: sanitizeDiagnosticsText(
              formatUnknownMessage(options.source),
            ),
          }
        : {}),
    };
    this.nextId += 1;

    const entries = [...this.snapshot.entries, entry].slice(-this.maxEntries);
    const failures =
      entry.level === "error" || FAILURE_PATTERN.test(entry.message)
        ? [...this.snapshot.failures, formatPersistedEntry(entry)].slice(
            -this.maxEntries,
          )
        : this.snapshot.failures;
    this.snapshot = immutableSnapshot({ ...this.snapshot, entries, failures });
    this.notify();

    // Persistence is deliberately fire-and-forget. A disk/IPC failure must
    // never call log() here, otherwise a failed logger can recurse forever.
    this.persist(formatPersistedEntry(entry));
    return entry;
  }

  public setMetadata(update: {
    environment?: GateEnvironment | null;
    observedHosts?: readonly string[];
    sessionStartedAt?: Date;
    tracksPlayed?: number;
    playbackKind?: PlaybackKind;
    playbackStatus?: string;
    failures?: readonly string[];
  }): void {
    const nextFailures = update.failures
      ? update.failures
          .map((failure) =>
            sanitizeDiagnosticsText(formatUnknownMessage(failure)),
          )
          .filter(Boolean)
          .slice(-this.maxEntries)
      : this.snapshot.failures;
    this.snapshot = immutableSnapshot({
      ...this.snapshot,
      ...(update.environment !== undefined
        ? { environment: sanitizeDiagnosticsEnvironment(update.environment) }
        : {}),
      ...(update.observedHosts !== undefined
        ? { observedHosts: boundedUniqueHosts(update.observedHosts) }
        : {}),
      ...(update.sessionStartedAt !== undefined
        ? { sessionStartedAt: safeDate(update.sessionStartedAt, this.now) }
        : {}),
      ...(update.tracksPlayed !== undefined
        ? { tracksPlayed: normalizeTrackCount(update.tracksPlayed) }
        : {}),
      ...(update.playbackKind !== undefined
        ? { playbackKind: update.playbackKind }
        : {}),
      ...(update.playbackStatus !== undefined
        ? {
            playbackStatus: sanitizeDiagnosticsText(update.playbackStatus),
          }
        : {}),
      ...(update.failures !== undefined ? { failures: nextFailures } : {}),
    });
    this.notify();
  }

  public clearSession(): void {
    this.snapshot = immutableSnapshot({
      ...this.snapshot,
      entries: [],
      failures: [],
    });
    this.notify();
  }

  /** Returns false when the adapter is absent or its command fails. */
  public async clearLocalLogs(): Promise<boolean> {
    const clearLogs = this.persistence?.clearLogs;
    if (!clearLogs) return false;
    try {
      await clearLogs();
      return true;
    } catch {
      // Do not report this through this store: that would recurse into the
      // same failing persistence path. The UI can show its own action error.
      return false;
    }
  }

  public async getLogDirectory(): Promise<string | null> {
    const getLogDir = this.persistence?.getLogDir;
    if (!getLogDir) return null;
    try {
      const directory = await getLogDir();
      return directory ? sanitizeDiagnosticsText(directory) : null;
    } catch {
      return null;
    }
  }

  private persist(line: string): void {
    const appendLocalLog = this.persistence?.appendLocalLog;
    if (!appendLocalLog) return;
    try {
      const result = appendLocalLog(line);
      void Promise.resolve(result).catch(() => {
        // Persistence is best effort. Never call this.log() from here.
      });
    } catch {
      // Synchronous adapter failures are isolated for the same reason.
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // One broken UI subscriber must not prevent other subscribers from
        // receiving diagnostics or break the MusicKit event path.
      }
    }
  }
}

function normalizeTrackCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function formatPersistedEntry(entry: DiagnosticEntry): string {
  const source = entry.source ? ` [${entry.source}]` : "";
  return `[${entry.timestamp}]${source} ${entry.message}`;
}

export function formatDiagnosticEntries(
  entries: readonly DiagnosticEntry[],
): string {
  return entries.map(formatPersistedEntry).join("\n");
}

export { DEFAULT_MAX_ENTRIES };
