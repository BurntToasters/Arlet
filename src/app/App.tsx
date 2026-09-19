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
import { ContextMenu } from "../components/ContextMenu.tsx";
import { PlaylistDialogs } from "../components/PlaylistDialogs.tsx";
import type { DiagnosticsDrawerController } from "../diagnostics/types.ts";
import type { DiagnosticsStore } from "../diagnostics/store.ts";
import {
  clearWindowsMediaSession,
  listenWindowsMediaControls,
  updateWindowsMediaSession,
} from "../platform/windows-media.ts";

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
      } else if (event.ctrlKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
        void controller.refreshCurrentData().catch(() => undefined);
      } else if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        router.back();
      } else if (event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        router.forward();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, state.ui.diagnosticsOpen]);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void listenWindowsMediaControls((control) => {
      if (control === "play")
        void Promise.resolve(controller.play?.()).catch(() => undefined);
      else if (control === "pause")
        void Promise.resolve(controller.pause?.()).catch(() => undefined);
      else if (control === "next")
        void controller.next().catch(() => undefined);
      else void controller.previous().catch(() => undefined);
    })
      .then((unlisten) => {
        if (active) stop = unlisten;
        else unlisten();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      stop?.();
    };
  }, [controller]);

  useEffect(() => {
    const current = state.playback.current;
    if (
      !current ||
      state.playback.status === "idle" ||
      state.playback.status === "stopped" ||
      state.playback.status === "error"
    ) {
      void clearWindowsMediaSession().catch(() => undefined);
      return;
    }
    void updateWindowsMediaSession({
      title: current.title,
      artist: current.artistName,
      album: current.albumTitle,
      artworkUrl: current.artwork?.url,
      playbackStatus:
        state.playback.status === "playing" ? "playing" : "paused",
      playEnabled: state.playback.status !== "playing",
      pauseEnabled: state.playback.status === "playing",
      nextEnabled: state.playback.queueIndex < state.playback.queue.length - 1,
      previousEnabled: state.playback.queueIndex > 0,
    }).catch(() => undefined);
  }, [
    state.playback.current,
    state.playback.status,
    state.playback.queueIndex,
    state.playback.queue.length,
  ]);

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
      <ContextMenu />
      <PlaylistDialogs />
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
