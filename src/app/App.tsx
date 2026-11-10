import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { HashRouter } from "../routing/router.ts";
import { getState, setUiState, subscribePlaybackPosition } from "../state.ts";
import type { AppController } from "./controller.ts";
import {
  hasOpenDialog,
  isEditableTarget,
  isShortcutOverlayKey,
  shortcutFor,
  type ShortcutAction,
} from "./shortcuts.ts";
import { reportActionError } from "../components/action-errors.ts";
import {
  closeNowPlayingLeavingFullscreen,
  toggleWindowFullscreen,
} from "../components/window-fullscreen.ts";
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
import { MiniPlayer } from "../components/MiniPlayer.tsx";
import { exitMiniPlayer, toggleMiniPlayer } from "./mini-player.ts";
import { UpdateReadyModal } from "../components/UpdateReadyModal.tsx";
import { ContextMenu } from "../components/ContextMenu.tsx";
import { PlaylistDialogs } from "../components/PlaylistDialogs.tsx";
import { ShortcutOverlay } from "../components/ShortcutOverlay.tsx";
import { SongInfoDialog } from "../components/SongInfoDialog.tsx";
import { ActionToasts } from "../components/ActionToasts.tsx";
import { PreviewNotice } from "../components/PreviewNotice.tsx";
import { SessionExpiredNotice } from "../components/SessionExpiredNotice.tsx";
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
  type WindowsMediaControl,
} from "../platform/windows-media.ts";
import { listenBeforeQuit } from "../platform/quit.ts";
import { safeErrorMessage } from "./controller-support.ts";

export interface AppProps {
  controller: AppController;
  router: HashRouter;
  diagnosticsStore?: DiagnosticsStore;
}

/** Logs `<label>: <message>` for a failed call; never rethrows. */
function logFailure(
  controller: Pick<AppController, "log">,
  label: string,
): (error: unknown) => void {
  return (error) => controller.log(`${label}: ${safeErrorMessage(error)}`);
}

/** Logs only the first failure of a streak; `reset` after a success. */
function createFailureStreak(controller: Pick<AppController, "log">): {
  reset(): void;
  catchWith(label: string): (error: unknown) => void;
} {
  let failing = false;
  return {
    reset: () => {
      failing = false;
    },
    catchWith: (label) => (error) => {
      if (failing) return;
      failing = true;
      controller.log(`${label}: ${safeErrorMessage(error)}`);
    },
  };
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
      void closeNowPlayingLeavingFullscreen();
      return true;
    case "toggleFullscreen":
      // The compact window keeps its size; fullscreen would ignore it.
      if (ui.miniPlayer) return false;
      void toggleWindowFullscreen().catch(reportActionError);
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

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
      const miniActive = getState().ui.miniPlayer === true;
      if (
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key.toLowerCase() === "m"
      ) {
        // Entering is blocked while typing or in a dialog; leaving never is.
        if (
          !miniActive &&
          (isEditableTarget(event.target) || hasOpenDialog())
        ) {
          return;
        }
        event.preventDefault();
        void toggleMiniPlayer().catch(reportActionError);
        return;
      }
      if (
        miniActive &&
        event.key === "Escape" &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.metaKey
      ) {
        if (isEditableTarget(event.target) || hasOpenDialog()) return;
        event.preventDefault();
        void exitMiniPlayer().catch(reportActionError);
        return;
      }
      const action = shortcutFor(event);
      if (action && runShortcut(controller, action)) {
        event.preventDefault();
      } else if (isShortcutOverlayKey(event)) {
        // Typing `?` in a field or stacking on another dialog must not open it.
        // The overlay is not rendered in mini mode, so it cannot open there.
        if (miniActive || isEditableTarget(event.target) || hasOpenDialog()) {
          return;
        }
        event.preventDefault();
        setShortcutsOpen(true);
      } else if (
        event.ctrlKey &&
        event.shiftKey &&
        event.key.toLowerCase() === "d"
      ) {
        if (!import.meta.env.DEV) return;
        event.preventDefault();
        setUiState({ diagnosticsOpen: !getState().ui.diagnosticsOpen });
      } else if (
        event.ctrlKey &&
        event.key.toLowerCase() === "k" &&
        !miniActive
      ) {
        if (hasOpenDialog()) return;
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
        if (hasOpenDialog()) return;
        event.preventDefault();
        void controller
          .refreshCurrentData()
          .catch(logFailure(controller, "Refresh failed"));
      } else if (event.altKey && event.key === "ArrowLeft") {
        if (hasOpenDialog()) return;
        event.preventDefault();
        router.back();
      } else if (event.altKey && event.key === "ArrowRight") {
        if (hasOpenDialog()) return;
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
    void listenBeforeQuit(() => controller.prepareToQuit())
      .then((unlisten) => {
        if (active) stop = unlisten;
        else unlisten();
      })
      .catch(logFailure(controller, "Quit listener failed to start"));
    return () => {
      active = false;
      stop?.();
    };
  }, [controller]);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void listenWindowsMediaControls((control) => {
      const run: Record<WindowsMediaControl, () => unknown> = {
        play: () => controller.play(),
        pause: () => controller.pause(),
        next: () => controller.next(),
        previous: () => controller.previous(),
      };
      void Promise.resolve()
        .then(run[control])
        .catch(logFailure(controller, `Media control ${control} failed`));
    })
      .then((unlisten) => {
        if (active) stop = unlisten;
        else unlisten();
      })
      .catch(logFailure(controller, "Media control listener failed to start"));
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
        .catch(
          logFailure(controller, "Media control listener failed to start"),
        );
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
          void Promise.resolve()
            .then(() => controller.seek(target))
            .catch(logFailure(controller, "Media control seek failed"));
        }
      }),
    );
    track(
      listenWindowsMediaShuffle((enabled) => {
        if (!ready()) return;
        void Promise.resolve()
          .then(() => controller.setShuffleMode(enabled ? "songs" : "off"))
          .catch(logFailure(controller, "Media control shuffle failed"));
      }),
    );
    track(
      listenWindowsMediaRepeat((mode) => {
        if (!ready()) return;
        void Promise.resolve()
          .then(() => controller.setRepeatMode(mode))
          .catch(logFailure(controller, "Media control repeat failed"));
      }),
    );
    return () => {
      active = false;
      for (const stop of stops) stop();
    };
  }, [controller]);

  useEffect(() => {
    const streak = createFailureStreak(controller);
    const onFailure = streak.catchWith("Timeline update failed");
    const sync = createTimelineSync((timeline) => {
      void updateWindowsMediaTimeline(timeline).then(streak.reset, onFailure);
    });
    return subscribePlaybackPosition(() => {
      const { positionSeconds, durationSeconds, status } = getState().playback;
      sync({ positionSeconds, durationSeconds, playing: status === "playing" });
    });
  }, [controller]);

  if (state.ui.miniPlayer) {
    // Only the visible layout changes: playback sync and toasts stay mounted.
    // The notices and modals keep their state in the store and show again on exit.
    return (
      <>
        <MediaSessionSync />
        <MiniPlayer />
        <ActionToasts />
      </>
    );
  }

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
      <SongInfoDialog />
      {shortcutsOpen ? (
        <ShortcutOverlay onClose={() => setShortcutsOpen(false)} />
      ) : null}
      <ActionToasts />
      <div className="notice-stack">
        <SessionExpiredNotice />
        <PreviewNotice />
        <TokenExpiryNotice />
      </div>
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
