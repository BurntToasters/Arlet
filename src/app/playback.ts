import {
  beginSeek,
  changeToMediaAtIndex,
  endSeek,
  queueOptionsForTracks,
  readPlaybackModes,
  recordTransportIntent,
  type NormalizedRepeatMode,
  seekToTime,
  settleSeek,
  setRepeatMode as setMusicRepeatMode,
  setShuffleMode as setMusicShuffleMode,
  setVolume as setMusicVolume,
  skipToNext,
  skipToPrevious,
  syncMusicKitQueue,
  toggle,
} from "../musickit/player.ts";
import { isSameTrack, type Station, type Track } from "../domain/music.ts";
import {
  skippedMessage,
  withResolvableTracks,
} from "../musickit/unresolved.ts";
import { reportActionError } from "../components/action-errors.ts";
import { nearestTrackIndex, QUEUE_HISTORY_LENGTH } from "./queue-window.ts";
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
  setPendingRestore,
  setPlaybackModes,
  setPlaybackPosition,
  setPlaybackStatus,
  setQueue,
  setQueueSnapshot,
  setVolume,
} from "../state.ts";
import { errorMessage, type ControllerContext } from "./controller-support.ts";
import { createPlayRequests, createPlayTracks } from "./playback-play.ts";
import { createQueueInsert } from "./playback-insert.ts";
import { createQueueContinuation } from "./queue-continuation.ts";

/**
 * Mutable playback bookkeeping shared by the playback modules. One instance
 * exists per `createPlayback`; every module reads and writes these fields
 * through `PlaybackContext.session`, so no module keeps its own copy.
 */
export interface PlaybackSession {
  // Bumped by a newer play, sign-out, or authorization. A play it supersedes
  // must not write playback state or report errors.
  playIntent: number;
  // Bumped by a pause. A play still awaiting queue setup must not start audio.
  pauseCount: number;
  // `pauseCount` when the user last pressed play. A play pressed after the
  // latest pause is the user's last word, so setup may still start audio.
  playPressedAt: number;
  readonly pauseListeners: Set<() => void>;
  // Songs from a capped playlist not yet in the provider queue. A new
  // generation drops a pending refill for a queue that has been replaced.
  queueRest: Track[];
  restGeneration: number;
  refilling: boolean;
  // Last song this playlist added. If the queue no longer holds it, the
  // queue was replaced elsewhere and the rest must not be appended.
  restAnchor: Track | undefined;
  // Songs before the one a Play started at. MusicKit's queue begins at that
  // song, so Previous on it steps back through these instead. Valid while
  // the queue still starts with `historyAnchor`.
  startHistory: Track[];
  historyAnchor: Track | undefined;
  // With Repeat All, the whole collection in Play order (`startHistory`,
  // then the first pass), kept for each next pass of that Play.
  repeatCycle: Track[] | undefined;
  // The pass added on the last song: where it starts in the queue, the song
  // before it, and how many of its songs are in the queue so far.
  repeatPass: { from: number; anchor: Track; count: number } | undefined;
  // The station the latest play started, so a handoff can restart it.
  station: Station | undefined;
}

/** The controller context plus the one shared playback session. */
export type PlaybackContext = ControllerContext & {
  readonly session: PlaybackSession;
};

/** Previous restarts the song after this many seconds, as in Apple Music. */
const RESTART_THRESHOLD_SECONDS = 3;

/** Two MusicKit volume levels closer than this are the same level. */
const MUSIC_VOLUME_TOLERANCE = 0.001;
/** Levels this app wrote recently, kept for their volume echoes. */
const MAX_SENT_MUSIC_VOLUMES = 16;

/** Queue and transport commands over the MusicKit instance. */
export function createPlayback(context: ControllerContext) {
  const { requireMusic, getMusic, log } = context;
  const session: PlaybackSession = {
    playIntent: 0,
    pauseCount: 0,
    playPressedAt: -1,
    pauseListeners: new Set<() => void>(),
    queueRest: [],
    restGeneration: 0,
    refilling: false,
    restAnchor: undefined,
    startHistory: [],
    historyAnchor: undefined,
    repeatCycle: undefined,
    repeatPass: undefined,
    station: undefined,
  };
  const shared: PlaybackContext = { ...context, session };

  /** Levels written to MusicKit, so its volume events can be told apart. */
  const sentMusicVolumes: number[] = [];
  const rememberSentMusicVolume = (level: number): void => {
    sentMusicVolumes.push(level);
    if (sentMusicVolumes.length > MAX_SENT_MUSIC_VOLUMES)
      sentMusicVolumes.shift();
  };

  /** Sets the unmuted level. Any explicit volume change also unmutes. */
  const applyPlaybackVolume = (volume: number): number => {
    const safeVolume = Number.isFinite(volume)
      ? Math.max(0, Math.min(1, volume))
      : DEFAULT_SETTINGS.volume;
    if (getState().playback.muted) setMuted(false);
    setVolume(safeVolume);
    const music = getMusic();
    if (music) {
      rememberSentMusicVolume(safeVolume);
      setMusicVolume(music, safeVolume);
    }
    return safeVolume;
  };

  /**
   * Mirrors a volume MusicKit reports on its own, such as one changed from
   * another app. A level this app just wrote is an echo and is ignored, and
   * the audio is never written here, so the change cannot loop. Returns true
   * when `playback.volume` changed, so the caller can persist it.
   */
  const reflectMusicVolume = (volume: number): boolean => {
    if (!Number.isFinite(volume)) return false;
    const level = Math.max(0, Math.min(1, volume));
    const echoIndex = sentMusicVolumes.findIndex(
      (sent) => Math.abs(sent - level) <= MUSIC_VOLUME_TOLERANCE,
    );
    if (echoIndex !== -1) {
      sentMusicVolumes.splice(0, echoIndex + 1);
      return false;
    }
    const { muted, volume: audible } = getState().playback;
    const heard = muted ? 0 : audible;
    if (Math.abs(heard - level) <= MUSIC_VOLUME_TOLERANCE) return false;
    if (muted) setMuted(false);
    setVolume(level);
    return true;
  };

  const editQueueLogged = async (
    label: string,
    instance: MusicKit.MusicKitInstance,
    plan: (
      queue: readonly Track[],
      current: number,
    ) => QueueEditPlan | undefined,
  ): Promise<QueueEditTier> => {
    const playIntent = session.playIntent;
    const isCurrent = (): boolean => session.playIntent === playIntent;
    try {
      if (!isCurrent()) return "noop";
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
      return await editQueue(
        instance,
        plan,
        (count) => {
          if (!isCurrent()) return;
          log(`Skipped ${count} unavailable songs.`);
          const message = skippedMessage(count);
          if (message) reportActionError(new Error(message));
        },
        isCurrent,
      );
    } catch (error) {
      if (!isCurrent()) return "noop";
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

  const requests = createPlayRequests(shared);
  const { beginPlayRequest, startAudio, reportPlayFailure } = requests;

  const cancelPendingPlayback = (): void => {
    session.playIntent += 1;
  };

  const pausePlayback = (): void => {
    session.pauseCount += 1;
    if (getState().playback.status === "loading") setPlaybackStatus("paused");
    for (const listener of session.pauseListeners) listener();
  };

  // Continuation refills go through `insert`, which is declared below; the
  // lookup happens only when a refill runs, after both exist.
  const continuation = createQueueContinuation(shared, {
    insertTracks: (method, tracks, options) =>
      insert.insertTracks(method, tracks, options),
  });
  const { clearContinuation, maybeRefillQueue, appendContinuation } =
    continuation;
  const { playTracks } = createPlayTracks(shared, continuation, requests);
  const insert = createQueueInsert(shared, { playTracks });
  const { insertTracks } = insert;

  const seek = async (seconds: number): Promise<void> => {
    if (!Number.isFinite(seconds)) return;
    const safeSeconds = Math.max(0, seconds);
    const { pendingRestore, durationSeconds } = getState().playback;
    // A parked station restarts on Play, so it has no position to move to.
    if (pendingRestore?.station) return;
    if (pendingRestore) {
      // Nothing is loaded yet; resume starts from the new position.
      setPendingRestore({ ...pendingRestore, positionSeconds: safeSeconds });
      setPlaybackPosition(safeSeconds, durationSeconds);
      return;
    }
    // Show the target at once; stale ticks are held until the seek lands.
    const previousSeconds = getState().playback.positionSeconds;
    const generation = beginSeek(safeSeconds);
    setPlaybackPosition(safeSeconds, durationSeconds);
    try {
      await seekToTime(requireMusic(), safeSeconds);
      // Paused playback may not tick, so confirm the position here unless
      // a newer seek or a song change took over.
      if (settleSeek(generation)) {
        setPlaybackPosition(safeSeconds, getState().playback.durationSeconds);
      }
    } catch (error) {
      if (endSeek(generation)) {
        setPlaybackPosition(
          previousSeconds,
          getState().playback.durationSeconds,
        );
      }
      log(`Seek failed: ${errorMessage(error)}`);
      throw error;
    }
  };

  return {
    applyPlaybackVolume,
    reflectMusicVolume,
    syncPlaybackModes,
    playTracks,
    maybeRefillQueue,
    clearContinuation,
    appendContinuation,
    /** Identifies the current queue for `appendContinuation`. */
    continuationToken: continuation.continuationToken,

    /**
     * The whole queue as the user sees it: the last QUEUE_HISTORY_LENGTH
     * songs before the one a Play started at, MusicKit's queue, and the rest
     * still to be added. Saved for restore and for Save as playlist.
     */
    fullQueue(): { tracks: Track[]; index: number } {
      const { queue, queueIndex, pendingRestore } = getState().playback;
      if (pendingRestore) return { tracks: [...queue], index: queueIndex };
      const history =
        queue[0] !== undefined && isSameTrack(queue[0], session.historyAnchor)
          ? session.startHistory.slice(-QUEUE_HISTORY_LENGTH)
          : [];
      const rest =
        session.queueRest.length > 0 &&
        queue.some((track) => isSameTrack(track, session.restAnchor))
          ? session.queueRest
          : [];
      return {
        tracks: [...history, ...queue, ...rest],
        index: history.length + queueIndex,
      };
    },

    /** The station playing now, or undefined when songs are playing. */
    currentStation: (): Station | undefined => session.station,

    async playStation(station: Station): Promise<void> {
      const url = station.url?.trim();
      const id = station.id.trim();
      if (!url && !id) throw new Error("This station cannot be played.");
      const instance = requireMusic();
      const request = beginPlayRequest(instance);
      if (!request.shuffleReady) {
        const error = new Error(
          "Shuffle could not be restored before playback.",
        );
        reportPlayFailure("Station play failed", error);
        throw error;
      }
      clearContinuation();
      session.station = station;
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
        await playTracks(saved, index, undefined, { keepOrder: true });
        return;
      }
      const request = beginPlayRequest(instance);
      if (!request.shuffleReady) {
        const error = new Error(
          "Shuffle could not be restored before playback.",
        );
        reportPlayFailure("Queue item play failed", error);
        throw error;
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
      clearPlaybackError();
      setPlaybackStatus("loading");
      try {
        // Selecting in the provider queue keeps history and shuffle order.
        const selected = await changeToMediaAtIndex(instance, index);
        // The indexed call is asynchronous too. A newer Play may own the
        // provider before this compatibility fallback gets a chance to run.
        if (!request.current()) return;
        if (selected) {
          await startAudio(instance, request);
          if (request.current()) setQueueSnapshot(snapshot.queue, index);
          return;
        }
        log(
          "Queue selection unavailable; rebuilding the queue from the selected song.",
        );
        const { entries, skipped } = await withResolvableTracks(
          snapshot.queue.slice(index),
          async (attempt) => {
            if (!request.current()) {
              throw new Error("Queue request is no longer current.");
            }
            await instance.setQueue(
              queueOptionsForTracks(attempt.map((entry) => entry.track)),
            );
          },
          request.current,
        );
        if (!request.current()) return;
        const queue = entries.map((entry) => entry.track);
        if (skipped.length) log(`Skipped ${skipped.length} unavailable songs.`);
        await startAudio(instance, request);
        if (request.current()) {
          setQueue(queue, 0);
          setCurrentTrack(queue[0], 0);
          const message = skippedMessage(skipped.length);
          if (message) reportActionError(new Error(message));
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
        const level = muted ? 0 : getState().playback.volume;
        rememberSentMusicVolume(level);
        setMusicVolume(music, level);
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

    /**
     * `trackId` is the song being moved. If the queue shifted since the user
     * picked it (a background top-up, a sync), the move follows the song and
     * keeps the same offset; a song that is gone moves nothing.
     */
    async moveQueueItem(
      from: number,
      to: number,
      trackId?: string,
    ): Promise<QueueEditTier> {
      return editQueueLogged(
        "Queue move failed",
        requireMusic(),
        (queue, current) => {
          if (trackId === undefined) {
            return planMove(queue, current, from, to);
          }
          const actual = nearestTrackIndex(queue, from, trackId);
          if (actual < 0) return undefined;
          const target = Math.max(
            0,
            Math.min(queue.length - 1, to + (actual - from)),
          );
          return actual === target
            ? undefined
            : planMove(queue, current, actual, target);
        },
      );
    },

    async clearUpNext(): Promise<QueueEditTier> {
      const instance = requireMusic();
      // A clear takes ownership from older inserts and queue rebuilds.
      cancelPendingPlayback();
      const clearIntent = session.playIntent;
      const tier = await editQueueLogged(
        "Queue clear failed",
        instance,
        (queue, current) => planClear(queue, current),
      );
      // Clearing Up Next also drops the rest of a capped playlist and any
      // Repeat All pass; a failed clear keeps them. A newer Play owns its
      // own continuation.
      if (session.playIntent === clearIntent) clearContinuation();
      return tier;
    },

    async togglePlayback(): Promise<void> {
      try {
        const instance = requireMusic();
        // A song still loading already shows as playing, so the press means
        // pause even though MusicKit has not started yet.
        if (getState().playback.status === "loading") {
          recordTransportIntent(false);
          pausePlayback();
          instance.pause();
          return;
        }
        if (instance.playbackState === MusicKit.PlaybackStates.playing) {
          recordTransportIntent(false);
          pausePlayback();
        } else {
          recordTransportIntent(true);
          session.playPressedAt = session.pauseCount;
        }
        await toggle(instance);
      } catch (error) {
        log(`Toggle failed: ${errorMessage(error)}`);
        throw error;
      }
    },

    async play(): Promise<void> {
      const instance = requireMusic();
      recordTransportIntent(true);
      session.playPressedAt = session.pauseCount;
      await instance.play();
    },

    async pause(): Promise<void> {
      recordTransportIntent(false);
      // A parked or signed-out session has no player to pause.
      pausePlayback();
      getMusic()?.pause();
    },

    /**
     * Runs on every pause so a pending playlist or station load can stop.
     * Returns a function that removes the listener.
     */
    onPause(listener: () => void): () => void {
      session.pauseListeners.add(listener);
      return () => session.pauseListeners.delete(listener);
    },

    /** Changes with every play request; tells a caller its play was replaced. */
    playIntent: (): number => session.playIntent,

    /** Changes with every pause; used to cancel a resume waiting on handoff. */
    pauseCount: (): number => session.pauseCount,

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
      // Repeat All adds the collection's next pass; leaving it removes one.
      maybeRefillQueue();
    },

    async setRepeatMode(mode: NormalizedRepeatMode): Promise<void> {
      applyRepeatMode(requireMusic(), mode);
      maybeRefillQueue();
    },

    async previous(): Promise<void> {
      try {
        const {
          pendingRestore,
          queue,
          queueIndex,
          positionSeconds,
          repeatMode,
        } = getState().playback;
        // MusicKit only restarts the first song or with Repeat One, so the
        // restart past the first seconds happens here. A station has none.
        const restart =
          positionSeconds >= RESTART_THRESHOLD_SECONDS &&
          session.station === undefined &&
          !pendingRestore?.station;
        // A restored queue has no MusicKit queue to step back in yet. Like
        // MusicKit, Repeat All goes from the first song to the last.
        if (pendingRestore && queue.length > 0) {
          const index = restart
            ? queueIndex
            : queueIndex > 0
              ? queueIndex - 1
              : repeatMode === "all"
                ? queue.length - 1
                : 0;
          await playTracks(queue, index, undefined, { keepOrder: true });
          return;
        }
        if (restart) {
          await seek(0);
          return;
        }
        // On the song a Play started at, step back into the songs before
        // it. Past the first seconds, Previous restarts the song instead.
        const onStartSong =
          queueIndex === 0 &&
          positionSeconds < RESTART_THRESHOLD_SECONDS &&
          queue[0] !== undefined &&
          isSameTrack(queue[0], session.historyAnchor);
        if (onStartSong && session.startHistory.length > 0) {
          const history = session.startHistory;
          await playTracks(
            [...history, ...queue, ...session.queueRest],
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
        const { pendingRestore, queue, queueIndex, repeatMode } =
          getState().playback;
        if (pendingRestore && queue.length > 0) {
          // As in MusicKit, past the last song only Repeat All goes on, to
          // the first song.
          const index =
            queueIndex + 1 < queue.length
              ? queueIndex + 1
              : repeatMode === "all"
                ? 0
                : undefined;
          if (index !== undefined) {
            await playTracks(queue, index, undefined, { keepOrder: true });
          }
          return;
        }
        await skipToNext(requireMusic());
      } catch (error) {
        log(`Next failed: ${errorMessage(error)}`);
        throw error;
      }
    },

    seek,
  };
}
