import type { Track } from "../domain/music.ts";
import { randomIndex } from "./collection-playback.ts";

/**
 * MusicKit fetches every queued song from Apple in parallel batches of 16, so
 * a few thousand songs means hundreds of requests per Play and rate limits.
 */
export const MAX_QUEUE_LENGTH = 500;
/** Songs kept before the chosen one, so Previous still has history. */
export const QUEUE_HISTORY_LENGTH = 100;

export interface QueueWindow {
  tracks: Track[];
  startIndex: number;
}

/**
 * Limits a queue to MAX_QUEUE_LENGTH songs. In order, it keeps a window
 * around the chosen song. Shuffled, it keeps the chosen song plus a random
 * sample of the whole list, so shuffle still draws from every song.
 */
export function windowQueue(
  tracks: readonly Track[],
  startIndex: number,
  shuffled: boolean,
): QueueWindow {
  if (tracks.length <= MAX_QUEUE_LENGTH) {
    return { tracks: [...tracks], startIndex };
  }
  if (shuffled) {
    const others = tracks
      .map((_, index) => index)
      .filter((index) => index !== startIndex);
    // Partial Fisher-Yates: only the sampled prefix is shuffled.
    const take = MAX_QUEUE_LENGTH - 1;
    for (let i = 0; i < take; i += 1) {
      const j = i + randomIndex(others.length - i);
      [others[i], others[j]] = [others[j], others[i]];
    }
    const chosen = tracks[startIndex];
    return {
      tracks: [
        ...(chosen ? [chosen] : []),
        ...others.slice(0, take).map((index) => tracks[index]),
      ],
      startIndex: 0,
    };
  }
  let start = Math.max(0, startIndex - QUEUE_HISTORY_LENGTH);
  const end = Math.min(tracks.length, start + MAX_QUEUE_LENGTH);
  start = Math.max(0, end - MAX_QUEUE_LENGTH);
  return { tracks: tracks.slice(start, end), startIndex: startIndex - start };
}
