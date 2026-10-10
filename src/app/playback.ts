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
      // A restored queue has no MusicKit queue until Play; edit the snapshot.
      if (getState().playback.pendingRestore) {
        const { queue, queueIndex } = getState().playback;
        const edit = plan(queue, queueIndex);
        if (!edit) return "noop";
        setQueue(edit.next, queueIndex);
        // Nothing is playing yet, so no audio restarts.
        return "native";
      }
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

  // Bumped by a newer play, sign-out, or authorization. A play it supersedes
  // must not write playback state or report errors.
  let playIntent = 0;
  // Bumped by a pause. A play still awaiting queue setup must not start audio.
  let pauseCount = 0;
  // `pauseCount` when the user last pressed play. A play pressed after the
  // latest pause is the user's last word, so setup may still start audio.
  let playPressedAt = -1;
  const pauseListeners = new Set<() => void>();

  const cancelPendingPlayback = (): void => {
    playIntent += 1;
  };

  const pausePlayback = (): void => {
    pauseCount += 1;
    if (getState().playback.status === "loading") setPlaybackStatus("paused");
    for (const listener of pauseListeners) listener();
  };

  /** One play request. `current` gates state writes; `mayStart` gates audio. */
  const beginPlayRequest = () => {
    const intent = ++playIntent;
    const pauses = pauseCount;
    return {
      current: (): boolean => intent === playIntent,
      mayStart: (): boolean =>
        intent === playIntent &&
        (pauses === pauseCount || playPressedAt === pauseCount),
    };
  };

  /**
   * Starts audio only while the request may. A request paused during setup
   * stays paused, even if MusicKit started playing after its selection.
   */
  const startAudio = async (
    instance: MusicKit.MusicKitInstance,
    request: ReturnType<typeof beginPlayRequest>,
  ): Promise<void> => {
    if (request.mayStart()) await instance.play();
    else if (request.current()) instance.pause();
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
    const request = beginPlayRequest();
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
        if (request.current()) {
          setQueue(queue, start);
          const message = skippedMessage(skipped.length);
          if (message) reportActionError(new Error(message));
        }
      }
      if (needsExplicitSelection || skipped.length) {
        const index = providerStartIndex(instance, queue, start);
        if (index !== undefined && request.current()) {
          const selected = await changeToMediaAtIndex(instance, index);
          if (!selected) {
            throw new Error(
              "Selecting a song in the MusicKit queue is not available in this runtime.",
            );
          }
        }
      }
      // The rest of the playlist is still recorded below for a paused queue.
      await startAudio(instance, request);
      if (generation === restGeneration) setRest(rest, queue.at(-1));
    } catch (error) {
      // A superseded or signed-out play reports nothing.
      if (!request.current()) return;
      reportPlayFailure("Play failed", error);
      throw error;
    }
  };

  /**
   * Play Next / Play Later. The local snapshot is captured before crossing
   * the provider boundary: a queue event can replace app state while the
   * call is awaiting, so a post-await read would lose the insertion index
   * when MusicKit does not expose its queue yet. Resolves to the songs
   * actually inserted; `quiet` logs skipped songs instead of showing a toast.
   */
  const insertTracks = async (
    method: QueueInsertMethod,
    tracks: readonly Track[] | readonly string[],
    options: { quiet?: boolean; isCurrent?: () => boolean } = {},
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
    // A restored queue has no MusicKit queue until Play, so only the saved
    // snapshot changes. Provider calls would otherwise hit an empty queue.
    const restoring = getState().playback.pendingRestore !== undefined;
    const instance = restoring
      ? undefined
      : (requireMusic() as unknown as Record<string, unknown>);
    const insert = instance?.[method];
    if (instance && typeof insert !== "function") {
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
        if (!instance || typeof insert !== "function") return;
        // A refill for a queue that was replaced must not reach the provider.
        if (options.isCurrent?.() === false) return;
        const queueOptions = byId
          ? { songs: attempt.map((entry) => entry.track.id) }
          : queueOptionsForTracks(attempt.map((entry) => entry.track));
        await (
          insert as (options: MusicKit.QueueOptions) => Promise<void>
        ).call(instance, queueOptions);
      },
    );
    if (options.isCurrent?.() === false) return [];
    const normalizedTracks = entries.map((entry) => entry.track);
    if (skipped.length) {
      log(`Skipped ${skipped.length} unavailable songs.`);
      const message = skippedMessage(skipped.length);
      if (message && !options.quiet) reportActionError(new Error(message));
    }
    const expectedQueue = [...beforeQueue];
    if (method === "playNext") {
      expectedQueue.splice(snapshotIndex + 1, 0, ...normalizedTracks);
    } else {
      expectedQueue.push(...normalizedTracks);
    }
    if (!instance) {
      setQueue(expectedQueue, snapshotIndex);
      return normalizedTracks;
    }
    // A replaced queue or a moved selection happened during the await. It is
    // newer than this insertion, so the captured snapshot must not overwrite
    // it. Checked before the provider sync, which may read a stale queue.
    const latest = getState().playback;
    if (
      !sameTrackIds(latest.queue, beforeQueue) ||
      latest.queueIndex !== currentIndex
    ) {
      return normalizedTracks;
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
    // A background refill never toasts; the user did not start it.
    void insertTracks("playLater", shuffled ? shuffledCopy(chunk) : chunk, {
      quiet: true,
      isCurrent: () => generation === restGeneration,
    })
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
      const request = beginPlayRequest();
      clearPlaybackError();
      setPlaybackStatus("loading");
      try {
        await instance.setQueue(url ? { url } : { station: id });
        await startAudio(instance, request);
      } catch (error) {
        // A superseded or signed-out station play reports nothing.
        if (!request.current()) return;
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
      // Checked before any sync or loading status: both would drop the restore.
      if (getState().playback.pendingRestore) {
        const saved = getState().playback.queue;
        if (!Number.isInteger(index) || index < 0 || index >= saved.length) {
          throw new Error("Queue item is unavailable.");
        }
        // Builds the provider queue from the saved snapshot at the chosen song.
        await playTracks(saved, index);
        return;
      }
      syncMusicKitQueue(instance);
      const snapshot = getState().playback;
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= snapshot.queue.length
      ) {
        throw new Error("Queue item is unavailable.");
      }
      const request = beginPlayRequest();
      clearPlaybackError();
      setPlaybackStatus("loading");
      try {
        // Selecting in the provider queue keeps history and shuffle order.
        if (await changeToMediaAtIndex(instance, index)) {
          await startAudio(instance, request);
          if (request.current()) setQueueSnapshot(snapshot.queue, index);
          return;
        }
        log(
          "Queue selection unavailable; rebuilding the queue from the selected song.",
        );
        const queue = snapshot.queue.slice(index);
        await instance.setQueue(queueOptionsForTracks(queue));
        await startAudio(instance, request);
        if (request.current()) {
          setQueue(queue, 0);
          setCurrentTrack(queue[0], 0);
        }
      } catch (error) {
        // A superseded or signed-out selection reports nothing.
        if (!request.current()) return;
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
      const tier = await editQueueLogged(
        "Queue clear failed",
        requireMusic(),
        (queue, current) => planClear(queue, current),
      );
      // Clearing Up Next also drops the rest of a capped playlist; a failed
      // clear keeps it.
      clearContinuation();
      return tier;
    },

    async togglePlayback(): Promise<void> {
      try {
        const instance = requireMusic();
        // A song still loading already shows as playing, so the press means
        // pause even though MusicKit has not started yet.
        if (getState().playback.status === "loading") {
          pausePlayback();
          instance.pause();
          return;
        }
        if (instance.playbackState === MusicKit.PlaybackStates.playing) {
          pausePlayback();
        } else {
          playPressedAt = pauseCount;
        }
        await toggle(instance);
      } catch (error) {
        log(`Toggle failed: ${errorMessage(error)}`);
        throw error;
      }
    },

    async play(): Promise<void> {
      const instance = requireMusic();
      playPressedAt = pauseCount;
      await instance.play();
    },

    async pause(): Promise<void> {
      const instance = requireMusic();
      pausePlayback();
      instance.pause();
    },

    /**
     * Runs on every pause so a pending playlist or station load can stop.
     * Returns a function that removes the listener.
     */
    onPause(listener: () => void): () => void {
      pauseListeners.add(listener);
      return () => pauseListeners.delete(listener);
    },

    /** Changes with every play request; tells a caller its play was replaced. */
    playIntent: (): number => playIntent,

    /** Supersedes a play still awaiting queue setup (sign-out, authorization). */
    cancelPendingPlayback,

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
