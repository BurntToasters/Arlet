import type { Track } from "../domain/music.ts";
import { randomIndex } from "./collection-playback.ts";

/**
 * MusicKit fetches every queued song from Apple in parallel batches of 16, so
 * a few thousand songs means hundreds of requests per Play and rate limits.
 */
export const MAX_QUEUE_LENGTH = 500;
/** Songs kept before the chosen one, so Previous still has history. */
export const QUEUE_HISTORY_LENGTH = 100;
/** Refill when fewer upcoming songs than this remain in the queue. */
export const QUEUE_REFILL_THRESHOLD = 100;
/** Songs appended per refill. */
export const QUEUE_REFILL_SIZE = 200;

export interface QueueWindow {
  tracks: Track[];
  startIndex: number;
  /** Songs after the window, in play order, appended as the queue drains. */
  rest: Track[];
}

/** Fisher-Yates over a copy. */
export function shuffledCopy<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    // Both indexes are in range, so the reads are real items.
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

/**
 * Limits a queue to MAX_QUEUE_LENGTH songs. In order, it keeps a window
 * around the chosen song. Shuffled, it keeps the chosen song plus a random
 * sample of the whole list, so shuffle still draws from every song. The
 * remaining songs are returned in play order for later refills.
 */
export function windowQueue(
  tracks: readonly Track[],
  startIndex: number,
  shuffled: boolean,
): QueueWindow {
  if (tracks.length <= MAX_QUEUE_LENGTH) {
    return { tracks: [...tracks], startIndex, rest: [] };
  }
  if (shuffled) {
    const others = shuffledCopy(
      tracks.filter((_, index) => index !== startIndex),
    );
    const take = MAX_QUEUE_LENGTH - 1;
    const chosen = tracks[startIndex];
    return {
      tracks: [...(chosen ? [chosen] : []), ...others.slice(0, take)],
      startIndex: 0,
      rest: others.slice(take),
    };
  }
  let start = Math.max(0, startIndex - QUEUE_HISTORY_LENGTH);
  const end = Math.min(tracks.length, start + MAX_QUEUE_LENGTH);
  start = Math.max(0, end - MAX_QUEUE_LENGTH);
  return {
    tracks: tracks.slice(start, end),
    startIndex: startIndex - start,
    rest: tracks.slice(end),
  };
}
