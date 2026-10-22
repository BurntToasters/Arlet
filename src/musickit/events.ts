import {
  getState,
  setPlaybackStatus,
  setCurrentTrack,
  setPlaybackPosition,
  setPlaybackError,
} from "../state.ts";
import { normalizeTrack } from "./normalize.ts";
import { friendlyPlaybackMessage, mapErrorToCode } from "./errors.ts";
import { redactSensitive } from "../platform/redact.ts";
import type { PlaybackState } from "../domain/music.ts";
import { syncMusicKitQueue } from "./player.ts";
import {
  isLiveMediaItem,
  liveMetadataFromEvent,
  setLiveMetadata,
} from "./live-metadata.ts";

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Some runtimes omit newer events (the E2E fixture does), so each optional
 * name is looked up and only registered when it is a string.
 */
function optionalEventName(key: string): string | undefined {
  const name = (MusicKit.Events as Record<string, unknown>)[key];
  return typeof name === "string" ? name : undefined;
}

/** Callbacks for events whose meaning belongs to the controller. */
export interface MusicKitEventHandlers {
  /** Authorization changed. Read `instance.isAuthorized` for the new state. */
  onAuthorizationChange?: () => void;
  /** MusicKit reported a volume. The caller decides whether it is new. */
  onMusicVolumeChange?: (volume: number) => void;
  /**
   * True while a parked queue stands for a stopped player, so MusicKit's stop
   * and now-playing echoes must not overwrite it.
   */
  ignoreProviderPlayback?: () => boolean;
}

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
  onPlaybackError?: (message: string, error: unknown) => void,
  onQueueChange?: () => void,
  onModeChange?: () => void,
  handlers: MusicKitEventHandlers = {},
): () => void {
  const ignored = (): boolean => handlers.ignoreProviderPlayback?.() === true;
  const onPlaybackStateChange = (event: Record<string, unknown>): void => {
    if (ignored()) return;
    // `oldState` is the state being left; without `state`, ask the player.
    const state =
      typeof event.state === "number" ? event.state : instance.playbackState;
    if (typeof state === "number") setPlaybackStatus(mapPlaybackState(state));
    onStateChange?.();
  };
  let lastItemId: string | undefined;
  const onNowPlayingItemChange = (event: Record<string, unknown>): void => {
    if (ignored()) return;
    const item = (event.item ?? null) as MusicKit.MediaItem | null;
    // Live text belongs to one stream. Drop it when the item changes, and
    // always when the new item is not live.
    if (!item || !isLiveMediaItem(item) || item.id !== lastItemId) {
      setLiveMetadata(undefined);
    }
    lastItemId = item?.id;
    const queueWasSynced = item ? syncMusicKitQueue(instance, event) : false;
    if (item && !queueWasSynced) {
      setCurrentTrack(normalizeTrack(item));
    } else if (!item) {
      setCurrentTrack(undefined);
    }
    onStateChange?.();
  };
  // Ticks arrive several times a second; listeners only care when the
  // duration (and so the preview/full classification) changes.
  let lastDuration: number | undefined;
  const onPlaybackTimeChange = (event: Record<string, unknown>): void => {
    if (ignored()) return;
    // NaN before metadata loads would also defeat the duration check below.
    const position = finiteOrZero(event.currentPlaybackTime);
    const duration = finiteOrZero(event.currentPlaybackDuration);
    setPlaybackPosition(position, duration);
    if (duration === lastDuration) return;
    lastDuration = duration;
    onStateChange?.();
  };
  // Duration can arrive after the first ticks, when metadata finishes loading.
  // It goes through the same tick channel, keeping the last reported position.
  const onPlaybackDurationChange = (event: Record<string, unknown>): void => {
    if (ignored()) return;
    const duration = firstFiniteNumber(
      event.currentPlaybackDuration,
      event.duration,
      instance.currentPlaybackDuration,
    );
    if (duration === undefined) return;
    setPlaybackPosition(getState().playback.positionSeconds, duration);
    if (duration === lastDuration) return;
    lastDuration = duration;
    onStateChange?.();
  };
  const onMediaPlaybackError = (event: Record<string, unknown>): void => {
    if (ignored()) return;
    const safeMessage = redactSensitive(
      friendlyPlaybackMessage({
        ...event,
        message: String(event.message ?? "Playback error"),
      }),
    );
    setPlaybackError(mapErrorToCode(event), safeMessage);
    onPlaybackError?.(safeMessage, event);
    onStateChange?.();
  };

  const onQueueItemsChange = (event: Record<string, unknown>): void => {
    if (ignored()) return;
    if (syncMusicKitQueue(instance, event)) onQueueChange?.();
    onStateChange?.();
  };

  const onPlaybackModeChange = (): void => {
    onModeChange?.();
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

  // Queue data can appear only after playback starts, so register the event
  // whenever the runtime advertises it. The handler safely ignores hidden
  // queue shapes and the controller maintains a deterministic local fallback.
  if (typeof MusicKit.Events.queueItemsDidChange === "string") {
    listeners.push({
      name: MusicKit.Events.queueItemsDidChange,
      callback: onQueueItemsChange,
    });
  }

  // Shuffle moves the queue position after reordering the items.
  const queuePositionDidChange = (MusicKit.Events as Record<string, unknown>)
    .queuePositionDidChange;
  if (typeof queuePositionDidChange === "string") {
    listeners.push({
      name: queuePositionDidChange,
      callback: () => onQueueItemsChange({}),
    });
  }

  for (const name of [
    (MusicKit.Events as Record<string, unknown>).shuffleModeDidChange,
    (MusicKit.Events as Record<string, unknown>).repeatModeDidChange,
  ]) {
    if (typeof name === "string") {
      listeners.push({ name, callback: onPlaybackModeChange });
    }
  }

  const durationName = optionalEventName("playbackDurationDidChange");
  if (durationName) {
    listeners.push({
      name: durationName,
      callback: onPlaybackDurationChange,
    });
  }

  // Sign-out from another app or a revoked token reports here. The handler
  // checks `isAuthorized` itself; this only forwards the change.
  const authorizationName = optionalEventName("authorizationStatusDidChange");
  if (authorizationName) {
    listeners.push({
      name: authorizationName,
      callback: () => handlers.onAuthorizationChange?.(),
    });
  }

  // Reports every level MusicKit exposes, including echoes of levels this app
  // wrote. The caller tells those apart from outside changes.
  const volumeName = optionalEventName("playbackVolumeDidChange");
  if (volumeName) {
    listeners.push({
      name: volumeName,
      callback: (event) => {
        const volume = firstFiniteNumber(event.volume, instance.volume);
        if (volume !== undefined) handlers.onMusicVolumeChange?.(volume);
      },
    });
  }

  // Live radio reports "now playing" text through timed metadata. Some
  // runtimes call it `metadataDidChange` instead; the first name present wins
  // so the same report is not handled twice.
  const metadataName =
    optionalEventName("timedMetadataDidChange") ??
    optionalEventName("metadataDidChange");
  if (metadataName) {
    listeners.push({
      name: metadataName,
      callback: (event) => {
        const metadata = liveMetadataFromEvent(event);
        if (metadata) setLiveMetadata(metadata);
      },
    });
  }

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
