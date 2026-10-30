import { MAX_QUEUE_LENGTH } from "./queue-window.ts";
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
    let resolved: Awaited<ReturnType<typeof withResolvableTracks>>;
    try {
      resolved = await withResolvableTracks(
        requestedTracks,
        async (attempt) => {
          if (!instance || typeof insert !== "function") return;
          // The owner may have changed while this insertion was waiting.
          if (!isCurrent()) {
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
              if (unresolvedIds(error) || !isCurrent()) throw error;
              log(
                `Adding songs by details failed; using IDs: ${errorMessage(error)}`,
              );
            }
          }
          if (!isCurrent()) {
            throw new Error("Queue request is no longer current.");
          }
          await run(
            byId
              ? { songs: attemptTracks.map((track) => track.id) }
              : queueOptionsForTracks(attemptTracks),
          );
        },
        isCurrent,
      );
    } catch (error) {
      if (!isCurrent()) return [];
      throw error;
    }
    if (!isCurrent()) return [];
    const { entries, skipped } = resolved;
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

  return { insertTracks };
}

export type InsertTracks = ReturnType<typeof createQueueInsert>["insertTracks"];
