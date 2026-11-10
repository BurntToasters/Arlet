import { MAX_QUEUE_LENGTH, appendTargetIndex } from "./queue-window.ts";
import {
  queueDescriptorsForTracks,
  queueOptionsForTracks,
  syncMusicKitQueue,
} from "../musickit/player.ts";
import type { Track } from "../domain/music.ts";
import {
  skippedMessage,
  unresolvedIds,
  withResolvableTracks,
} from "../musickit/unresolved.ts";
import { musicKitReasonOf } from "../musickit/errors.ts";
import { reportActionError } from "../components/action-errors.ts";
import { getState, setQueue, setQueueSnapshot } from "../state.ts";
import {
  errorMessage,
  materializeTracks,
  sameTrackIds,
  trackIds,
} from "./controller-support.ts";
import type { PlaybackContext } from "./playback.ts";

type QueueInsertMethod = "playNext" | "playLater";

/** Shown when a station is playing; MusicKit has no queue to insert into. */
export const STATION_INSERT_MESSAGE =
  "Play Next and Play Later aren't available while a station is playing.";

/**
 * Play Next and Play Later. Built on the shared playback context; an empty
 * queue is handed to `playTracks` instead.
 */
export function createQueueInsert(
  context: PlaybackContext,
  deps: { playTracks: (tracks: readonly Track[]) => Promise<unknown> },
) {
  const { requireMusic, log } = context;
  const { playTracks } = deps;

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
    const playIntent = context.session.playIntent;
    // Refills belong to the queue generation they extend. Manual insertions
    // belong to the play intent that was current when the user started them.
    const isCurrent =
      options.isCurrent ?? (() => context.session.playIntent === playIntent);
    const ids = trackIds(tracks);
    if (ids.length === 0) throw new Error("At least one track is required.");
    if (!isCurrent()) return [];
    // A station's MusicKit queue refuses inserts, so none is sent. Background
    // refills stop quietly; a user's request gets the toast.
    if (context.session.station !== undefined) {
      if (!options.quiet) reportActionError(new Error(STATION_INSERT_MESSAGE));
      return [];
    }
    const allTracks = materializeTracks(tracks);
    // Same request limit as playTracks; the first songs are kept in order.
    const requestedTracks = allTracks.slice(0, MAX_QUEUE_LENGTH);
    if (requestedTracks.length < allTracks.length) {
      log(
        `Added the first ${requestedTracks.length} of ${allTracks.length} songs to stay within Apple's request limits.`,
      );
    }
    // A Play may still be replacing the provider queue. Wait for that setup so
    // the snapshot below is the queue the user will actually hear. The settled
    // generation then gates every write: a newer setup aborts this insert.
    while (context.session.queueSetup) {
      await context.session.queueSetup;
      if (!isCurrent()) return [];
    }
    const setupGeneration = context.session.queueSetupGeneration;
    const setupCurrent = (): boolean =>
      context.session.queueSetupGeneration === setupGeneration;
    const current = (): boolean => isCurrent() && setupCurrent();
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
    let resolved: Awaited<ReturnType<typeof withResolvableTracks>>;
    try {
      resolved = await withResolvableTracks(
        requestedTracks,
        async (attempt) => {
          if (!instance || typeof insert !== "function") return;
          // The owner may have changed while this insertion was waiting.
          if (!current()) {
            throw new Error("Queue request is no longer current.");
          }
          const run = (queueOptions: MusicKit.QueueOptions): Promise<void> =>
            (insert as (options: MusicKit.QueueOptions) => Promise<void>).call(
              instance,
              queueOptions,
            );
          const attemptTracks = attempt.map((entry) => entry.track);
          // Song details skip MusicKit's lookup (one request per 16 songs).
          const detailed = byId
            ? undefined
            : queueDescriptorsForTracks(attemptTracks);
          if (detailed) {
            try {
              await run(detailed);
              return;
            } catch (error) {
              if (
                unresolvedIds(error) ||
                !current() ||
                musicKitReasonOf(error) === "UNSUPPORTED_ERROR"
              ) {
                throw error;
              }
              log(
                `Adding songs by details failed; using IDs: ${errorMessage(error)}`,
              );
            }
          }
          if (!current()) {
            throw new Error("Queue request is no longer current.");
          }
          await run(
            byId
              ? { songs: attemptTracks.map((track) => track.id) }
              : queueOptionsForTracks(attemptTracks),
          );
        },
        current,
      );
    } catch (error) {
      if (!current()) return [];
      // The station state can be stale: MusicKit may be on a station this
      // module has not recorded. Its refusal gets the same message.
      if (musicKitReasonOf(error) === "UNSUPPORTED_ERROR") {
        log(`${method} refused by MusicKit: ${errorMessage(error)}`);
        reportActionError(new Error(STATION_INSERT_MESSAGE));
        return [];
      }
      throw error;
    }
    if (!current()) return [];
    const { entries, skipped } = resolved;
    const normalizedTracks = entries.map((entry) => entry.track);
    if (skipped.length) {
      log(`Skipped ${skipped.length} unavailable songs.`);
      const message = skippedMessage(skipped.length);
      if (message && !options.quiet) reportActionError(new Error(message));
    }
    const expectedQueue = [...beforeQueue];
    let expectedIndex = snapshotIndex;
    if (method === "playNext") {
      expectedQueue.splice(snapshotIndex + 1, 0, ...normalizedTracks);
    } else {
      // MusicKit's playLater lands before the autoplay songs, not at the end.
      const at = appendTargetIndex(beforeQueue);
      expectedQueue.splice(at, 0, ...normalizedTracks);
      // Songs inserted at or before the playing song move it along.
      if (at <= snapshotIndex) expectedIndex += normalizedTracks.length;
    }
    if (!instance) {
      setQueue(expectedQueue, expectedIndex);
      return normalizedTracks;
    }
    // A replaced queue or a moved selection happened during the await. It is
    // newer than this insertion, so the captured snapshot must not overwrite
    // it. A queue setup that started meanwhile owns the provider now, so its
    // new queue must not be replaced by this insert's snapshot either.
    const latest = getState().playback;
    if (
      !current() ||
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
    setQueueSnapshot(expectedQueue, expectedIndex);
    return normalizedTracks;
  };

  return { insertTracks };
}

export type InsertTracks = ReturnType<typeof createQueueInsert>["insertTracks"];
