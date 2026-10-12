import { httpStatusOf, mapErrorToCode } from "../musickit/errors.ts";
import {
  queueDescriptorsForTracks,
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
  NONE_AVAILABLE_MESSAGE,
  skippedMessage,
  unresolvedIds,
  withResolvableTracks,
} from "../musickit/unresolved.ts";
import { reportActionError } from "../components/action-errors.ts";
import type { PlayTiming } from "./collection-playback.ts";
import {
  FIRST_BATCH_LENGTH,
  MAX_QUEUE_LENGTH,
  nearestTrackIndex,
  QUEUE_REFILL_SIZE,
  QUEUE_REFILL_THRESHOLD,
  shuffledCopy,
  startWindow,
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
  setPendingRestore,
  setPlaybackStatus,
  setQueue,
  setQueueRest,
  setQueueSnapshot,
  setVolume,
  subscribe,
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
/** A Play that is not audible by then is not timed. */
const PLAY_TIMING_TIMEOUT_MS = 60_000;
/** Previous restarts the song after this many seconds, as in Apple Music. */
const RESTART_THRESHOLD_SECONDS = 3;
/** First batches tried when every song in one is unavailable. */
const MAX_UNAVAILABLE_BATCHES = 4;
/** Pause before retrying a queue setup that failed on a song lookup. */
const SET_QUEUE_RETRY_DELAY_MS = 600;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A lookup that returned no usable body, as opposed to a real refusal. */
function isTransientLookupFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const status = httpStatusOf(error);
  return (
    /Unable to read body as JSON/iu.test(message) ||
    status === 429 ||
    (status !== undefined && status >= 500)
  );
}

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
      // A rebuild drops unplayable songs; say so like the other play paths.
      return await editQueue(instance, plan, (count) => {
        log(`Skipped ${count} unavailable songs.`);
        const message = skippedMessage(count);
        if (message) reportActionError(new Error(message));
      });
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
  // Songs before the one a Play started at. MusicKit's queue begins at that
  // song, so Previous on it steps back through these instead. Valid while
  // the queue still starts with `historyAnchor`.
  let startHistory: Track[] = [];
  let historyAnchor: Track | undefined;

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

  /**
   * Logs how long a Play took from the request to audible playback, step by
   * step, so slow starts can be diagnosed from a support report. Gives up
   * quietly if the play is replaced or nothing plays within the timeout.
   */
  const logWhenAudible = (
    request: ReturnType<typeof beginPlayRequest>,
    startedAt: number,
    steps: readonly string[],
  ): void => {
    let stop = (): void => undefined;
    const check = (): void => {
      if (!request.current()) {
        stop();
        return;
      }
      if (getState().playback.status !== "playing") return;
      stop();
      log(
        `Play timing: audible after ${Math.round(performance.now() - startedAt)}ms (${steps.join(", ")}).`,
      );
    };
    const unsubscribe = subscribe(check);
    const timer = setTimeout(() => stop(), PLAY_TIMING_TIMEOUT_MS);
    stop = () => {
      unsubscribe();
      clearTimeout(timer);
    };
    check();
  };

  const playTracks = async (
    requestedTracks: readonly Track[],
    requestedStart = 0,
    timing?: PlayTiming,
  ): Promise<number | undefined> => {
    const startedAt = timing?.startedAt ?? performance.now();
    const steps = [...(timing?.steps ?? [])];
    let stepStartedAt = performance.now();
    const step = (name: string): void => {
      const now = performance.now();
      steps.push(`${name} ${Math.round(now - stepStartedAt)}ms`);
      stepStartedAt = now;
    };
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
    const split = startWindow(requestedTracks, requestedStart, shuffled);
    let batch = split.batch;
    let rest = split.rest;
    clearContinuation();
    const generation = restGeneration;
    const request = beginPlayRequest();
    if (rest.length) {
      log(
        `Queued ${batch.length} of ${requestedTracks.length} songs; the rest load as the queue plays.`,
      );
    }
    clearPlaybackError();
    let batchStart = split.startIndex;
    setQueue([...batch], batchStart);
    // The previous song's position would otherwise show until MusicKit's
    // first time event, and Previous would read it as past the restart point.
    setPlaybackPosition(0, (batch[batchStart]?.durationMs ?? 0) / 1000);
    setPlaybackStatus("loading");
    try {
      // MusicKit's queue starts at the chosen song, so it never prepares a
      // different item first. A batch with no playable song moves on to the
      // next one rather than failing a Play that later songs could satisfy.
      let resolved: Awaited<ReturnType<typeof withResolvableTracks>>;
      let usedDetails = false;
      const skippedBefore: Track[] = [];
      for (let attempt = 1; ; attempt += 1) {
        try {
          resolved = await withResolvableTracks(batch, async (entries) => {
            const queued = entries.map((entry) => entry.track);
            const startWith = keptStartIndex(entries, batchStart);
            const options = { ...queueOptionsForTracks(queued), startWith };
            // Song details skip MusicKit's lookup; IDs are the fallback.
            const detailed = queueDescriptorsForTracks(queued);
            if (detailed) {
              try {
                await instance.setQueue({ ...detailed, startWith });
                usedDetails = true;
                return;
              } catch (error) {
                // Named unavailable songs go to the skip logic as with IDs.
                if (!request.current() || unresolvedIds(error)) throw error;
                log(
                  `Queue setup with song details failed; using IDs: ${errorMessage(error)}`,
                );
              }
            }
            usedDetails = false;
            try {
              await instance.setQueue(options);
            } catch (error) {
              // One of MusicKit's song lookups can fail with an empty or
              // HTML body (Apple throttling); try once more.
              if (!isTransientLookupFailure(error) || !request.current()) {
                throw error;
              }
              log(`Queue setup failed once; retrying: ${errorMessage(error)}`);
              await delay(SET_QUEUE_RETRY_DELAY_MS);
              // A newer Play during the pause owns MusicKit's queue now.
              if (!request.current()) throw error;
              await instance.setQueue(options);
            }
          });
          break;
        } catch (error) {
          const unavailable =
            error instanceof Error && error.message === NONE_AVAILABLE_MESSAGE;
          if (
            !unavailable ||
            rest.length === 0 ||
            attempt >= MAX_UNAVAILABLE_BATCHES ||
            !request.current()
          ) {
            throw error;
          }
          skippedBefore.push(...batch);
          batch = rest.slice(0, FIRST_BATCH_LENGTH);
          rest = rest.slice(FIRST_BATCH_LENGTH);
          batchStart = 0;
          if (request.current()) setQueue([...batch], 0);
        }
      }
      step(`setQueue (${batch.length} songs${usedDetails ? ", details" : ""})`);
      const queue = resolved.entries.map((entry) => entry.track);
      const start = keptStartIndex(resolved.entries, batchStart);
      const skipped = [...skippedBefore, ...resolved.skipped];
      if (skipped.length) {
        log(`Skipped ${skipped.length} unavailable songs.`);
        if (request.current()) {
          setQueue(queue, start);
          const message = skippedMessage(skipped.length);
          if (message) reportActionError(new Error(message));
        }
      }
      if (request.current()) {
        startHistory = split.history;
        historyAnchor = queue[start];
      }
      // Normally undefined: MusicKit already sits on the chosen song. Kept
      // as a safety net for a runtime that reorders or drops items, and shows
      // as a "select" step in the timing log when it is needed.
      const index = providerStartIndex(instance, queue, start);
      if (index !== undefined && request.current()) {
        const selected = await changeToMediaAtIndex(instance, index);
        if (!selected) {
          throw new Error(
            "Selecting a song in the MusicKit queue is not available in this runtime.",
          );
        }
        step("select");
      }
      // The rest of the playlist is still recorded below for a paused queue.
      await startAudio(instance, request);
      step("play()");
      if (generation === restGeneration) {
        setRest(rest, queue.at(-1));
        // The first batch is under the refill threshold; append the next
        // songs now rather than on MusicKit's next event.
        maybeRefillQueue();
      }
      logWhenAudible(request, startedAt, steps);
      // Identifies this Play's queue for later pages (`appendContinuation`);
      // undefined once a newer Play replaced it.
      return request.current() && generation === restGeneration
        ? generation
        : undefined;
    } catch (error) {
      // A superseded or signed-out play reports nothing.
      if (!request.current()) return undefined;
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

  /**
   * Appends songs that finished loading after their Play started (the later
   * pages of a playlist). `token` is `continuationToken()` from right after
   * that Play; a newer queue makes it stale and the songs are dropped.
   */
  const appendContinuation = (
    token: number,
    tracks: readonly Track[],
  ): void => {
    if (token !== restGeneration || tracks.length === 0) return;
    const anchor = restAnchor ?? getState().playback.queue.at(-1);
    if (!anchor) return;
    setRest([...queueRest, ...tracks], anchor);
    maybeRefillQueue();
  };

  return {
    applyPlaybackVolume,
    syncPlaybackModes,
    playTracks,
    maybeRefillQueue,
    clearContinuation,
    appendContinuation,
    /** Identifies the current queue for `appendContinuation`. */
    continuationToken: (): number => restGeneration,

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
    /**
     * `trackId` is the song the user chose. The queue can shift while a menu
     * is open, so the index is re-checked and the nearest copy is removed.
     */
    async removeQueueItem(
      index: number,
      trackId?: string,
    ): Promise<QueueEditTier> {
      return editQueueLogged(
        "Queue remove failed",
        requireMusic(),
        (queue, current) => {
          const target =
            trackId === undefined
              ? index
              : nearestTrackIndex(queue, index, trackId);
          return target < 0 ? undefined : planRemove(queue, current, target);
        },
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
        // A restored queue has no MusicKit queue to step back in yet.
        const { pendingRestore, queue, queueIndex, positionSeconds } =
          getState().playback;
        if (pendingRestore && queue.length > 0) {
          await playTracks(queue, Math.max(0, queueIndex - 1));
          return;
        }
        // On the song a Play started at, step back into the songs before
        // it. Past the first seconds, Previous restarts the song instead.
        const onStartSong =
          queueIndex === 0 &&
          positionSeconds < RESTART_THRESHOLD_SECONDS &&
          queue[0] !== undefined &&
          isSameTrack(queue[0], historyAnchor);
        if (onStartSong && startHistory.length > 0) {
          const history = startHistory;
          await playTracks(
            [...history, ...queue, ...queueRest],
            history.length - 1,
          );
          return;
        }
        await skipToPrevious(requireMusic());
      } catch (error) {
        log(`Previous failed: ${errorMessage(error)}`);
        throw error;
      }
    },

    async next(): Promise<void> {
      try {
        const { pendingRestore, queue, queueIndex } = getState().playback;
        if (pendingRestore && queue.length > 0) {
          // Past the last song there is nothing to skip to, as in MusicKit.
          if (queueIndex + 1 < queue.length) {
            await playTracks(queue, queueIndex + 1);
          }
          return;
        }
        await skipToNext(requireMusic());
      } catch (error) {
        log(`Next failed: ${errorMessage(error)}`);
        throw error;
      }
    },

    async seek(seconds: number): Promise<void> {
      if (!Number.isFinite(seconds)) return;
      const safeSeconds = Math.max(0, seconds);
      const { pendingRestore, durationSeconds } = getState().playback;
      if (pendingRestore) {
        // Nothing is loaded yet; resume starts from the new position.
        setPendingRestore({ ...pendingRestore, positionSeconds: safeSeconds });
        setPlaybackPosition(safeSeconds, durationSeconds);
        return;
      }
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
