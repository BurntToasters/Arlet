import { useEffect } from "preact/hooks";
import type { JSX } from "preact";
import type { HashRouter } from "../routing/router.ts";
import { getState, setUiState, subscribePlaybackPosition } from "../state.ts";
import type { AppController } from "./controller.ts";
import { shortcutFor, type ShortcutAction } from "./shortcuts.ts";
import { reportActionError } from "../components/action-errors.ts";
import {
  AppProvider,
  useAppController,
  useAppRouter,
  useAppSlices,
} from "./context.tsx";
import { QueueDrawer } from "../components/QueueDrawer.tsx";
import { Sidebar } from "../components/Sidebar.tsx";
import { PlayerBar } from "../components/PlayerBar.tsx";
import { NowPlaying } from "../components/NowPlaying.tsx";
import { Titlebar } from "../components/Titlebar.tsx";
import { RouteView } from "../views/RouteView.tsx";
import { DevDiagnostics } from "./DevDiagnostics.tsx";
import { MediaSessionSync } from "./MediaSessionSync.tsx";
import { UpdateReadyModal } from "../components/UpdateReadyModal.tsx";
import { ContextMenu } from "../components/ContextMenu.tsx";
import { PlaylistDialogs } from "../components/PlaylistDialogs.tsx";
import { ActionToasts } from "../components/ActionToasts.tsx";
import { TokenExpiryNotice } from "../components/TokenExpiryNotice.tsx";
import type { DiagnosticsStore } from "../diagnostics/store.ts";
import {
  clampWindowsMediaSeek,
  createTimelineSync,
  listenWindowsMediaControls,
  listenWindowsMediaRepeat,
  listenWindowsMediaSeek,
  listenWindowsMediaShuffle,
  updateWindowsMediaTimeline,
} from "../platform/windows-media.ts";
import { listenBeforeQuit } from "../platform/quit.ts";

export interface AppProps {
  controller: AppController;
  router: HashRouter;
  diagnosticsStore?: DiagnosticsStore;
}

/** Runs a transport shortcut; false means it did not apply to this state. */
function runShortcut(
  controller: AppController,
  action: ShortcutAction,
): boolean {
  const { playback, initialization, ui } = getState();
  const transportReady =
    initialization.status === "ready" && playback.current !== undefined;
  switch (action.type) {
    case "togglePlayback":
      if (!transportReady) return false;
      void controller.togglePlayback().catch(reportActionError);
      return true;
    case "next":
      if (!transportReady) return false;
      void controller.next().catch(reportActionError);
      return true;
    case "previous":
      if (!transportReady) return false;
      void controller.previous().catch(reportActionError);
      return true;
    case "seekBy":
      if (!transportReady) return false;
      controller.seekBy(action.seconds);
      return true;
    case "adjustVolume":
      controller.adjustVolume(action.delta);
      return true;
    case "toggleMute":
      controller.toggleMute();
      return true;
    case "closeNowPlaying":
      if (!ui.nowPlayingOpen) return false;
      setUiState({ nowPlayingOpen: false });
      return true;
  }
}

function AppLayout({
  diagnosticsStore,
}: {
  diagnosticsStore?: DiagnosticsStore;
}): JSX.Element {
  // Playback, diagnostics and search are read by child components that own
  // their subscriptions, so a playback tick does not re-render the shell.
  const state = useAppSlices("navigation", "settings", "ui", "windowEffect");
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
      const action = shortcutFor(event);
      if (action && runShortcut(controller, action)) {
        event.preventDefault();
      } else if (
        event.ctrlKey &&
        event.shiftKey &&
        event.key.toLowerCase() === "d"
      ) {
        if (!import.meta.env.DEV) return;
        event.preventDefault();
        setUiState({ diagnosticsOpen: !getState().ui.diagnosticsOpen });
      } else if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        router.navigate({ kind: "search", query: "" });
        // The Search view may render a few frames after navigation.
        let attempts = 0;
        const focusSearch = (): void => {
          const input =
            document.querySelector<HTMLInputElement>(".search-form input");
          if (input) input.focus();
          else if ((attempts += 1) < 30) requestAnimationFrame(focusSearch);
        };
        requestAnimationFrame(focusSearch);
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
  }, [controller, router]);

  // Quitting waits for the queue position to be saved (see tray.rs).
  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void listenBeforeQuit(
      () => controller.prepareToQuit?.() ?? Promise.resolve(),
    )
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
    // MusicKit stays the source of truth: these requests call the same
    // controller methods as the in-app buttons, and SMTC then reflects the
    // state the payload effect reads back. Requests before sign-in and
    // MusicKit setup are dropped, not queued.
    let active = true;
    const stops: Array<() => void> = [];
    const track = (listening: Promise<() => void>): void => {
      void listening
        .then((stop) => {
          if (active) stops.push(stop);
          else stop();
        })
        .catch(() => undefined);
    };
    const ready = (): boolean => getState().initialization.status === "ready";
    track(
      listenWindowsMediaSeek((seconds) => {
        if (!ready()) return;
        const target = clampWindowsMediaSeek(
          seconds,
          getState().playback.durationSeconds,
        );
        if (target !== undefined) {
          void controller.seek(target).catch(() => undefined);
        }
      }),
    );
    track(
      listenWindowsMediaShuffle((enabled) => {
        if (!ready()) return;
        void Promise.resolve(
          controller.setShuffleMode?.(enabled ? "songs" : "off"),
        ).catch(() => undefined);
      }),
    );
    track(
      listenWindowsMediaRepeat((mode) => {
        if (!ready()) return;
        void Promise.resolve(controller.setRepeatMode?.(mode)).catch(
          () => undefined,
        );
      }),
    );
    return () => {
      active = false;
      for (const stop of stops) stop();
    };
  }, [controller]);

  useEffect(() => {
    const sync = createTimelineSync((timeline) => {
      void updateWindowsMediaTimeline(timeline).catch(() => undefined);
    });
    return subscribePlaybackPosition(() => {
      const { positionSeconds, durationSeconds, status } = getState().playback;
      sync({ positionSeconds, durationSeconds, playing: status === "playing" });
    });
  }, []);

  return (
    <div className="app-shell">
      <MediaSessionSync />
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
      <DevDiagnostics diagnosticsStore={diagnosticsStore} />
      <PlayerBar />
      <NowPlaying />
      <UpdateReadyModal />
      <ContextMenu />
      <PlaylistDialogs />
      <ActionToasts />
      <TokenExpiryNotice />
    </div>
  );
}

function useAppControllerForLayout(): AppController {
  // Kept as a named helper so AppLayout's diagnostics wiring remains easy to
  // replace with a richer worker-owned drawer without changing shell markup.
  return useAppController();
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
