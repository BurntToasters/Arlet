import { readPlaybackModes } from "../musickit/player.ts";
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

  const clearContinuation = (): void => {
    session.restGeneration += 1;
    setRest([]);
  };

  /**
   * Appends the next songs of a capped playlist once fewer than
   * QUEUE_REFILL_THRESHOLD upcoming songs remain. Runs once at a time; a new
   * play or `Clear` drops a refill that is still in flight.
   */
  const maybeRefillQueue = (): void => {
    if (session.refilling || session.queueRest.length === 0) return;
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
          setRest(session.queueRest.slice(chunk.length), inserted.at(-1));
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
