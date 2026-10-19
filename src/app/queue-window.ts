import type { Track } from "../domain/music.ts";
import { randomIndex } from "./collection-playback.ts";

/**
 * MusicKit fetches every queued song from Apple, 16 per request, before Play
 * can start. A Play therefore queues only the chosen song and the next few,
 * one request's worth, as MusicKit's first items; the rest is appended in the
 * background once audio starts (see QUEUE_REFILL_THRESHOLD).
 */
export const FIRST_BATCH_LENGTH = 16;
/**
 * With shuffle on, lists up to this size are handed to MusicKit whole so it
 * can shuffle and unshuffle them; longer ones are sampled by Arlet.
 */
export const SHUFFLE_IN_ORDER_LIMIT = 100;
/** Most songs one Play next or Play later adds at once. */
export const MAX_QUEUE_LENGTH = 500;
/**
 * Songs before the chosen one that Arlet keeps, so Previous on the first
 * queued song can step back through the playlist. MusicKit's queue starts at
 * the chosen song: songs before it would make MusicKit prepare the wrong item
 * and then switch (a re-select that cost about 1.3 seconds).
 */
export const QUEUE_HISTORY_LENGTH = 20;
/** Refill when fewer upcoming songs than this remain in the queue. */
export const QUEUE_REFILL_THRESHOLD = 50;
/** Songs appended per refill. */
export const QUEUE_REFILL_SIZE = 100;

export interface StartWindow {
  /** Songs before the chosen one, kept by Arlet for Previous. */
  history: Track[];
  /** MusicKit's first items. */
  batch: Track[];
  /** The chosen song's position in `batch`: 0 except a whole short shuffle. */
  startIndex: number;
  /** Songs after the batch, in play order, appended as the queue drains. */
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

/** Options for one Play. */
export interface PlayOptions {
  /**
   * Resumes a parked queue in its saved order, even with shuffle on. Songs
   * before the chosen one are history only, never upcoming.
   */
  keepOrder?: boolean;
}

/**
 * Splits a Play into Arlet-side history, MusicKit's first batch (the chosen
 * song first), and the rest. Shuffled, the chosen song leads a random order
 * of the whole list, so shuffle still draws from every song. With `keepOrder`
 * the split is always the in-order one.
 */
export function startWindow(
  tracks: readonly Track[],
  startIndex: number,
  shuffled: boolean,
  options: PlayOptions = {},
): StartWindow {
  const chosen = tracks[startIndex];
  if (!chosen) return { history: [], batch: [], startIndex: 0, rest: [] };
  const shuffle = shuffled && !options.keepOrder;
  // A short list goes to MusicKit whole and in order: MusicKit shuffles it
  // with the chosen song first (`startWith`), and turning shuffle off then
  // restores the playlist order.
  if (shuffle && tracks.length <= SHUFFLE_IN_ORDER_LIMIT) {
    return { history: [], batch: [...tracks], startIndex, rest: [] };
  }
  if (shuffle) {
    const others = shuffledCopy(
      tracks.filter((_, index) => index !== startIndex),
    );
    const take = FIRST_BATCH_LENGTH - 1;
    return {
      history: [],
      batch: [chosen, ...others.slice(0, take)],
      startIndex: 0,
      rest: others.slice(take),
    };
  }
  return {
    history: tracks.slice(
      Math.max(0, startIndex - QUEUE_HISTORY_LENGTH),
      startIndex,
    ),
    batch: tracks.slice(startIndex, startIndex + FIRST_BATCH_LENGTH),
    startIndex: 0,
    rest: tracks.slice(startIndex + FIRST_BATCH_LENGTH),
  };
}
