import type { PlaybackKind } from "../musickit/preview.ts";
import type {
  GateEnvironment,
  GateCheckCategory,
} from "../phase0/gate-session.ts";

/** The two views intentionally keep the drawer small and predictable. */
export type DiagnosticsTab = "console" | "feasibility";

export type DiagnosticLevel = "info" | "warn" | "error";

/**
 * A log line that is safe to render. `DiagnosticsStore` redacts the message
 * before constructing this object, so consumers must not pass raw tokens to
 * the UI or persistence adapter.
 */
export interface DiagnosticEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly level: DiagnosticLevel;
  readonly message: string;
  readonly source?: string;
}

export interface DiagnosticsSnapshot {
  readonly entries: readonly DiagnosticEntry[];
  readonly failures: readonly string[];
  readonly environment: GateEnvironment | null;
  readonly observedHosts: readonly string[];
  readonly sessionStartedAt: Date;
  readonly tracksPlayed: number;
  readonly playbackKind: PlaybackKind;
  readonly playbackStatus: string;
}

/**
 * Only sanitized application facts belong in this snapshot. In particular,
 * it deliberately has no Music User Token or developer token field.
 */
export interface DiagnosticsAppSnapshot {
  readonly environment?: GateEnvironment | null;
  readonly sessionStartedAt?: Date;
  readonly tracksPlayed?: number;
  readonly playbackKind?: PlaybackKind;
  readonly playbackStatus?: string;
  readonly observedHosts?: readonly string[];
  readonly failures?: readonly string[];
  readonly checklist?: Readonly<Record<string, boolean>>;
  readonly consecutiveQueueReady?: boolean;
}

export interface DiagnosticsDrawerController {
  onCopyConsole?: (text: string) => void | Promise<void>;
  onCopyFeasibility?: (report: string) => void | Promise<void>;
  onCopyNetwork?: (report: string) => void | Promise<void>;
  onClearSession?: () => void | Promise<void>;
  onClearLocal?: () => void | Promise<void>;
  onToggleChecklist?: (id: string, checked: boolean) => void | Promise<void>;
  onResetChecklist?: () => void | Promise<void>;
  onOpenMusicDiagnostic?: () => void | Promise<void>;
  onQueueConsecutive?: () => void | Promise<void>;
  getLogDirectory?: () => string | null | Promise<string | null>;
}

export interface DiagnosticsDrawerProps {
  open: boolean;
  onClose: () => void;
  /**
   * Parent-owned, token-free facts used for the feasibility report. The
   * drawer remains useful without this prop while the shell is booting.
   */
  appSnapshot?: DiagnosticsAppSnapshot;
  controller?: DiagnosticsDrawerController;
  store?: {
    getSnapshot: () => DiagnosticsSnapshot;
    subscribe: (listener: () => void) => () => void;
    log: (
      message: unknown,
      options?: { level?: DiagnosticLevel; source?: string },
    ) => DiagnosticEntry;
    clearSession: () => void;
    clearLocalLogs: () => Promise<boolean>;
    getLogDirectory: () => Promise<string | null>;
  };
  initialTab?: DiagnosticsTab;
}

export const CHECKLIST_CATEGORY_TITLES: Record<GateCheckCategory, string> = {
  authorization: "Authorization",
  playback: "Playback",
  lifecycle: "Window Lifecycle",
  recovery: "Error Recovery",
};
