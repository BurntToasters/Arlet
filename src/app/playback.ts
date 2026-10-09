import { mapErrorToCode } from "../musickit/errors.ts";
import {
  queueOptionsForTracks,
  changeToMediaAtIndex,
  readMusicKitQueue,
  readPlaybackModes,
  type NormalizedRepeatMode,
  seekToTime,
  setRepeatMode as setMusicRepeatMode,
  setShuffleMode as setMusicShuffleMode,
  setVolume as setMusicVolume,
  skipToNext,
  skipToPrevious,
  syncMusicKitQueue,
  toggle,
} from "../musickit/player.ts";
import { isSameTrack, type Station, type Track } from "../domain/music.ts";
import { normalizeTrack } from "../musickit/normalize.ts";
import {
  editQueue,
  planClear,
  planMove,
  planRemove,
  type QueueEditPlan,
  type QueueEditTier,
} from "../musickit/queue-edit.ts";
import {
  clearPlaybackError,
  DEFAULT_SETTINGS,
  getState,
  setCurrentTrack,
  setMuted,
  setPlaybackError,
  setPlaybackModes,
  setPlaybackPosition,
  setPlaybackStatus,
  setQueue,
  setQueueSnapshot,
  setVolume,
} from "../state.ts";
import {
  errorMessage,
  materializeTracks,
  safeErrorMessage,
  sameTrackIds,
  trackIds,
  type ControllerContext,
} from "./controller-support.ts";

type QueueInsertMethod = "playNext" | "playLater";

/** Queue and transport commands over the MusicKit instance. */
export function createPlayback(context: ControllerContext) {
  const { requireMusic, getMusic, log } = context;

  const reportPlayFailure = (label: string, error: unknown): void => {
    const message = safeErrorMessage(error);
    setPlaybackError(mapErrorToCode(errorMessage(error)), message);
    log(`${label}: ${message}`);
  };

  /** Sets the unmuted level. Any explicit volume change also unmutes. */
  const applyPlaybackVolume = (volume: number): number => {
    const safeVolume = Number.isFinite(volume)
      ? Math.max(0, Math.min(1, volume))
      : DEFAULT_SETTINGS.volume;
    if (getState().playback.muted) setMuted(false);
    setVolume(safeVolume);
    const music = getMusic();
    if (music) setMusicVolume(music, safeVolume);
    return safeVolume;
  };

  const editQueueLogged = async (
    label: string,
    instance: MusicKit.MusicKitInstance,
    plan: (
      queue: readonly Track[],
      current: number,
    ) => QueueEditPlan | undefined,
  ): Promise<QueueEditTier> => {
    try {
      return await editQueue(instance, plan);
    } catch (error) {
      log(`${label}: ${errorMessage(error)}`);
      throw error;
    }
  };

  const syncPlaybackModes = (instance: MusicKit.MusicKitInstance): void => {
    const modes = readPlaybackModes(instance);
    setPlaybackModes({
      shuffleMode: modes.shuffleMode,
      repeatMode: modes.repeatMode,
      modeCapabilities: modes.capabilities,
    });
  };

  /** Writes a repeat mode; throws when the runtime cannot change it. */
  const applyRepeatMode = (
    instance: MusicKit.MusicKitInstance,
    mode: NormalizedRepeatMode,
  ): void => {
    const current = readPlaybackModes(instance);
    if (!current.capabilities.repeat) {
      throw new Error("Repeat is not available in this MusicKit runtime.");
    }
    if (!setMusicRepeatMode(instance, mode)) {
      setPlaybackModes({
        modeCapabilities: { ...current.capabilities, repeat: false },
      });
      throw new Error("Repeat could not be changed in this MusicKit runtime.");
    }
    syncPlaybackModes(instance);
  };

  /**
   * Index to select after `setQueue`, or undefined when MusicKit already sits
   * on the chosen song. With shuffle on, the provider order differs from
   * `queue`, so the song is located by ID instead of by `startIndex`.
   */
  const providerStartIndex = (
    instance: MusicKit.MusicKitInstance,
    queue: readonly Track[],
    startIndex: number,
  ): number | undefined => {
    const chosen = queue[startIndex];
    const provider = readMusicKitQueue(instance);
    if (!provider) return startIndex;
    const shuffled = readPlaybackModes(instance).shuffleMode === "songs";
    const atPosition = provider.items[provider.index];
    const onChosen =
      atPosition !== undefined &&
      isSameTrack(normalizeTrack(atPosition), chosen) &&
      (shuffled || provider.index === startIndex);
    if (onChosen) return undefined;
    if (!shuffled) return startIndex;
    const found = provider.items.findIndex((item) =>
      isSameTrack(normalizeTrack(item), chosen),
    );
    return found >= 0 ? found : startIndex;
  };

  const playTracks = async (
    tracks: readonly Track[],
    startIndex = 0,
  ): Promise<void> => {
    const instance = requireMusic();
    if (tracks.length === 0) throw new Error("Queue is empty");
    if (
      !Number.isInteger(startIndex) ||
      startIndex < 0 ||
      startIndex >= tracks.length
    ) {
      throw new Error("The selected song is unavailable.");
    }
    const needsExplicitSelection =
      startIndex > 0 || readPlaybackModes(instance).shuffleMode === "songs";
    const providerPlayer = (instance.player ?? instance) as unknown as Record<
      string,
      unknown
    >;
    const instanceRecord = instance as unknown as Record<string, unknown>;
    if (
      needsExplicitSelection &&
      typeof providerPlayer.changeToMediaAtIndex !== "function" &&
      typeof instanceRecord.changeToMediaAtIndex !== "function"
    ) {
      throw new Error(
        "Selecting a song in the MusicKit queue is not available in this runtime.",
      );
    }
    const queue = [...tracks];
    clearPlaybackError();
    setQueue(queue, startIndex);
    setPlaybackStatus("loading");
    try {
      // `startWith` positions the queue before MusicKit shuffles it, so the
      // chosen song stays first and the rest are shuffled after it.
      await instance.setQueue({
        ...queueOptionsForTracks(queue),
        startWith: startIndex,
      });
      if (needsExplicitSelection) {
        const index = providerStartIndex(instance, queue, startIndex);
        if (index !== undefined) {
          const selected = await changeToMediaAtIndex(instance, index);
          if (!selected) {
            throw new Error(
              "Selecting a song in the MusicKit queue is not available in this runtime.",
            );
          }
        }
      }
      await instance.play();
    } catch (error) {
      reportPlayFailure("Play failed", error);
      throw error;
    }
  };

  /**
   * Play Next / Play Later. The local snapshot is captured before crossing
   * the provider boundary: a queue event can replace app state while the
   * call is awaiting, so a post-await read would lose the insertion index
   * when MusicKit does not expose its queue yet.
   */
  const insertTracks = async (
    method: QueueInsertMethod,
    tracks: readonly Track[] | readonly string[],
  ): Promise<void> => {
    const ids = trackIds(tracks);
    if (ids.length === 0) throw new Error("At least one track is required.");
    const normalizedTracks = materializeTracks(tracks);
    const currentQueue = getState().playback.queue;
    const currentIndex = getState().playback.queueIndex;
    if (currentQueue.length === 0) {
      await playTracks(normalizedTracks);
      return;
    }
    const beforeQueue = [...currentQueue];
    const snapshotIndex = Math.max(
      0,
      Math.min(currentIndex, beforeQueue.length - 1),
    );
    const expectedQueue = [...beforeQueue];
    if (method === "playNext") {
      expectedQueue.splice(snapshotIndex + 1, 0, ...normalizedTracks);
    } else {
      expectedQueue.push(...normalizedTracks);
    }
    const instance = requireMusic() as unknown as Record<string, unknown>;
    const insert = instance[method];
    if (typeof insert !== "function") {
      throw new Error(
        method === "playNext"
          ? "Play Next is not available in this MusicKit runtime."
          : "Play Later is not available in this MusicKit runtime.",
      );
    }
    const options =
      typeof tracks[0] === "string"
        ? { songs: ids }
        : queueOptionsForTracks(tracks as readonly Track[]);
    await (insert as (options: MusicKit.QueueOptions) => Promise<void>).call(
      instance,
      options,
    );
    const synced = syncMusicKitQueue(
      instance as unknown as MusicKit.MusicKitInstance,
    );
    // MusicKit can acknowledge the operation before publishing its updated
    // queue. Keep the provider snapshot when it contains the requested
    // mutation; otherwise use the captured local snapshot deterministically
    // until queueItemsDidChange reports the authoritative queue.
    if (synced && sameTrackIds(getState().playback.queue, expectedQueue)) {
      return;
    }
    setQueueSnapshot(expectedQueue, snapshotIndex);
  };

  return {
    applyPlaybackVolume,
    syncPlaybackModes,
    playTracks,

    async playStation(station: Station): Promise<void> {
      const url = station.url?.trim();
      if (!url) throw new Error("This station cannot be played.");
      const instance = requireMusic();
      clearPlaybackError();
      setPlaybackStatus("loading");
      try {
        await instance.setQueue({ url });
        await instance.play();
      } catch (error) {
        reportPlayFailure("Station play failed", error);
        throw error;
      }
    },

    playNextTracks: (tracks: readonly Track[] | readonly string[]) =>
      insertTracks("playNext", tracks),

    playLaterTracks: (tracks: readonly Track[] | readonly string[]) =>
      insertTracks("playLater", tracks),

    async playQueueItem(index: number): Promise<void> {
      const instance = requireMusic();
      syncMusicKitQueue(instance);
      const snapshot = getState().playback;
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= snapshot.queue.length
      ) {
        throw new Error("Queue item is unavailable.");
      }
      clearPlaybackError();
      setPlaybackStatus("loading");
      try {
        // Selecting in the provider queue keeps history and shuffle order.
        if (await changeToMediaAtIndex(instance, index)) {
          await instance.play();
          setQueueSnapshot(snapshot.queue, index);
          return;
        }
        log(
          "Queue selection unavailable; rebuilding the queue from the selected song.",
        );
        const queue = snapshot.queue.slice(index);
        await instance.setQueue(queueOptionsForTracks(queue));
        await instance.play();
        setQueue(queue, 0);
        setCurrentTrack(queue[0], 0);
      } catch (error) {
        reportPlayFailure("Queue item play failed", error);
        throw error;
      }
    },

    /** Mute keeps the unmuted level in `playback.volume` and silences the output. */
    toggleMute(): void {
      const muted = !getState().playback.muted;
      setMuted(muted);
      const music = getMusic();
      if (music) {
        setMusicVolume(music, muted ? 0 : getState().playback.volume);
      }
    },

    // Async so a missing MusicKit instance rejects instead of throwing into the caller.
    async removeQueueItem(index: number): Promise<QueueEditTier> {
      return editQueueLogged(
        "Queue remove failed",
        requireMusic(),
        (queue, current) => planRemove(queue, current, index),
      );
    },

    async moveQueueItem(from: number, to: number): Promise<QueueEditTier> {
      return editQueueLogged(
        "Queue move failed",
        requireMusic(),
        (queue, current) => planMove(queue, current, from, to),
      );
    },

    async clearUpNext(): Promise<QueueEditTier> {
      return editQueueLogged(
        "Queue clear failed",
        requireMusic(),
        (queue, current) => planClear(queue, current),
      );
    },

    async togglePlayback(): Promise<void> {
      try {
        await toggle(requireMusic());
      } catch (error) {
        log(`Toggle failed: ${errorMessage(error)}`);
        throw error;
      }
    },

    async play(): Promise<void> {
      await requireMusic().play();
    },

    async pause(): Promise<void> {
      requireMusic().pause();
    },

    async setShuffleMode(mode: "off" | "songs"): Promise<void> {
      const instance = requireMusic();
      if (!setMusicShuffleMode(instance, mode === "songs")) {
        const modes = readPlaybackModes(instance);
        setPlaybackModes({
          modeCapabilities: { ...modes.capabilities, shuffle: false },
        });
        throw new Error("Shuffle is not available in this MusicKit runtime.");
      }
      syncPlaybackModes(instance);
    },

    async cycleRepeatMode(): Promise<void> {
      const instance = requireMusic();
      const current = readPlaybackModes(instance);
      const next =
        current.repeatMode === "off"
          ? "all"
          : current.repeatMode === "all"
            ? "one"
            : "off";
      applyRepeatMode(instance, next);
    },

    async setRepeatMode(mode: NormalizedRepeatMode): Promise<void> {
      applyRepeatMode(requireMusic(), mode);
    },

    async previous(): Promise<void> {
      try {
        await skipToPrevious(requireMusic());
      } catch (error) {
        log(`Previous failed: ${errorMessage(error)}`);
        throw error;
      }
    },

    async next(): Promise<void> {
      try {
        await skipToNext(requireMusic());
      } catch (error) {
        log(`Next failed: ${errorMessage(error)}`);
        throw error;
      }
    },

    async seek(seconds: number): Promise<void> {
      const safeSeconds = Math.max(0, seconds);
      try {
        await seekToTime(requireMusic(), safeSeconds);
        setPlaybackPosition(safeSeconds, getState().playback.durationSeconds);
      } catch (error) {
        log(`Seek failed: ${errorMessage(error)}`);
        throw error;
      }
    },
  };
}
