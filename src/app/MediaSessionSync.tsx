import { useEffect } from "preact/hooks";
import type { JSX } from "preact";
import { useAppSlices } from "./context.tsx";
import {
  clearWindowsMediaSession,
  updateWindowsMediaSession,
} from "../platform/windows-media.ts";

/**
 * Mirrors the playback state into the Windows media session. It renders
 * nothing, so its playback subscription does not re-render the app shell.
 */
export function MediaSessionSync(): JSX.Element | null {
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
      void clearWindowsMediaSession().catch(() => undefined);
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
      // More of a long playlist is still to be added after the last song.
      nextEnabled: queueIndex < queueLength - 1 || queueRest > 0,
      // Previous restarts the song or steps back into the playlist, as the
      // in-app button does; a Play always starts at queue index 0.
      previousEnabled: true,
      shuffle: shuffleMode === "songs",
      repeat: repeatMode ?? "off",
    }).catch(() => undefined);
  }, [
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
