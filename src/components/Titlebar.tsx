import { useEffect, useRef, useState } from "preact/hooks";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  ChevronDown,
  Check,
  Database,
  LogIn,
  LogOut,
  Menu,
  Minus,
  RefreshCw,
  Settings,
  Square,
  X,
} from "lucide-preact";
import type { JSX } from "preact";
import {
  useAppController,
  useAppRouter,
  useAppState,
} from "../app/context.tsx";
import type { AppController } from "../app/controller.ts";
import { setUiState } from "../state.ts";
import {
  closeWindow,
  isWindowMaximized,
  listenWindowResize,
  minimizeWindow,
  startWindowDrag,
  toggleMaximize,
  bindSnapLayout,
} from "../platform/window.ts";
import { IconButton } from "./IconButton.tsx";

interface AccountSummaryLike {
  displayName?: string;
  name?: string;
  storefront?: string;
  lastRefreshAt?: number | string;
}

interface CollectionSummaryLike {
  lastUpdatedAt?: number | string;
  source?: string;
}

interface ExtendedState {
  account?: unknown;
  library?: unknown;
}

interface ExtendedController {
  refreshCurrentData?: () => Promise<unknown>;
  refreshCurrentView?: () => Promise<unknown>;
  refreshLibrarySection?: (section: string) => Promise<unknown>;
}

function readAccountSummary(
  state: ReturnType<typeof useAppState>,
): AccountSummaryLike | undefined {
  const value = (state as unknown as ExtendedState).account;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  return {
    displayName:
      typeof candidate.displayName === "string"
        ? candidate.displayName
        : undefined,
    name: typeof candidate.name === "string" ? candidate.name : undefined,
    storefront:
      typeof candidate.storefront === "string"
        ? candidate.storefront
        : undefined,
    lastRefreshAt:
      typeof candidate.lastRefreshAt === "number" ||
      typeof candidate.lastRefreshAt === "string"
        ? candidate.lastRefreshAt
        : undefined,
  };
}

function readLastRefresh(
  state: ReturnType<typeof useAppState>,
): number | undefined {
  const account = readAccountSummary(state);
  const accountRefresh = account?.lastRefreshAt;
  if (accountRefresh !== undefined) {
    const parsed =
      typeof accountRefresh === "number"
        ? accountRefresh
        : Date.parse(accountRefresh);
    if (Number.isFinite(parsed)) return parsed;
  }
  const candidate = (state as unknown as ExtendedState).library;
  if (!candidate || typeof candidate !== "object") return undefined;
  const library = candidate as Record<string, unknown>;
  const collections =
    library.collections && typeof library.collections === "object"
      ? (library.collections as Record<string, unknown>)
      : library;
  const timestamps = Object.values(collections)
    .filter((value): value is CollectionSummaryLike => {
      return Boolean(value && typeof value === "object");
    })
    .map((value) => value.lastUpdatedAt)
    .filter((value): value is number | string => value !== undefined)
    .map((value) =>
      typeof value === "number" ? value : Date.parse(String(value)),
    )
    .filter((value) => Number.isFinite(value));
  return timestamps.length ? Math.max(...timestamps) : undefined;
}

function formatLastRefresh(value: number | undefined): string {
  if (value === undefined) return "Not refreshed yet";
  return `Last refreshed ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))}`;
}

export function Titlebar(): JSX.Element {
  const state = useAppState();
  const controller = useAppController();
  const router = useAppRouter();
  const maximizeButton = useRef<HTMLButtonElement>(null);
  const statusButton = useRef<HTMLButtonElement>(null);
  const statusMenu = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const showDiagnostics = import.meta.env.DEV;
  const account = readAccountSummary(state);
  const lastRefresh = readLastRefresh(state);
  const extendedController = controller as AppController & ExtendedController;

  useEffect(() => {
    let active = true;
    void isWindowMaximized().then((value) => {
      if (active && value !== undefined) setMaximized(value);
    });
    let stopResize: (() => void) | undefined;
    void listenWindowResize(() => {
      void isWindowMaximized().then((value) => {
        if (active && value !== undefined) setMaximized(value);
      });
    }).then((cleanup) => {
      if (active) stopResize = cleanup;
      else cleanup();
    });
    return () => {
      active = false;
      stopResize?.();
    };
  }, []);

  useEffect(() => {
    if (!statusOpen) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (
        target instanceof Node &&
        (statusMenu.current?.contains(target) ||
          statusButton.current?.contains(target))
      ) {
        return;
      }
      setStatusOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setStatusOpen(false);
        statusButton.current?.focus();
        return;
      }
      const items = Array.from(
        statusMenu.current?.querySelectorAll<HTMLButtonElement>(
          'button[role="menuitem"]:not(:disabled)',
        ) ?? [],
      );
      const current = items.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        items[(current + delta + items.length) % items.length]?.focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        (event.key === "Home" ? items[0] : items.at(-1))?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [statusOpen]);

  useEffect(() => {
    if (!statusOpen) return;
    statusMenu.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [statusOpen]);

  useEffect(() => {
    const button = maximizeButton.current;
    if (!button) return undefined;
    const binding = bindSnapLayout(button);
    return () => binding.dispose();
  }, []);

  const runWindowAction = (action: () => Promise<unknown>): void => {
    void action().catch((error: unknown) => {
      controller.log(
        `Window action failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const onTitlebarPointer = (
    event: JSX.TargetedMouseEvent<HTMLElement>,
  ): void => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-window-control], [data-no-drag]")) return;
    runWindowAction(startWindowDrag);
  };

  const onTitlebarDoubleClick = (
    event: JSX.TargetedMouseEvent<HTMLElement>,
  ): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-no-drag]")) return;
    runWindowAction(async () => {
      const value = await toggleMaximize();
      if (value !== undefined) setMaximized(value);
    });
  };

  const onMaximize = (): void => {
    runWindowAction(async () => {
      const value = await toggleMaximize();
      if (value !== undefined) setMaximized(value);
    });
  };

  const runStatusAction = (
    action: (() => Promise<unknown>) | undefined,
  ): void => {
    if (!action) return;
    setStatusOpen(false);
    void action().catch((error: unknown) => {
      controller.log(
        `Connection menu action failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const refreshCurrentView = (): void => {
    const librarySection =
      state.navigation.kind === "library"
        ? state.navigation.section
        : undefined;
    const action =
      extendedController.refreshCurrentData ??
      extendedController.refreshCurrentView ??
      (librarySection !== undefined && extendedController.refreshLibrarySection
        ? () => extendedController.refreshLibrarySection!(librarySection)
        : undefined);
    runStatusAction(action);
  };

  const statusLabel =
    state.initialization.status === "ready"
      ? state.auth.status === "authorized"
        ? "Connected"
        : "Ready"
      : state.initialization.status === "error"
        ? "Offline"
        : "Starting";
  const signedInLabel =
    account?.displayName ?? account?.name ?? "Apple Music account";

  return (
    <header
      className="titlebar"
      data-tauri-drag-region
      onMouseDown={onTitlebarPointer}
      onDblClick={onTitlebarDoubleClick}
    >
      <button
        className="mobile-menu-button icon-button"
        type="button"
        aria-label="Open navigation"
        onClick={() => setUiState({ sidebarOpen: !state.ui.sidebarOpen })}
        data-no-drag
      >
        <Menu aria-hidden="true" size={18} strokeWidth={1.9} />
      </button>
      <div className="titlebar-brand" data-tauri-drag-region>
        <span className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="brand-name">Arlet</span>
      </div>

      <div className="titlebar-navigation" data-no-drag>
        <IconButton
          icon={ArrowLeft}
          label="Go back"
          className="titlebar-nav-button"
          onClick={router.back}
        />
        <IconButton
          icon={ArrowRight}
          label="Go forward"
          className="titlebar-nav-button"
          onClick={router.forward}
        />
      </div>

      <div className="titlebar-status-wrap" data-no-drag>
        <button
          ref={statusButton}
          className="titlebar-status"
          type="button"
          aria-label="Apple Music connection"
          aria-haspopup="menu"
          aria-expanded={statusOpen}
          onClick={() => setStatusOpen((open) => !open)}
          data-no-drag
        >
          <span
            className={`status-dot status-${state.initialization.status}`}
            aria-hidden="true"
          />
          <span>{statusLabel}</span>
          <ChevronDown aria-hidden="true" size={14} strokeWidth={1.8} />
        </button>
        {statusOpen ? (
          <div
            ref={statusMenu}
            className="connection-popover"
            role="menu"
            aria-label="Apple Music connection details"
            data-no-drag
          >
            <div className="connection-popover-heading">
              <span className="eyebrow">Apple Music</span>
              <strong>
                {state.auth.status === "authorized"
                  ? signedInLabel
                  : "Not signed in"}
              </strong>
              <small>
                {state.auth.status === "authorized"
                  ? account?.storefront
                    ? `${account.storefront} storefront`
                    : "Connected for this session"
                  : state.initialization.status === "error"
                    ? "MusicKit is offline"
                    : "Sign in to sync your library"}
              </small>
            </div>
            <div className="connection-popover-meta">
              <span>
                <Check aria-hidden="true" size={14} strokeWidth={1.9} />
                {state.initialization.status === "ready"
                  ? "MusicKit initialized"
                  : state.initialization.status === "loading"
                    ? "Initializing MusicKit…"
                    : state.initialization.status === "error"
                      ? "Initialization failed"
                      : "Waiting to initialize"}
              </span>
              <span>
                <Database aria-hidden="true" size={14} strokeWidth={1.8} />
                {formatLastRefresh(lastRefresh)}
              </span>
            </div>
            <div className="connection-popover-actions">
              <button
                type="button"
                role="menuitem"
                onClick={refreshCurrentView}
                disabled={state.auth.status !== "authorized"}
              >
                <RefreshCw aria-hidden="true" size={15} strokeWidth={1.8} />
                Refresh current view
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setStatusOpen(false);
                  router.navigate({ kind: "settings" });
                }}
              >
                <Settings aria-hidden="true" size={15} strokeWidth={1.8} />
                Open Settings
              </button>
              {state.auth.status === "authorized" ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runStatusAction(controller.signOut)}
                >
                  <LogOut aria-hidden="true" size={15} strokeWidth={1.8} />
                  Sign out
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  disabled={
                    state.initialization.status !== "ready" ||
                    state.auth.pending === true
                  }
                  onClick={() => runStatusAction(controller.authorize)}
                >
                  <LogIn aria-hidden="true" size={15} strokeWidth={1.8} />
                  {state.auth.pending === true
                    ? "Signing in…"
                    : "Sign in / Retry"}
                </button>
              )}
            </div>
          </div>
        ) : null}
      </div>

      <div className="titlebar-spacer" data-tauri-drag-region />

      {showDiagnostics ? (
        <button
          className={`titlebar-debug icon-button ${state.ui.diagnosticsOpen ? "is-active" : ""}`.trim()}
          type="button"
          aria-label="Toggle developer diagnostics"
          aria-pressed={state.ui.diagnosticsOpen}
          onClick={controller.toggleDiagnostics}
          data-no-drag
        >
          <Bug aria-hidden="true" size={16} strokeWidth={1.8} />
        </button>
      ) : null}

      <div className="window-controls" data-no-drag>
        <button
          className="window-control"
          type="button"
          aria-label="Minimize window"
          onClick={() => runWindowAction(minimizeWindow)}
          data-window-control
        >
          <Minus aria-hidden="true" size={15} strokeWidth={1.7} />
        </button>
        <button
          ref={maximizeButton}
          className="window-control"
          type="button"
          aria-label={maximized ? "Restore window" : "Maximize window"}
          aria-pressed={maximized}
          onClick={onMaximize}
          data-window-control
        >
          <Square aria-hidden="true" size={12} strokeWidth={1.7} />
        </button>
        <button
          className="window-control window-control-close"
          type="button"
          aria-label="Close window"
          onClick={() => runWindowAction(closeWindow)}
          data-window-control
        >
          <X aria-hidden="true" size={15} strokeWidth={1.7} />
        </button>
      </div>
    </header>
  );
}
