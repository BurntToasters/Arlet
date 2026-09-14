import { useEffect, useRef, useState } from "preact/hooks";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  ChevronDown,
  Menu,
  Minus,
  Square,
  X,
} from "lucide-preact";
import type { JSX } from "preact";
import {
  useAppController,
  useAppRouter,
  useAppState,
} from "../app/context.tsx";
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

export function Titlebar(): JSX.Element {
  const state = useAppState();
  const controller = useAppController();
  const router = useAppRouter();
  const maximizeButton = useRef<HTMLButtonElement>(null);
  const [maximized, setMaximized] = useState(false);
  const showDiagnostics = import.meta.env.DEV;

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

      <div className="titlebar-status" data-tauri-drag-region>
        <span
          className={`status-dot status-${state.initialization.status}`}
          aria-hidden="true"
        />
        <span>
          {state.initialization.status === "ready"
            ? state.auth.status === "authorized"
              ? "Connected"
              : "Ready"
            : state.initialization.status === "error"
              ? "Offline"
              : "Starting"}
        </span>
        <ChevronDown aria-hidden="true" size={14} strokeWidth={1.8} />
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
