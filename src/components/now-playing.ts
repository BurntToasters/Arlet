import { useEffect, useState } from "preact/hooks";
import { isSameTrack, type Track } from "../domain/music.ts";
import { getState, subscribe } from "../state.ts";

export type NowPlayingStatus = "none" | "playing" | "paused";

type TrackIdentity = Pick<Track, "id" | "catalogId">;

function statusFor(track: TrackIdentity): NowPlayingStatus {
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
  // Only the identity fields decide a match, so a row rebuilt with the same
  // ids keeps its subscription instead of resubscribing.
  const { id, catalogId } = track;
  const [status, setStatus] = useState(() => statusFor({ id, catalogId }));
  useEffect(() => {
    const identity = { id, catalogId };
    setStatus(statusFor(identity));
    return subscribe(() => setStatus(statusFor(identity)));
  }, [id, catalogId]);
  return status;
}
