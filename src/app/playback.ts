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
  keptStartIndex,
  skippedMessage,
  withResolvableTracks,
} from "../musickit/unresolved.ts";
import { reportActionError } from "../components/action-errors.ts";
import {
  MAX_QUEUE_LENGTH,
  QUEUE_REFILL_SIZE,
  QUEUE_REFILL_THRESHOLD,
  shuffledCopy,
  windowQueue,
} from "./queue-window.ts";
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
  setQueueRest,
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
   * on the chosen song. MusicKit drops unplayable songs and, with shuffle on,
   * reorders the rest, so the chosen occurrence is located by ID.
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
    const matches: number[] = [];
    provider.items.forEach((item, index) => {
      if (isSameTrack(normalizeTrack(item), chosen)) matches.push(index);
    });
    if (matches.length === 0) return startIndex;
    // Without shuffle the order is kept, so pick the same duplicate occurrence.
    const occurrence = queue
      .slice(0, startIndex)
      .filter((track) => isSameTrack(track, chosen)).length;
    const expected = shuffled
      ? undefined
      : (matches[occurrence] ?? matches[matches.length - 1]);
    const onChosen = shuffled
      ? matches.includes(provider.index)
      : provider.index === expected;
    if (onChosen) return undefined;
    return expected ?? matches[0];
  };

  // Songs from a capped playlist not yet in the provider queue. A new
  // generation drops a pending refill for a queue that has been replaced.
  let queueRest: Track[] = [];
  let restGeneration = 0;
  let refilling = false;
  // Last song this playlist added. If the queue no longer holds it, the
  // queue was replaced elsewhere and the rest must not be appended.
  let restAnchor: Track | undefined;

  const setRest = (tracks: Track[], anchor?: Track): void => {
    queueRest = tracks;
    if (anchor) restAnchor = anchor;
    if (tracks.length === 0) restAnchor = undefined;
    setQueueRest(tracks.length);
  };

  const clearContinuation = (): void => {
    restGeneration += 1;
    setRest([]);
  };

  const playTracks = async (
    requestedTracks: readonly Track[],
    requestedStart = 0,
  ): Promise<void> => {
    const instance = requireMusic();
    if (requestedTracks.length === 0) throw new Error("Queue is empty");
    if (
      !Number.isInteger(requestedStart) ||
      requestedStart < 0 ||
      requestedStart >= requestedTracks.length
    ) {
      throw new Error("The selected song is unavailable.");
    }
    const shuffled = readPlaybackModes(instance).shuffleMode === "songs";
    const { tracks, startIndex, rest } = windowQueue(
      requestedTracks,
      requestedStart,
      shuffled,
    );
    clearContinuation();
    const generation = restGeneration;
    if (rest.length) {
      log(
        `Queued ${tracks.length} of ${requestedTracks.length} songs; the rest load as the queue plays.`,
      );
    }
    const needsExplicitSelection = startIndex > 0 || shuffled;
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
    clearPlaybackError();
    setQueue([...tracks], startIndex);
    setPlaybackStatus("loading");
    try {
      // MusicKit rejects the whole queue when any song cannot be resolved,
      // so unavailable songs are skipped and the rest retried.
      const { entries, skipped } = await withResolvableTracks(
        tracks,
        async (attempt) => {
          const queue = attempt.map((entry) => entry.track);
          // `startWith` positions the queue before MusicKit shuffles it, so
          // the chosen song stays first and the rest are shuffled after it.
          await instance.setQueue({
            ...queueOptionsForTracks(queue),
            startWith: keptStartIndex(attempt, startIndex),
          });
        },
      );
      const queue = entries.map((entry) => entry.track);
      const start = keptStartIndex(entries, startIndex);
      if (skipped.length) {
        log(`Skipped ${skipped.length} unavailable songs.`);
        setQueue(queue, start);
        const message = skippedMessage(skipped.length);
        if (message) reportActionError(new Error(message));
      }
      if (needsExplicitSelection || skipped.length) {
        const index = providerStartIndex(instance, queue, start);
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
      if (generation === restGeneration) setRest(rest, queue.at(-1));
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
  /** Resolves to the songs actually inserted, after unavailable ones are skipped. */
  const insertTracks = async (
    method: QueueInsertMethod,
    tracks: readonly Track[] | readonly string[],
  ): Promise<Track[]> => {
    const ids = trackIds(tracks);
    if (ids.length === 0) throw new Error("At least one track is required.");
    const allTracks = materializeTracks(tracks);
    // Same request limit as playTracks; the first songs are kept in order.
    const requestedTracks = allTracks.slice(0, MAX_QUEUE_LENGTH);
    if (requestedTracks.length < allTracks.length) {
      log(
        `Added the first ${requestedTracks.length} of ${allTracks.length} songs to stay within Apple's request limits.`,
      );
    }
    const currentQueue = getState().playback.queue;
    const currentIndex = getState().playback.queueIndex;
    if (currentQueue.length === 0) {
      await playTracks(requestedTracks);
      return requestedTracks;
    }
    const beforeQueue = [...currentQueue];
    const snapshotIndex = Math.max(
      0,
      Math.min(currentIndex, beforeQueue.length - 1),
    );
    const instance = requireMusic() as unknown as Record<string, unknown>;
    const insert = instance[method];
    if (typeof insert !== "function") {
      throw new Error(
        method === "playNext"
          ? "Play Next is not available in this MusicKit runtime."
          : "Play Later is not available in this MusicKit runtime.",
      );
    }
    const byId = typeof tracks[0] === "string";
    // One unavailable song would otherwise reject the whole insertion.
    const { entries, skipped } = await withResolvableTracks(
      requestedTracks,
      async (attempt) => {
        const options = byId
          ? { songs: attempt.map((entry) => entry.track.id) }
          : queueOptionsForTracks(attempt.map((entry) => entry.track));
        await (
          insert as (options: MusicKit.QueueOptions) => Promise<void>
        ).call(instance, options);
      },
    );
    const normalizedTracks = entries.map((entry) => entry.track);
    if (skipped.length) {
      log(`Skipped ${skipped.length} unavailable songs.`);
      const message = skippedMessage(skipped.length);
      if (message) reportActionError(new Error(message));
    }
    const expectedQueue = [...beforeQueue];
    if (method === "playNext") {
      expectedQueue.splice(snapshotIndex + 1, 0, ...normalizedTracks);
    } else {
      expectedQueue.push(...normalizedTracks);
    }
    const synced = syncMusicKitQueue(
      instance as unknown as MusicKit.MusicKitInstance,
    );
    // MusicKit can acknowledge the operation before publishing its updated
    // queue. Keep the provider snapshot when it contains the requested
    // mutation; otherwise use the captured local snapshot deterministically
    // until queueItemsDidChange reports the authoritative queue.
    if (synced && sameTrackIds(getState().playback.queue, expectedQueue)) {
      return normalizedTracks;
    }
    setQueueSnapshot(expectedQueue, snapshotIndex);
    return normalizedTracks;
  };

  /**
   * Appends the next songs of a capped playlist once fewer than
   * QUEUE_REFILL_THRESHOLD upcoming songs remain. Runs once at a time; a new
   * play or `Clear` drops a refill that is still in flight.
   */
  const maybeRefillQueue = (): void => {
    if (refilling || queueRest.length === 0) return;
    const { queue, queueIndex } = getState().playback;
    if (queue.length === 0) return;
    if (!queue.some((track) => isSameTrack(track, restAnchor))) {
      log("Queue was replaced; dropping the rest of the previous playlist.");
      clearContinuation();
      return;
    }
    if (queue.length - queueIndex - 1 >= QUEUE_REFILL_THRESHOLD) return;
    const generation = restGeneration;
    const chunk = queueRest.slice(0, QUEUE_REFILL_SIZE);
    const instance = getMusic();
    const shuffled =
      instance !== undefined &&
      instance !== null &&
      readPlaybackModes(instance).shuffleMode === "songs";
    refilling = true;
    let inserted: Track[] = [];
    void insertTracks("playLater", shuffled ? shuffledCopy(chunk) : chunk)
      .then((tracks) => {
        inserted = tracks;
      })
      .catch((error: unknown) => {
        log(`Queue refill failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        refilling = false;
        // The chunk is consumed even on failure so a bad page cannot loop.
        if (generation === restGeneration) {
          setRest(queueRest.slice(chunk.length), inserted.at(-1));
        }
      });
  };

  return {
    applyPlaybackVolume,
    syncPlaybackModes,
    playTracks,
    maybeRefillQueue,
    clearContinuation,

    async playStation(station: Station): Promise<void> {
      const url = station.url?.trim();
      const id = station.id.trim();
      if (!url && !id) throw new Error("This station cannot be played.");
      const instance = requireMusic();
      clearContinuation();
      clearPlaybackError();
      setPlaybackStatus("loading");
      try {
        await instance.setQueue(url ? { url } : { station: id });
        await instance.play();
      } catch (error) {
        reportPlayFailure("Station play failed", error);
        throw error;
      }
    },

    playNextTracks: async (
      tracks: readonly Track[] | readonly string[],
    ): Promise<void> => {
      await insertTracks("playNext", tracks);
    },

    playLaterTracks: async (
      tracks: readonly Track[] | readonly string[],
    ): Promise<void> => {
      await insertTracks("playLater", tracks);
    },

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
      // Clearing Up Next also drops the rest of a capped playlist.
      clearContinuation();
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
