import { readPlaybackModes } from "../musickit/player.ts";
import { editQueue, planRemoveRange } from "../musickit/queue-edit.ts";
import { isSameTrack, type Track } from "../domain/music.ts";
import { errorMessage } from "./controller-support.ts";
import {
  QUEUE_REFILL_SIZE,
  QUEUE_REFILL_THRESHOLD,
  shuffledCopy,
} from "./queue-window.ts";
import { getState, setQueueRest } from "../state.ts";
import type { PlaybackContext } from "./playback.ts";
import type { InsertTracks } from "./playback-insert.ts";

/** The rest of a capped playlist, appended to the queue as it plays. */
export function createQueueContinuation(
  context: PlaybackContext,
  deps: { insertTracks: InsertTracks },
) {
  const { getMusic, log, session } = context;
  const { insertTracks } = deps;

  const setRest = (tracks: Track[], anchor?: Track): void => {
    session.queueRest = tracks;
    if (anchor) session.restAnchor = anchor;
    if (tracks.length === 0) session.restAnchor = undefined;
    setQueueRest(tracks.length);
  };

  /** Drops the songs still to be added and any refill in flight. */
  const dropRest = (): void => {
    session.restGeneration += 1;
    setRest([]);
  };

  /** A new Play, Clear, or replaced queue also ends Repeat All's passes. */
  const clearContinuation = (): void => {
    dropRest();
    session.repeatCycle = undefined;
    session.repeatPass = undefined;
  };

  const repeatsAll = (): boolean => {
    const instance = getMusic();
    return (
      instance !== undefined &&
      instance !== null &&
      readPlaybackModes(instance).repeatMode === "all"
    );
  };

  /**
   * Apple Music's Repeat All loops through the whole collection, but a Play
   * started mid-collection begins MusicKit's queue at the chosen song. On
   * the last song, the next pass (from the collection's first song) becomes
   * the queue's rest. Returns true when it did.
   */
  const startRepeatPass = (): boolean => {
    const { queue, queueIndex, pendingRestore } = getState().playback;
    const last = queue.at(-1);
    if (!last || pendingRestore || session.station) return false;
    if (queueIndex !== queue.length - 1) return false;
    if (
      session.startHistory.length === 0 ||
      !isSameTrack(queue[0], session.historyAnchor)
    ) {
      return false;
    }
    // Once per last song, so a pass that failed is not retried on every event.
    if (session.repeatPass?.from === queue.length || !repeatsAll()) {
      return false;
    }
    session.repeatCycle ??= [...session.startHistory, ...queue];
    session.repeatPass = { from: queue.length, anchor: last, count: 0 };
    setRest([...session.repeatCycle], last);
    return true;
  };

  /** Repeat All went off: removes the next pass unless it already started. */
  const dropRepeatPass = (): void => {
    const pass = session.repeatPass;
    session.repeatPass = undefined;
    if (!pass) return;
    // The part of the pass not added yet. The collection order is kept for
    // a later Repeat All.
    if (session.queueRest.length > 0) dropRest();
    const instance = getMusic();
    // A parked queue has no MusicKit queue to edit.
    if (!instance || pass.count === 0 || getState().playback.pendingRestore) {
      return;
    }
    const generation = session.restGeneration;
    session.refilling = true;
    void editQueue(
      instance,
      (queue, current) =>
        current < pass.from && isSameTrack(queue[pass.from - 1], pass.anchor)
          ? planRemoveRange(queue, current, pass.from, pass.count)
          : undefined,
      undefined,
      () => generation === session.restGeneration,
    )
      .catch((error: unknown) => {
        log(`Removing the Repeat All pass failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        session.refilling = false;
      });
  };

  /**
   * Appends the next songs of a capped playlist once fewer than
   * QUEUE_REFILL_THRESHOLD upcoming songs remain, and with Repeat All the
   * collection's next pass. Runs once at a time; a new play or `Clear`
   * drops a refill that is still in flight.
   */
  const maybeRefillQueue = (): void => {
    if (session.refilling) return;
    if (session.repeatPass && !repeatsAll()) {
      dropRepeatPass();
      return;
    }
    if (session.queueRest.length === 0 && !startRepeatPass()) return;
    const { queue, queueIndex } = getState().playback;
    if (queue.length === 0) return;
    if (!queue.some((track) => isSameTrack(track, session.restAnchor))) {
      log("Queue was replaced; dropping the rest of the previous playlist.");
      clearContinuation();
      return;
    }
    if (queue.length - queueIndex - 1 >= QUEUE_REFILL_THRESHOLD) return;
    const generation = session.restGeneration;
    const chunk = session.queueRest.slice(0, QUEUE_REFILL_SIZE);
    const instance = getMusic();
    const shuffled =
      instance !== undefined &&
      instance !== null &&
      readPlaybackModes(instance).shuffleMode === "songs";
    session.refilling = true;
    let inserted: Track[] = [];
    // A background refill never toasts; the user did not start it.
    void insertTracks("playLater", shuffled ? shuffledCopy(chunk) : chunk, {
      quiet: true,
      isCurrent: () => generation === session.restGeneration,
    })
      .then((tracks) => {
        inserted = tracks;
      })
      .catch((error: unknown) => {
        log(`Queue refill failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        session.refilling = false;
        // The chunk is consumed even on failure so a bad page cannot loop.
        if (generation === session.restGeneration) {
          if (session.repeatPass) session.repeatPass.count += inserted.length;
          setRest(session.queueRest.slice(chunk.length), inserted.at(-1));
        }
        // Repeat All may have gone off while this chunk was being added.
        if (session.repeatPass && !repeatsAll()) dropRepeatPass();
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
    if (token !== session.restGeneration || tracks.length === 0) return;
    const anchor = session.restAnchor ?? getState().playback.queue.at(-1);
    if (!anchor) return;
    setRest([...session.queueRest, ...tracks], anchor);
    maybeRefillQueue();
  };

  return {
    setRest,
    clearContinuation,
    maybeRefillQueue,
    appendContinuation,
    continuationToken: (): number => session.restGeneration,
  };
}

export type QueueContinuation = ReturnType<typeof createQueueContinuation>;
