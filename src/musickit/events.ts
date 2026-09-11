import {
  setPlaybackStatus,
  setCurrentTrack,
  setPlaybackPosition,
  setPlaybackError,
} from "../state.ts";
import { normalizeTrack } from "./normalize.ts";
import { mapErrorToCode } from "./errors.ts";
import { redactSensitive } from "../platform/redact.ts";
import type { PlaybackState } from "../domain/music.ts";

function mapPlaybackState(state: number): PlaybackState["status"] {
  const states = MusicKit.PlaybackStates;
  switch (state) {
    case states.playing:
      return "playing";
    case states.paused:
      return "paused";
    case states.loading:
    case states.waiting:
    case states.stalled:
    case states.seeking:
      return "loading";
    case states.stopped:
    case states.ended:
    case states.completed:
      return "stopped";
    default:
      return "idle";
  }
}

export function registerMusicKitEvents(
  instance: MusicKit.MusicKitInstance,
  onStateChange?: () => void,
): void {
  instance.addEventListener(
    MusicKit.Events.playbackStateDidChange,
    (event: Record<string, unknown>) => {
      const state = (event.state ?? event.oldState ?? 0) as number;
      setPlaybackStatus(mapPlaybackState(state));
      onStateChange?.();
    },
  );

  instance.addEventListener(
    MusicKit.Events.nowPlayingItemDidChange,
    (event: Record<string, unknown>) => {
      const item = (event.item ?? null) as MusicKit.MediaItem | null;
      if (item) {
        setCurrentTrack(normalizeTrack(item));
      } else {
        setCurrentTrack(undefined);
      }
      onStateChange?.();
    },
  );

  instance.addEventListener(
    MusicKit.Events.playbackTimeDidChange,
    (event: Record<string, unknown>) => {
      const position = (event.currentPlaybackTime ?? 0) as number;
      const duration = (event.currentPlaybackDuration ?? 0) as number;
      setPlaybackPosition(position, duration);
      onStateChange?.();
    },
  );

  instance.addEventListener(
    MusicKit.Events.mediaPlaybackError,
    (event: Record<string, unknown>) => {
      const message = String(
        (event as Record<string, unknown>).message ?? "Playback error",
      );
      setPlaybackError(mapErrorToCode(message), redactSensitive(message));
      onStateChange?.();
    },
  );
}
