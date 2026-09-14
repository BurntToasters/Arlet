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
  onPlaybackError?: (message: string) => void,
): () => void {
  const onPlaybackStateChange = (event: Record<string, unknown>): void => {
    const state = (event.state ?? event.oldState ?? 0) as number;
    setPlaybackStatus(mapPlaybackState(state));
    onStateChange?.();
  };
  const onNowPlayingItemChange = (event: Record<string, unknown>): void => {
    const item = (event.item ?? null) as MusicKit.MediaItem | null;
    if (item) {
      setCurrentTrack(normalizeTrack(item));
    } else {
      setCurrentTrack(undefined);
    }
    onStateChange?.();
  };
  const onPlaybackTimeChange = (event: Record<string, unknown>): void => {
    const position = (event.currentPlaybackTime ?? 0) as number;
    const duration = (event.currentPlaybackDuration ?? 0) as number;
    setPlaybackPosition(position, duration);
    onStateChange?.();
  };
  const onMediaPlaybackError = (event: Record<string, unknown>): void => {
    const message = String(event.message ?? "Playback error");
    const safeMessage = redactSensitive(message);
    setPlaybackError(mapErrorToCode(message), safeMessage);
    onPlaybackError?.(safeMessage);
    onStateChange?.();
  };

  const listeners: Array<{
    name: string;
    callback: (event: Record<string, unknown>) => void;
  }> = [
    {
      name: MusicKit.Events.playbackStateDidChange,
      callback: onPlaybackStateChange,
    },
    {
      name: MusicKit.Events.nowPlayingItemDidChange,
      callback: onNowPlayingItemChange,
    },
    {
      name: MusicKit.Events.playbackTimeDidChange,
      callback: onPlaybackTimeChange,
    },
    {
      name: MusicKit.Events.mediaPlaybackError,
      callback: onMediaPlaybackError,
    },
  ];

  for (const listener of listeners) {
    instance.addEventListener(listener.name, listener.callback);
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (typeof instance.removeEventListener !== "function") return;
    for (const listener of listeners) {
      instance.removeEventListener(listener.name, listener.callback);
    }
  };
}
