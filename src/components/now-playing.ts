import { useEffect, useState } from "preact/hooks";
import { isSameTrack, type Track } from "../domain/music.ts";
import { getState, subscribe } from "../state.ts";

export type NowPlayingStatus = "none" | "playing" | "paused";

function statusFor(track: Track): NowPlayingStatus {
  const { current, status } = getState().playback;
  if (!isSameTrack(track, current)) return "none";
  if (status === "playing" || status === "loading") return "playing";
  if (status === "paused") return "paused";
  return "none";
}

/**
 * Whether `track` is the song playing now. A row re-renders only when its own
 * status changes, not on every app state update.
 */
export function useNowPlayingStatus(track: Track): NowPlayingStatus {
  const [status, setStatus] = useState(() => statusFor(track));
  useEffect(() => {
    setStatus(statusFor(track));
    return subscribe(() => setStatus(statusFor(track)));
  }, [track]);
  return status;
}
