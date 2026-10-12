import type { Track } from "../domain/music.ts";
import { randomIndex } from "./collection-playback.ts";

/**
 * MusicKit fetches every queued song from Apple, 16 per request, before Play
 * can start. A 500-song queue took over a second and, with ~32 requests at
 * once, sometimes failed outright; so a Play queues a short window and the
 * rest follows in the background as the queue runs low.
 */
export const INITIAL_QUEUE_LENGTH = 100;
/** Most songs one Play next or Play later adds at once. */
export const MAX_QUEUE_LENGTH = 500;
/** Songs kept before the chosen one, so Previous still has history. */
export const QUEUE_HISTORY_LENGTH = 20;
/** Refill when fewer upcoming songs than this remain in the queue. */
export const QUEUE_REFILL_THRESHOLD = 50;
/** Songs appended per refill. */
export const QUEUE_REFILL_SIZE = 100;

export interface QueueWindow {
  tracks: Track[];
  startIndex: number;
  /** Songs after the window, in play order, appended as the queue drains. */
  rest: Track[];
}

/**
 * Index of `trackId` nearest `index`, or -1 when it is gone. Lists can shift
 * between what the user saw and what is played, so a chosen position is
 * re-checked against the chosen song.
 */
export function nearestTrackIndex(
  tracks: readonly Track[],
  index: number,
  trackId: string,
): number {
  if (tracks[index]?.id === trackId) return index;
  let nearest = -1;
  tracks.forEach((track, position) => {
    if (track.id !== trackId) return;
    if (nearest < 0 || Math.abs(position - index) < Math.abs(nearest - index)) {
      nearest = position;
    }
  });
  return nearest;
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
 * Limits a queue to INITIAL_QUEUE_LENGTH songs. In order, it keeps a window
 * around the chosen song. Shuffled, it keeps the chosen song plus a random
 * sample of the whole list, so shuffle still draws from every song. The
 * remaining songs are returned in play order for later refills.
 */
export function windowQueue(
  tracks: readonly Track[],
  startIndex: number,
  shuffled: boolean,
): QueueWindow {
  if (tracks.length <= INITIAL_QUEUE_LENGTH) {
    return { tracks: [...tracks], startIndex, rest: [] };
  }
  if (shuffled) {
    const others = shuffledCopy(
      tracks.filter((_, index) => index !== startIndex),
    );
    const take = INITIAL_QUEUE_LENGTH - 1;
    const chosen = tracks[startIndex];
    return {
      tracks: [...(chosen ? [chosen] : []), ...others.slice(0, take)],
      startIndex: 0,
      rest: others.slice(take),
    };
  }
  let start = Math.max(0, startIndex - QUEUE_HISTORY_LENGTH);
  const end = Math.min(tracks.length, start + INITIAL_QUEUE_LENGTH);
  start = Math.max(0, end - INITIAL_QUEUE_LENGTH);
  return {
    tracks: tracks.slice(start, end),
    startIndex: startIndex - start,
    rest: tracks.slice(end),
  };
}
