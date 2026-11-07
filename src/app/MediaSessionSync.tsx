import { useEffect, useMemo } from "preact/hooks";
import type { JSX } from "preact";
import { useAppController, useAppSlices } from "./context.tsx";
import {
  clearWindowsMediaSession,
  updateWindowsMediaSession,
} from "../platform/windows-media.ts";
import { safeErrorMessage } from "./controller-support.ts";
import type { AppController } from "./controller.ts";

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

/**
 * Mirrors the playback state into the Windows media session. It renders
 * nothing, so its playback subscription does not re-render the app shell.
 */
export function MediaSessionSync(): JSX.Element | null {
  const controller = useAppController();
  // One streak per mounted sync, so a persistent failure logs once.
  const streak = useMemo(() => createFailureStreak(controller), [controller]);
  const { playback } = useAppSlices("playback");
  const {
    current,
    status: playbackStatus,
    queueIndex,
    shuffleMode,
    repeatMode,
  } = playback;
  const queueLength = playback.queue.length;
  const queueRest = playback.queueRest ?? 0;
  useEffect(() => {
    if (
      !current ||
      playbackStatus === "idle" ||
      playbackStatus === "stopped" ||
      playbackStatus === "error"
    ) {
      void clearWindowsMediaSession().then(
        streak.reset,
        streak.catchWith("Media session clear failed"),
      );
      return;
    }
    void updateWindowsMediaSession({
      title: current.title,
      artist: current.artistName,
      album: current.albumTitle,
      artworkUrl: current.artwork?.url,
      playbackStatus: playbackStatus === "playing" ? "playing" : "paused",
      playEnabled: playbackStatus !== "playing",
      pauseEnabled: playbackStatus === "playing",
      // More of a long playlist is still to be added after the last song,
      // and Repeat All goes on from the last song to the first.
      nextEnabled:
        queueIndex < queueLength - 1 || queueRest > 0 || repeatMode === "all",
      // Previous restarts the song or steps back into the playlist, as the
      // in-app button does; a Play always starts at queue index 0.
      previousEnabled: true,
      shuffle: shuffleMode === "songs",
      repeat: repeatMode ?? "off",
    }).then(streak.reset, streak.catchWith("Media session update failed"));
  }, [
    streak,
    current,
    playbackStatus,
    queueIndex,
    queueLength,
    queueRest,
    shuffleMode,
    repeatMode,
  ]);
  return null;
}
