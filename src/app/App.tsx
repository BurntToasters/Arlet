import { useEffect } from "preact/hooks";
import type { JSX } from "preact";
import type { HashRouter } from "../routing/router.ts";
import { clearDiagnosticLogs, setUiState } from "../state.ts";
import type { AppController } from "./controller.ts";
import {
  AppProvider,
  useAppController,
  useAppRouter,
  useAppState,
} from "./context.tsx";
import { QueueDrawer } from "../components/QueueDrawer.tsx";
import { Sidebar } from "../components/Sidebar.tsx";
import { PlayerBar } from "../components/PlayerBar.tsx";
import { Titlebar } from "../components/Titlebar.tsx";
import { RouteView } from "../views/RouteView.tsx";
import { DiagnosticsDrawer } from "../components/diagnostics/DiagnosticsDrawer.tsx";
import { UpdateReadyModal } from "../components/UpdateReadyModal.tsx";
import type { DiagnosticsDrawerController } from "../diagnostics/types.ts";
import type { DiagnosticsStore } from "../diagnostics/store.ts";

export interface AppProps {
  controller: AppController;
  router: HashRouter;
  diagnosticsStore?: DiagnosticsStore;
}

function AppLayout({
  diagnosticsStore,
}: {
  diagnosticsStore?: DiagnosticsStore;
}): JSX.Element {
  const state = useAppState();
  const controller = useAppControllerForLayout();
  const router = useAppRouter();

  useEffect(() => {
    const root = document.documentElement;
    if (state.settings.theme === "system") {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = state.settings.theme;
    }
    root.dataset.windowEffect = state.windowEffect.applied;
  }, [state.settings.theme, state.windowEffect.applied]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "d") {
        if (!import.meta.env.DEV) return;
        event.preventDefault();
        setUiState({ diagnosticsOpen: !state.ui.diagnosticsOpen });
      } else if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        router.navigate({ kind: "search", query: "" });
        window.setTimeout(() => {
          document
            .querySelector<HTMLInputElement>(".search-form input")
            ?.focus();
        }, 0);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, state.ui.diagnosticsOpen]);

  return (
    <div className="app-shell">
      <Titlebar />
      <div className="app-body">
        <Sidebar />
        {state.ui.sidebarOpen ? (
          <button
            className="sidebar-scrim"
            type="button"
            aria-label="Close navigation"
            onClick={() => setUiState({ sidebarOpen: false })}
          />
        ) : null}
        <RouteView route={state.navigation} />
        <QueueDrawer />
      </div>
      {state.ui.diagnosticsOpen && import.meta.env.DEV ? (
        <DiagnosticsDrawer
          open
          onClose={controller.closeDiagnostics}
          store={diagnosticsStore}
          appSnapshot={{
            tracksPlayed: state.tracksPlayed,
            playbackStatus: state.playback.status,
            failures: state.diagnostics.failures,
            sessionStartedAt: new Date(state.diagnostics.sessionStartedAt),
            consecutiveQueueReady:
              state.search.results.length >= controller.consecutiveTrackTarget,
          }}
          controller={diagnosticsController(controller)}
        />
      ) : null}
      <PlayerBar />
      <UpdateReadyModal />
    </div>
  );
}

function useAppControllerForLayout(): AppController {
  // Kept as a named helper so AppLayout's diagnostics wiring remains easy to
  // replace with a richer worker-owned drawer without changing shell markup.
  return useAppController();
}

export function diagnosticsController(
  controller: AppController,
): DiagnosticsDrawerController {
  return {
    onClearSession: () => {
      clearDiagnosticLogs();
    },
    onOpenMusicDiagnostic: async () => {
      await controller.openMusicDiagnostic();
    },
    onQueueConsecutive: () => controller.playConsecutive(),
  };
}

export function App({
  controller,
  router,
  diagnosticsStore,
}: AppProps): JSX.Element {
  return (
    <AppProvider controller={controller} router={router}>
      <AppLayout diagnosticsStore={diagnosticsStore} />
    </AppProvider>
  );
}

export default App;
