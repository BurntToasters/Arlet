import {
  beginSeek,
  changeToMediaAtIndex,
  endSeek,
  queueOptionsForTracks,
  readPlaybackModes,
  recordTransportIntent,
  type NormalizedRepeatMode,
  type PlaybackModeCapabilities,
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
import {
  MAX_QUEUE_LENGTH,
  lastUserIndex,
  nearestTrackIndex,
  shuffledCopy,
  withoutUpcomingAutoplay,
} from "./queue-window.ts";
import {
  editQueue,
  labelOccurrences,
  planClear,
  planMove,
  planRemove,
  planRestoreOrder,
  type QueueEditPlan,
  type QueueEditTier,
  type RestoreOrder,
  settleQueueEdits,
  shuffleOnAdds,
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
  subscribe,
} from "../state.ts";
import { errorMessage, type ControllerContext } from "./controller-support.ts";
import { createPlayRequests, createPlayTracks } from "./playback-play.ts";
import { createQueueInsert } from "./playback-insert.ts";
import { createQueueContinuation } from "./queue-continuation.ts";
import { beginQueueSetup } from "./queue-setup.ts";

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
  // Bumped when a Play starts replacing the provider queue. An insert started
  // during setup waits on `queueSetup`, then plans against the new queue, and
  // aborts if another setup claims the provider before its calls land.
  queueSetupGeneration: number;
  queueSetup: Promise<void> | undefined;
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
  // The whole ordered list the latest Play started. It holds only while the
  // queue still has it as the user heard it: an edit clears `collectionIntact`.
  // `occurrences` gives each queue position's collection index (-1 if none).
  collection: Track[];
  collectionIntact: boolean;
  occurrences: number[];
  labeledQueue: readonly Track[] | undefined;
  // Shuffle toggles run one after another, each reading what the last left.
  shuffleChain: Promise<void>;
  // The refill in flight, if any, so a toggle can wait for it.
  refillSettled: Promise<void> | undefined;
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

const STATION_SHUFFLE_MESSAGE =
  "Shuffle isn't available while a station is playing.";
const STATION_REPEAT_MESSAGE =
  "Repeat isn't available while a station is playing.";
const STATION_CLEAR_MESSAGE =
  "Clear Up Next isn't available while a station is playing.";
const AUTOPLAY_MODE_MESSAGE =
  "Shuffle and Repeat aren't available while an Autoplay song is playing.";

/** Queue and transport commands over the MusicKit instance. */
export function createPlayback(context: ControllerContext) {
  const { requireMusic, getMusic, log } = context;
  const session: PlaybackSession = {
    playIntent: 0,
    pauseCount: 0,
    playPressedAt: -1,
    pauseListeners: new Set<() => void>(),
    queueSetupGeneration: 0,
    queueSetup: undefined,
    queueRest: [],
    restGeneration: 0,
    refilling: false,
    restAnchor: undefined,
    startHistory: [],
    historyAnchor: undefined,
    repeatCycle: undefined,
    repeatPass: undefined,
    station: undefined,
    collection: [],
    collectionIntact: false,
    occurrences: [],
    labeledQueue: undefined,
    shuffleChain: Promise.resolve(),
    refillSettled: undefined,
  };
  const shared: PlaybackContext = { ...context, session };
  // Whether the capabilities last written hid shuffle and repeat for a station.
  let stationModesWritten = false;

  // Each queue change re-labels the collection index of every queue position,
  // so a shuffle toggle reads the copy of a duplicate song that is playing.
  subscribe(() => {
    const { queue, queueIndex } = getState().playback;
    if (queue === session.labeledQueue) return;
    session.labeledQueue = queue;
    session.occurrences = session.collectionIntact
      ? labelOccurrences(
          session.collection,
          queue,
          queueIndex,
          session.occurrences,
        )
      : [];
  });

  // Account transitions reset the playback scope. A station from the previous
  // scope must not label a handoff's parked queue.
  subscribe(() => {
    const { auth } = getState();
    if (auth.pending === true || auth.status !== "authorized") {
      session.station = undefined;
    }
  });

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

  /**
   * A station plays without MusicKit shuffle or repeat, so both stay hidden
   * while one plays. Songs bring the runtime's capabilities back.
   */
  const stationCapabilities = (
    capabilities: PlaybackModeCapabilities,
  ): PlaybackModeCapabilities =>
    session.station === undefined
      ? capabilities
      : { ...capabilities, shuffle: false, repeat: false };

  const syncPlaybackModes = (instance: MusicKit.MusicKitInstance): void => {
    const modes = readPlaybackModes(instance);
    const playing = session.station !== undefined;
    stationModesWritten = playing;
    setPlaybackModes({
      shuffleMode: modes.shuffleMode,
      repeatMode: modes.repeatMode,
      modeCapabilities: stationCapabilities(modes.capabilities),
      stationPlaying: playing,
    });
  };

  // A play that starts or ends a station changes `session.station` without a
  // MusicKit mode event. The next state write re-reads the capabilities and
  // the station flag the UI reads.
  subscribe(() => {
    const playing = session.station !== undefined;
    if (playing === stationModesWritten) return;
    const music = getMusic();
    if (music) {
      syncPlaybackModes(music);
      return;
    }
    stationModesWritten = playing;
    setPlaybackModes({ stationPlaying: playing });
  });

  /** True while the song at the queue position is one MusicKit added on its own. */
  const autoplayPlaying = (): boolean => {
    const { queue, queueIndex } = getState().playback;
    return queue[queueIndex]?.autoplay === true;
  };

  /** Writes a repeat mode; throws when the runtime cannot change it. */
  const applyRepeatMode = (
    instance: MusicKit.MusicKitInstance,
    mode: NormalizedRepeatMode,
  ): void => {
    if (session.station !== undefined) throw new Error(STATION_REPEAT_MESSAGE);
    if (autoplayPlaying()) throw new Error(AUTOPLAY_MODE_MESSAGE);
    const current = readPlaybackModes(instance);
    if (!current.capabilities.repeat) {
      throw new Error("Repeat is not available in this MusicKit runtime.");
    }
    if (!setMusicRepeatMode(instance, mode)) {
      setPlaybackModes({
        modeCapabilities: stationCapabilities({
          ...current.capabilities,
          repeat: false,
        }),
      });
      throw new Error("Repeat could not be changed in this MusicKit runtime.");
    }
    syncPlaybackModes(instance);
  };

  /** Writes shuffle to MusicKit and syncs the modes; throws when unsupported. */
  const setShuffleModeNow = async (mode: "off" | "songs"): Promise<void> => {
    const instance = requireMusic();
    if (!setMusicShuffleMode(instance, mode === "songs")) {
      const modes = readPlaybackModes(instance);
      setPlaybackModes({
        modeCapabilities: stationCapabilities({
          ...modes.capabilities,
          shuffle: false,
        }),
      });
      throw new Error("Shuffle is not available in this MusicKit runtime.");
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
  const { clearContinuation, maybeRefillQueue, appendContinuation, setRest } =
    continuation;
  const { playTracks } = createPlayTracks(shared, continuation, requests);
  const insert = createQueueInsert(shared, { playTracks });
  const { insertTracks } = insert;

  /** A user edit or a station ends the collection the queue was built from. */
  const breakCollection = (): void => {
    session.collectionIntact = false;
  };

  /** True when the queue still holds the whole collection and can be reordered. */
  const collectionUsable = (): boolean =>
    session.collectionIntact &&
    session.collection.length > 0 &&
    session.station === undefined &&
    !getState().playback.pendingRestore;

  /** The last song the user queued: the song the rest is appended after. */
  const lastUserSong = (queue: readonly Track[]): Track | undefined =>
    queue[lastUserIndex(queue)];

  /**
   * Shuffle on for an intact collection. The songs of the list not in the
   * queue join the shuffle, so the songs before the one playing come back, as
   * in Apple Music. Up to MAX_QUEUE_LENGTH they join the queue at once; a
   * longer list refills from the rest in random order.
   */
  const shuffleOnCollection = async (
    instance: MusicKit.MusicKitInstance,
  ): Promise<void> => {
    const intent = session.playIntent;
    if (!readPlaybackModes(instance).capabilities.shuffle) {
      return setShuffleModeNow("songs");
    }
    await settleQueueEdits(instance);
    await continuation.settleRefills();
    if (!collectionUsable()) return setShuffleModeNow("songs");
    const { queue, queueIndex } = getState().playback;
    const playing = session.occurrences[queueIndex] ?? -1;
    const adds = shuffleOnAdds(
      session.collection,
      playing,
      queue.filter((track) => !track.autoplay),
      session.queueRest,
    );
    if (!adds) {
      // The playing song cannot be placed in the collection. Shuffle then
      // covers the queue alone, as it did before the collection was tracked.
      breakCollection();
      return setShuffleModeNow("songs");
    }
    const rest = [...session.queueRest];
    const anchor = session.restAnchor ?? lastUserSong(queue);
    const listLength = session.collection.length;
    setRest([]);
    session.refilling = true;
    let inserted = false;
    let bigList = false;
    try {
      if (listLength <= MAX_QUEUE_LENGTH) {
        if (adds.length > 0) {
          // Before the shuffle, so MusicKit shuffles the whole list at once.
          await insert.insertTracks("playLater", adds, { quiet: true });
          inserted = true;
        }
        if (session.playIntent !== intent) return setShuffleModeNow("songs");
        await setShuffleModeNow("songs");
      } else {
        await setShuffleModeNow("songs");
        setRest(shuffledCopy(adds), anchor);
        bigList = true;
      }
    } catch (error) {
      if (!inserted) setRest(rest, anchor);
      breakCollection();
      throw error;
    } finally {
      session.refilling = false;
    }
    session.startHistory = [];
    session.historyAnchor = undefined;
    if (!syncMusicKitQueue(instance)) breakCollection();
    const now = getState().playback;
    session.occurrences = labelOccurrences(
      session.collection,
      now.queue,
      now.queueIndex,
      session.occurrences,
      playing,
    );
    // A longer list refills at once. Without it, the queue's in-order songs
    // hold the first refill back for about 65 song ends, and the songs from
    // before the start cannot come up sooner.
    maybeRefillQueue(bigList);
    if (bigList) await continuation.settleRefills();
  };

  /**
   * Shuffle off for an intact collection. The queue goes back to collection
   * order from the playing song, with autoplay songs last. Songs that are not
   * in the provider queue go to the rest, and songs before the run go to the
   * Previous history. The playing copy is the recorded collection index, not
   * MusicKit's position, which a duplicate ID can leave on the wrong copy.
   */
  const shuffleOffCollection = async (
    instance: MusicKit.MusicKitInstance,
  ): Promise<void> => {
    const intent = session.playIntent;
    if (!collectionUsable()) return setShuffleModeNow("off");
    const before = getState().playback;
    const playing = session.occurrences[before.queueIndex] ?? -1;
    if (playing < 0) {
      breakCollection();
      return setShuffleModeNow("off");
    }
    const queued = before.queue.filter((track) => !track.autoplay);
    const autoplay = before.queue.filter((track) => track.autoplay === true);
    const rest = [...session.queueRest];
    const anchor = session.restAnchor;
    const collection = session.collection;
    // Set by the plan, which runs against the provider queue as it reads
    // after the shuffle went off.
    const result: { order?: RestoreOrder } = {};
    session.refilling = true;
    try {
      // The explicit off reaches the provider at once: a held or stale edit
      // must not hold it back. The queue is restored once pending work settles.
      await setShuffleModeNow("off");
      await settleQueueEdits(instance);
      await continuation.settleRefills();
      if (session.playIntent !== intent) return;
      setRest([]);
      await editQueueLogged(
        "Queue restore failed",
        instance,
        (queue, current) => {
          const restored = planRestoreOrder({
            collection,
            playing,
            queued,
            rest,
            autoplay,
            provider: queue,
            providerIndex: current,
          });
          result.order = restored?.order;
          return restored?.plan;
        },
      );
      if (session.playIntent !== intent) return;
      const applied = result.order;
      if (!applied) {
        breakCollection();
        return;
      }
      const now = getState().playback;
      session.startHistory = applied.startHistory;
      session.historyAnchor = now.queue[0];
      session.repeatPass = undefined;
      session.occurrences = labelOccurrences(
        collection,
        now.queue,
        now.queueIndex,
        applied.occurrences,
        playing,
      );
      setRest(applied.rest, lastUserSong(now.queue));
    } catch (error) {
      if (session.playIntent === intent) setRest(rest, anchor);
      breakCollection();
      throw error;
    } finally {
      session.refilling = false;
    }
    maybeRefillQueue();
  };

  /** One shuffle toggle, with the collection kept when it can be. */
  const toggleShuffle = async (mode: "off" | "songs"): Promise<void> => {
    const instance = requireMusic();
    if (
      !collectionUsable() ||
      readPlaybackModes(instance).shuffleMode === mode
    ) {
      return setShuffleModeNow(mode);
    }
    if (mode === "songs") return shuffleOnCollection(instance);
    return shuffleOffCollection(instance);
  };

  /** The rest still to be added, but only while it belongs to `queue`. */
  const currentRest = (queue: Track[]): Track[] =>
    session.queueRest.length > 0 &&
    queue.some((track) => isSameTrack(track, session.restAnchor))
      ? session.queueRest
      : [];

  const seek = async (seconds: number): Promise<void> => {
    if (!Number.isFinite(seconds)) return;
    const safeSeconds = Math.max(0, seconds);
    const { pendingRestore, durationSeconds } = getState().playback;
    // A parked station restarts on Play, so it has no position to move to.
    if (pendingRestore?.station) return;
    if (pendingRestore) {
      // Nothing is loaded yet; resume starts from the new position, within
      // the song when its length is known.
      const resumeSeconds =
        Number.isFinite(durationSeconds) && durationSeconds > 0
          ? Math.min(safeSeconds, durationSeconds)
          : safeSeconds;
      setPendingRestore({ ...pendingRestore, positionSeconds: resumeSeconds });
      setPlaybackPosition(resumeSeconds, durationSeconds);
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

  const playback = {
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
     * The whole queue as the user sees it: every song before the one a Play
     * started at, MusicKit's queue, and the rest still to be added. Saved for
     * restore and for Save as playlist; a saved file keeps a window of it.
     * Upcoming autoplay songs are left out: MusicKit adds them again.
     */
    fullQueue(): { tracks: Track[]; index: number } {
      const { queue, queueIndex, pendingRestore } = getState().playback;
      const upcoming = withoutUpcomingAutoplay(queue, queueIndex);
      if (pendingRestore) return { tracks: upcoming, index: queueIndex };
      const history =
        queue[0] !== undefined && isSameTrack(queue[0], session.historyAnchor)
          ? session.startHistory
          : [];
      return {
        tracks: [...history, ...upcoming, ...currentRest(queue)],
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
      breakCollection();
      session.station = station;
      clearPlaybackError();
      setPlaybackStatus("loading");
      const releaseQueueSetup = beginQueueSetup(session);
      try {
        await instance.setQueue(url ? { url } : { station: id });
        await startAudio(instance, request);
      } catch (error) {
        // A superseded or signed-out station play reports nothing.
        if (!request.current()) return;
        // The provider never took the station. A later handoff must park the
        // untouched queue, not label it as a station.
        session.station = undefined;
        reportPlayFailure("Station play failed", error);
        throw error;
      } finally {
        releaseQueueSetup();
      }
    },

    playNextTracks: async (
      tracks: readonly Track[] | readonly string[],
    ): Promise<void> => {
      breakCollection();
      await insertTracks("playNext", tracks);
    },

    playLaterTracks: async (
      tracks: readonly Track[] | readonly string[],
    ): Promise<void> => {
      breakCollection();
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
        // The rebuild drops the songs before the selected one.
        breakCollection();
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
      breakCollection();
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
      breakCollection();
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
      // A station has no MusicKit queue to edit, so a clear would only fail.
      if (session.station !== undefined) throw new Error(STATION_CLEAR_MESSAGE);
      const instance = requireMusic();
      breakCollection();
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

    /** Shuffle from the UI, media controls or shortcuts. Refused during a station. */
    async setShuffleMode(mode: "off" | "songs"): Promise<void> {
      if (session.station !== undefined)
        throw new Error(STATION_SHUFFLE_MESSAGE);
      if (autoplayPlaying()) throw new Error(AUTOPLAY_MODE_MESSAGE);
      // Toggles run one at a time, so each reads the collection the last left.
      const toggle = session.shuffleChain.then(() => toggleShuffle(mode));
      session.shuffleChain = toggle.then(
        () => undefined,
        () => undefined,
      );
      await toggle;
    },

    /**
     * Shuffle for a play about to start. It runs while a station may still be
     * playing, but the play replaces the station, so the write is allowed.
     */
    setShuffleModeForPlay(mode: "off" | "songs"): Promise<void> {
      return setShuffleModeNow(mode);
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
        // MusicKit's Previous only restarts the current song (the first song,
        // or any song with Repeat One), so Arlet steps back itself: a restart
        // past the first seconds happens here, and with Repeat One Previous
        // plays the song before. A station has no steps.
        const restart =
          positionSeconds >= RESTART_THRESHOLD_SECONDS &&
          session.station === undefined &&
          !pendingRestore?.station;
        const repeatOne =
          repeatMode === "one" &&
          session.station === undefined &&
          !pendingRestore;
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
        // With Repeat One, Previous plays the song before the current one and
        // keeps Repeat One, as Apple Music does.
        if (repeatOne && queueIndex > 0) {
          await playback.playQueueItem(queueIndex - 1);
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
            [
              ...history,
              ...withoutUpcomingAutoplay(queue, queueIndex),
              ...currentRest(queue),
            ],
            history.length - 1,
          );
          return;
        }
        // Nothing before this song: MusicKit would only restart it, so seek.
        if (repeatOne) {
          await seek(0);
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
        // With Repeat One, Next plays the next song and keeps Repeat One.
        // MusicKit's skip would only restart the current song.
        if (
          repeatMode === "one" &&
          session.station === undefined &&
          !pendingRestore
        ) {
          if (queueIndex + 1 < queue.length) {
            await playback.playQueueItem(queueIndex + 1);
            return;
          }
          log("Next with Repeat One: no next song yet.");
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
  return playback;
}
