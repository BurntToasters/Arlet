import { useEffect, useState } from "preact/hooks";
import {
  GATE_CHECKLIST,
  copyTextToClipboard,
  formatSessionDuration,
  loadChecklistState,
  saveChecklistState,
  type GateCheckCategory,
} from "../../phase0/gate-session.ts";
import {
  createConsoleReport,
  createFeasibilityReport,
  createNetworkReport,
} from "../../diagnostics/reports.ts";
import { fallbackDiagnosticsEnvironment } from "../../diagnostics/environment.ts";
import {
  sanitizeDiagnosticsEnvironment,
  sanitizeDiagnosticsHosts,
  sanitizeDiagnosticsList,
  sanitizeDiagnosticsText,
} from "../../diagnostics/sanitize.ts";
import type {
  DiagnosticEntry,
  DiagnosticsAppSnapshot,
  DiagnosticsDrawerProps,
  DiagnosticsSnapshot,
  DiagnosticsTab,
} from "../../diagnostics/types.ts";

export type {
  DiagnosticsDrawerController,
  DiagnosticsDrawerProps,
} from "../../diagnostics/types.ts";

const CATEGORY_ORDER: readonly GateCheckCategory[] = [
  "authorization",
  "playback",
  "lifecycle",
  "recovery",
];

const CATEGORY_TITLES: Record<GateCheckCategory, string> = {
  authorization: "Authorization",
  playback: "Playback",
  lifecycle: "Window Lifecycle",
  recovery: "Error Recovery",
};

const EMPTY_STORE_SNAPSHOT: DiagnosticsSnapshot = {
  entries: [],
  failures: [],
  environment: null,
  observedHosts: [],
  sessionStartedAt: new Date(),
  tracksPlayed: 0,
  playbackKind: "unknown",
  playbackStatus: "idle",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleTimeString();
}

function currentStoreSnapshot(
  store: DiagnosticsDrawerProps["store"],
): DiagnosticsSnapshot {
  return store?.getSnapshot() ?? EMPTY_STORE_SNAPSHOT;
}

function mergeAppSnapshot(
  appSnapshot: DiagnosticsAppSnapshot | undefined,
  storeSnapshot: DiagnosticsSnapshot,
  checklist: Readonly<Record<string, boolean>>,
): DiagnosticsAppSnapshot {
  return {
    environment: sanitizeDiagnosticsEnvironment(
      appSnapshot?.environment ?? storeSnapshot.environment,
    ),
    sessionStartedAt:
      appSnapshot?.sessionStartedAt ?? storeSnapshot.sessionStartedAt,
    tracksPlayed: appSnapshot?.tracksPlayed ?? storeSnapshot.tracksPlayed,
    playbackKind: appSnapshot?.playbackKind ?? storeSnapshot.playbackKind,
    playbackStatus: sanitizeDiagnosticsText(
      appSnapshot?.playbackStatus ?? storeSnapshot.playbackStatus,
    ),
    observedHosts: sanitizeDiagnosticsHosts(
      appSnapshot?.observedHosts ?? storeSnapshot.observedHosts,
    ),
    failures: sanitizeDiagnosticsList(
      appSnapshot?.failures ?? storeSnapshot.failures,
    ),
    checklist,
    consecutiveQueueReady: appSnapshot?.consecutiveQueueReady,
  };
}

function EntryList({ entries }: { entries: readonly DiagnosticEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="diagnostics-empty">No diagnostics recorded this session.</p>
    );
  }
  return (
    <ol className="diagnostics-console-list" aria-label="Diagnostic entries">
      {entries.map((entry) => (
        <li key={entry.id} className={`diagnostic-entry is-${entry.level}`}>
          <time dateTime={entry.timestamp}>
            {formatTimestamp(entry.timestamp)}
          </time>
          {entry.source ? (
            <span className="diagnostic-source">{entry.source}</span>
          ) : null}
          <span className="diagnostic-message">{entry.message}</span>
        </li>
      ))}
    </ol>
  );
}

function EnvironmentSummary({
  snapshot,
  logDirectory,
}: {
  snapshot: DiagnosticsAppSnapshot;
  logDirectory: string | null;
}) {
  const environment = snapshot.environment ?? fallbackDiagnosticsEnvironment();
  const rows: readonly [string, string][] = [
    ["App", environment.version],
    ["Tauri", environment.tauriVersion],
    ["Platform", `${environment.os} · ${environment.arch}`],
    ["WebView2", environment.webviewVersion ?? "unknown"],
    ["Windows", environment.windowsBuild ?? "unknown"],
    ["Build", environment.debug ? "Debug" : "Release"],
    ["Playback", snapshot.playbackKind ?? "unknown"],
    ["Tracks played", String(snapshot.tracksPlayed ?? 0)],
  ];
  return (
    <section
      className="diagnostics-environment"
      aria-labelledby="diagnostics-environment-title"
    >
      <h3 id="diagnostics-environment-title">Environment</h3>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="diagnostics-log-directory">
        <span>Local log directory</span>
        <code>{logDirectory ?? "Unavailable"}</code>
      </p>
      <p className="diagnostics-observed-hosts">
        <span>Observed network hosts</span>
        <code>
          {snapshot.observedHosts && snapshot.observedHosts.length > 0
            ? snapshot.observedHosts.join(", ")
            : "None observed"}
        </code>
      </p>
    </section>
  );
}

export function DiagnosticsDrawer({
  open,
  onClose,
  appSnapshot,
  controller,
  store,
  initialTab = "console",
}: DiagnosticsDrawerProps) {
  const [activeTab, setActiveTab] = useState<DiagnosticsTab>(initialTab);
  const [, setStoreRevision] = useState(0);
  const [checklist, setChecklist] = useState<Record<string, boolean>>(() =>
    loadChecklistState(),
  );
  const [now, setNow] = useState(() => Date.now());
  const [logDirectory, setLogDirectory] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState("");

  useEffect(() => {
    if (!store) return;
    return store.subscribe(() => {
      setStoreRevision((revision) => revision + 1);
    });
  }, [store]);

  useEffect(() => {
    if (!appSnapshot?.checklist) return;
    setChecklist((current) => {
      const next = { ...current, ...appSnapshot.checklist };
      return checklistEqual(current, next) ? current : next;
    });
  }, [appSnapshot?.checklist]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    const getDirectory =
      controller?.getLogDirectory ??
      (store ? () => store.getLogDirectory() : undefined);
    if (!getDirectory) {
      setLogDirectory(null);
      return;
    }
    void Promise.resolve(getDirectory())
      .then((directory) => {
        if (mounted) setLogDirectory(directory);
      })
      .catch(() => {
        if (mounted) setLogDirectory(null);
      });
    return () => {
      mounted = false;
    };
  }, [controller, open, store]);

  if (!open) return null;

  const storeSnapshot = currentStoreSnapshot(store);
  const effectiveChecklist = mergeChecklist(checklist, appSnapshot?.checklist);
  const effectiveSnapshot = mergeAppSnapshot(
    appSnapshot,
    storeSnapshot,
    effectiveChecklist,
  );
  const sessionStartedAt =
    effectiveSnapshot.sessionStartedAt ?? storeSnapshot.sessionStartedAt;
  const checkedCount = GATE_CHECKLIST.filter(
    (item) => effectiveChecklist[item.id],
  ).length;

  const reportData = {
    appSnapshot: effectiveSnapshot,
    storeSnapshot,
    checklist: effectiveChecklist,
  };

  const runAction = async (
    action: (() => void | Promise<void>) | undefined,
    success: string,
  ): Promise<void> => {
    if (!action) return;
    try {
      await action();
      setActionMessage(success);
    } catch (error) {
      const message = `${success} failed: ${errorMessage(error)}`;
      setActionMessage(message);
      store?.log(message, { level: "error", source: "diagnostics" });
    }
  };

  const copyReport = async (
    text: string,
    callback: ((value: string) => void | Promise<void>) | undefined,
    success: string,
  ): Promise<void> => {
    try {
      if (callback) {
        await callback(text);
      } else {
        await copyTextToClipboard(text);
      }
      setActionMessage(success);
    } catch (error) {
      const message = `${success} failed: ${errorMessage(error)}`;
      setActionMessage(message);
      store?.log(message, { level: "error", source: "diagnostics" });
    }
  };

  const toggleItem = (id: string): void => {
    const next = { ...effectiveChecklist, [id]: !effectiveChecklist[id] };
    setChecklist(next);
    saveChecklistState(next);
    void runAction(
      controller?.onToggleChecklist
        ? () => controller.onToggleChecklist?.(id, next[id] ?? false)
        : undefined,
      "Checklist updated",
    );
  };

  const resetChecklist = (): void => {
    const next = Object.fromEntries(
      GATE_CHECKLIST.map((item) => [item.id, false]),
    );
    setChecklist(next);
    saveChecklistState(next);
    void runAction(controller?.onResetChecklist, "Checklist reset");
  };

  const clearSession = (): void => {
    store?.clearSession();
    void runAction(controller?.onClearSession, "Session console cleared");
  };

  const clearLocal = (): void => {
    const clear = async (): Promise<void> => {
      if (controller?.onClearLocal) {
        await controller.onClearLocal();
        return;
      }
      if (!(await store?.clearLocalLogs())) {
        throw new Error("Local log adapter unavailable");
      }
    };
    void runAction(clear, "Local logs cleared");
  };

  const consoleReport = createConsoleReport(storeSnapshot);
  const feasibilityReport = createFeasibilityReport(reportData);
  const networkReport = createNetworkReport(reportData);

  return (
    <aside className="diagnostics-drawer" aria-labelledby="diagnostics-title">
      <header className="diagnostics-header">
        <div>
          <p className="eyebrow">Developer tools</p>
          <h2 id="diagnostics-title">Diagnostics</h2>
        </div>
        <button
          type="button"
          className="diagnostics-close"
          onClick={onClose}
          aria-label="Close diagnostics"
        >
          Close
        </button>
      </header>

      <div
        className="diagnostics-tabs"
        role="tablist"
        aria-label="Diagnostics views"
      >
        <button
          id="diagnostics-tab-console"
          type="button"
          role="tab"
          aria-selected={activeTab === "console"}
          aria-controls="diagnostics-panel-console"
          tabIndex={activeTab === "console" ? 0 : -1}
          onClick={() => setActiveTab("console")}
        >
          Console
        </button>
        <button
          id="diagnostics-tab-feasibility"
          type="button"
          role="tab"
          aria-selected={activeTab === "feasibility"}
          aria-controls="diagnostics-panel-feasibility"
          tabIndex={activeTab === "feasibility" ? 0 : -1}
          onClick={() => setActiveTab("feasibility")}
        >
          Feasibility
        </button>
      </div>

      <div className="diagnostics-body">
        {activeTab === "console" ? (
          <section
            id="diagnostics-panel-console"
            role="tabpanel"
            aria-labelledby="diagnostics-tab-console"
            tabIndex={0}
            className="diagnostics-panel diagnostics-console-panel"
          >
            <div className="diagnostics-panel-toolbar">
              <span>{storeSnapshot.entries.length} session entries</span>
              <div>
                <button
                  type="button"
                  onClick={() =>
                    void copyReport(
                      consoleReport,
                      controller?.onCopyConsole,
                      "Console copied",
                    )
                  }
                >
                  Copy console
                </button>
                <button type="button" onClick={clearSession}>
                  Clear session
                </button>
                <button type="button" onClick={clearLocal}>
                  Clear local logs
                </button>
              </div>
            </div>
            <pre className="diagnostics-console-output">
              <EntryList entries={storeSnapshot.entries} />
            </pre>
            <EnvironmentSummary
              snapshot={effectiveSnapshot}
              logDirectory={logDirectory}
            />
          </section>
        ) : (
          <section
            id="diagnostics-panel-feasibility"
            role="tabpanel"
            aria-labelledby="diagnostics-tab-feasibility"
            tabIndex={0}
            className="diagnostics-panel diagnostics-feasibility-panel"
          >
            <div className="diagnostics-session-summary">
              <span>
                Session {formatSessionDuration(sessionStartedAt, new Date(now))}
              </span>
              <span>{effectiveSnapshot.tracksPlayed ?? 0} tracks played</span>
              <span>
                {checkedCount} / {GATE_CHECKLIST.length} complete
              </span>
            </div>
            <div
              className="diagnostics-progress"
              role="progressbar"
              aria-label="Feasibility checklist progress"
              aria-valuemin={0}
              aria-valuemax={GATE_CHECKLIST.length}
              aria-valuenow={checkedCount}
            >
              <span
                style={{
                  width: `${(checkedCount / GATE_CHECKLIST.length) * 100}%`,
                }}
              />
            </div>

            <div className="diagnostics-checklist">
              {CATEGORY_ORDER.map((category) => (
                <fieldset key={category}>
                  <legend>{CATEGORY_TITLES[category]}</legend>
                  {GATE_CHECKLIST.filter(
                    (item) => item.category === category,
                  ).map((item) => (
                    <label key={item.id} className="diagnostics-check-item">
                      <input
                        type="checkbox"
                        checked={effectiveChecklist[item.id] ?? false}
                        onChange={() => toggleItem(item.id)}
                      />
                      <span>{item.label}</span>
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>

            <div className="diagnostics-actions">
              <button
                type="button"
                onClick={() =>
                  void copyReport(
                    feasibilityReport,
                    controller?.onCopyFeasibility,
                    "Feasibility report copied",
                  )
                }
              >
                Copy feasibility report
              </button>
              <button
                type="button"
                onClick={() =>
                  void copyReport(
                    networkReport,
                    controller?.onCopyNetwork,
                    "Network surface copied",
                  )
                }
              >
                Copy network surface
              </button>
              <button type="button" onClick={resetChecklist}>
                Reset checklist
              </button>
              <button
                type="button"
                disabled={!controller?.onOpenMusicDiagnostic}
                onClick={() =>
                  void runAction(
                    controller?.onOpenMusicDiagnostic,
                    "Diagnostic window opened",
                  )
                }
              >
                Open music.apple.com diagnostic
              </button>
              <button
                type="button"
                disabled={
                  !controller?.onQueueConsecutive ||
                  appSnapshot?.consecutiveQueueReady === false
                }
                onClick={() =>
                  void runAction(
                    controller?.onQueueConsecutive,
                    "20-track queue started",
                  )
                }
              >
                Queue 20 consecutive
              </button>
            </div>
            {effectiveSnapshot.failures &&
            effectiveSnapshot.failures.length > 0 ? (
              <section
                className="diagnostics-failures"
                aria-labelledby="diagnostics-failures-title"
              >
                <h3 id="diagnostics-failures-title">Observed failures</h3>
                <ul>
                  {effectiveSnapshot.failures.map((failure, index) => (
                    <li key={`${failure}-${index}`}>{failure}</li>
                  ))}
                </ul>
              </section>
            ) : null}
            <EnvironmentSummary
              snapshot={effectiveSnapshot}
              logDirectory={logDirectory}
            />
          </section>
        )}
      </div>
      <p className="diagnostics-action-status" role="status" aria-live="polite">
        {actionMessage}
      </p>
    </aside>
  );
}

function mergeChecklist(
  local: Readonly<Record<string, boolean>>,
  incoming: Readonly<Record<string, boolean>> | undefined,
): Record<string, boolean> {
  return incoming ? { ...local, ...incoming } : { ...local };
}

function checklistEqual(
  left: Readonly<Record<string, boolean>>,
  right: Readonly<Record<string, boolean>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

export default DiagnosticsDrawer;
