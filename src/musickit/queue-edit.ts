import { isSameTrack, type Track } from "../domain/music.ts";
import { getState, setQueueSnapshot } from "../state.ts";
import {
  acquireShuffleModeOverride,
  changeToMediaAtIndex,
  latestTransportIntent,
  queueOptionsForTracks,
  readPlaybackModes,
  seekToTime,
  syncMusicKitQueue,
} from "./player.ts";
import { keptStartIndex, withResolvableTracks } from "./unresolved.ts";

/**
 * native: the runtime exposes queue mutation methods. rebuild: the queue is
 * replaced and the current song reselected, which restarts audio briefly.
 * noop: the edit changes nothing.
 */
export type QueueEditTier = "native" | "rebuild" | "noop";

/**
 * MusicKit JS v3 `Queue.splice(start, deleteCount, mediaItems)`: returns the
 * removed MediaItems. Undocumented, so it is detected at runtime and never
 * assumed. Re-inserting the removed MediaItem moves it without re-resolving.
 */
interface NativeQueue {
  splice(start: number, deleteCount: number, items?: unknown[]): unknown;
}

export interface QueueEditPlan {
  /** Queue after the edit. The current index never changes. */
  next: Track[];
  /**
   * What a rebuild sets when it differs from `next`. MusicKit tops autoplay
   * songs up again after a rebuild, so the plan may leave them out here.
   */
  rebuildNext?: Track[];
  /** Index to select when a rebuild runs. Defaults to the current index. */
  rebuildIndex?: number;
  native?: (queue: NativeQueue, isCurrent: () => boolean) => Promise<void>;
}

/**
 * How long a queued edit waits for the edit ahead of it before giving up on
 * it. A MusicKit call that never settles must not block future edits forever;
 * a generous window keeps normal slow rebuilds intact while still recovering.
 */
const QUEUE_EDIT_WATCHDOG_MS = 20_000;

interface QueueEditRun {
  /** Set by the edit behind this one when its watchdog gives up on it. */
  abandoned: boolean;
}

interface QueueEditChain {
  /** Settles when the edit that currently owns the chain finishes. */
  tail: Promise<void>;
  /** The edit `tail` belongs to, so a watchdog can abandon it. */
  current?: QueueEditRun;
}

/**
 * One chain per MusicKit instance: edits against one provider queue run one
 * after another, while a replaced instance (sign-out then in) starts clean.
 */
const editChains = new WeakMap<MusicKit.MusicKitInstance, QueueEditChain>();

function editChain(instance: MusicKit.MusicKitInstance): QueueEditChain {
  const existing = editChains.get(instance);
  if (existing) return existing;
  const chain: QueueEditChain = { tail: Promise.resolve() };
  editChains.set(instance, chain);
  return chain;
}

/**
 * Resolves true when the edit ahead settles, or false once the watchdog
 * window passes. The timer is cleared when that edit wins the race.
 */
function waitForPreviousEdit(
  previous: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    void previous.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function assertUpcoming(
  queue: readonly Track[],
  current: number,
  index: number,
  verb: string,
): void {
  if (!Number.isInteger(index) || index <= current || index >= queue.length) {
    throw new Error(`Only upcoming songs can be ${verb}.`);
  }
}

export function planRemove(
  queue: readonly Track[],
  current: number,
  index: number,
): QueueEditPlan {
  assertUpcoming(queue, current, index, "removed");
  return {
    next: queue.filter((_, position) => position !== index),
    native: async (native) => {
      await native.splice(index, 1);
    },
  };
}

/** Removes `count` upcoming songs from `start` on. */
export function planRemoveRange(
  queue: readonly Track[],
  current: number,
  start: number,
  count: number,
): QueueEditPlan | undefined {
  if (count <= 0) return undefined;
  assertUpcoming(queue, current, start, "removed");
  assertUpcoming(queue, current, start + count - 1, "removed");
  return {
    next: [...queue.slice(0, start), ...queue.slice(start + count)],
    native: async (native) => {
      await native.splice(start, count);
    },
  };
}

export function planMove(
  queue: readonly Track[],
  current: number,
  from: number,
  to: number,
): QueueEditPlan {
  assertUpcoming(queue, current, from, "moved");
  assertUpcoming(queue, current, to, "moved");
  if (from === to) throw new Error("The song is already in that position.");
  const next = [...queue];
  const [moved] = next.splice(from, 1);
  if (!moved) throw new Error("Queue item is unavailable.");
  next.splice(to, 0, moved);
  return {
    next,
    native: async (native, isCurrent) => {
      const removed = await native.splice(from, 1);
      if (!isCurrent()) {
        throw new Error("Queue edit is no longer current.");
      }
      if (!Array.isArray(removed) || removed.length !== 1) {
        throw new Error("The queue did not return the moved song.");
      }
      await native.splice(to, 0, removed);
    },
  };
}

/**
 * Runs of consecutive user songs after `current`, as queue positions. Autoplay
 * songs are skipped by flag, not by ID, so a duplicate ID never shifts a run.
 */
function upcomingUserRuns(
  queue: readonly Track[],
  current: number,
): { start: number; count: number }[] {
  const runs: { start: number; count: number }[] = [];
  for (let position = current + 1; position < queue.length; position += 1) {
    if (queue[position]?.autoplay) continue;
    const last = runs[runs.length - 1];
    if (last && last.start + last.count === position) last.count += 1;
    else runs.push({ start: position, count: 1 });
  }
  return runs;
}

/** Removes the user songs after `current`; autoplay songs stay in the queue. */
export function planClear(
  queue: readonly Track[],
  current: number,
): QueueEditPlan | undefined {
  if (current < 0 || current >= queue.length) {
    throw new Error("Queue item is unavailable.");
  }
  const runs = upcomingUserRuns(queue, current);
  if (runs.length === 0) return undefined;
  return {
    next: queue.filter(
      (track, position) => position <= current || !track.autoplay,
    ),
    // A rebuild keeps history and the current song; MusicKit tops up autoplay.
    rebuildNext: queue.slice(0, current + 1),
    native: async (native, isCurrent) => {
      // Back to front, so the earlier runs keep their positions.
      for (const run of [...runs].reverse()) {
        if (!isCurrent()) {
          throw new Error("Queue edit is no longer current.");
        }
        await native.splice(run.start, run.count);
      }
    },
  };
}

function nativeQueueMethods(
  instance: MusicKit.MusicKitInstance,
): NativeQueue | undefined {
  const queue = (instance as unknown as { queue?: unknown }).queue;
  if (!queue || typeof queue !== "object") return undefined;
  const methods = queue as Record<string, unknown>;
  if (typeof methods.splice !== "function") return undefined;
  return queue as NativeQueue;
}

function canSelectIndex(instance: MusicKit.MusicKitInstance): boolean {
  const player = (instance.player ?? instance) as unknown as Record<
    string,
    unknown
  >;
  const root = instance as unknown as Record<string, unknown>;
  return (
    typeof player.changeToMediaAtIndex === "function" ||
    typeof root.changeToMediaAtIndex === "function"
  );
}

/**
 * The queue without autoplay songs after `index`. Same rule as the app's
 * `withoutUpcomingAutoplay`, kept here because musickit does not import app.
 */
function withoutUpcomingAutoplay(
  queue: readonly Track[],
  index: number,
): Track[] {
  return queue.filter(
    (track, position) => position <= index || !track.autoplay,
  );
}

/**
 * Same index and same songs once upcoming autoplay is ignored. MusicKit tops
 * autoplay up on its own after an edit, so those songs are never stale here.
 */
function sameQueue(
  left: { queue: readonly Track[]; index: number },
  right: { queue: readonly Track[]; index: number },
): boolean {
  if (left.index !== right.index) return false;
  const leftQueue = withoutUpcomingAutoplay(left.queue, left.index);
  const rightQueue = withoutUpcomingAutoplay(right.queue, right.index);
  return (
    leftQueue.length === rightQueue.length &&
    leftQueue.every((track, position) => track.id === rightQueue[position]?.id)
  );
}

/**
 * Replaces the provider queue, reselects the current song, and resumes.
 * Returns the queue MusicKit actually received: songs it cannot resolve are
 * dropped, which can also move the current song's index. A Play or Pause the
 * user presses during the rebuild wins over the state captured at the start.
 */
async function rebuildQueue(
  instance: MusicKit.MusicKitInstance,
  next: readonly Track[],
  index: number,
  positionSeconds: number,
  onSkipped?: (count: number) => void,
  isCurrent: () => boolean = () => true,
): Promise<{ queue: Track[]; index: number }> {
  if (!isCurrent()) throw new Error("Queue edit is no longer current.");
  if (!canSelectIndex(instance)) {
    throw new Error(
      "Editing the queue is not available in this MusicKit runtime.",
    );
  }
  const wasPlaying = instance.playbackState === MusicKit.PlaybackStates.playing;
  const intentAtStart = latestTransportIntent().generation;
  const shuffled = readPlaybackModes(instance).shuffleMode === "songs";
  // Live MusicKit reshuffles the whole queue on every setQueue while its
  // shuffle is on, which would corrupt the explicit order. The override holds
  // it off. `restoreOnRelease: false` keeps that order on release (a keep-order
  // lease) instead of writing shuffle on, which would reshuffle the edit.
  const releaseShuffleOverride = shuffled
    ? acquireShuffleModeOverride(instance, false, { restoreOnRelease: false })
    : undefined;
  if (shuffled && !releaseShuffleOverride) {
    throw new Error("Shuffle must be off to edit the queue in this runtime.");
  }
  let applied: { queue: Track[]; index: number } = { queue: [...next], index };
  try {
    const { entries, skipped } = await withResolvableTracks(
      next,
      async (attempt) => {
        if (!isCurrent()) {
          throw new Error("Queue edit is no longer current.");
        }
        await instance.setQueue(
          queueOptionsForTracks(attempt.map((entry) => entry.track)),
        );
      },
      isCurrent,
    );
    if (!isCurrent()) throw new Error("Queue edit is no longer current.");
    if (skipped.length) onSkipped?.(skipped.length);
    applied = {
      queue: entries.map((entry) => entry.track),
      index: keptStartIndex(entries, index),
    };
    if (!(await changeToMediaAtIndex(instance, applied.index))) {
      throw new Error(
        "Selecting a song in the MusicKit queue is not available in this runtime.",
      );
    }
    if (!isCurrent()) throw new Error("Queue edit is no longer current.");
    await seekToTime(instance, positionSeconds);
  } finally {
    releaseShuffleOverride?.();
  }
  if (!isCurrent()) throw new Error("Queue edit is no longer current.");
  // Without a press during the rebuild, the state captured at the start stands.
  const intent = latestTransportIntent();
  const wantsPlaying =
    intent.generation === intentAtStart ? wasPlaying : intent.playing;
  if (wantsPlaying) await instance.play();
  else if (
    isCurrent() &&
    instance.playbackState === MusicKit.PlaybackStates.playing
  ) {
    instance.pause();
  }
  if (!isCurrent()) throw new Error("Queue edit is no longer current.");
  return applied;
}

/**
 * Applies a plan to the provider queue. The snapshot is read before the
 * first await. If the provider changed the queue during the edit, the local
 * state is resynced from the provider instead of overwritten with the stale
 * result.
 */
async function runQueueEdit(
  instance: MusicKit.MusicKitInstance,
  plan: (queue: readonly Track[], current: number) => QueueEditPlan | undefined,
  onSkipped: ((count: number) => void) | undefined,
  isCurrent: () => boolean,
): Promise<QueueEditTier> {
  syncMusicKitQueue(instance);
  if (!isCurrent()) return "noop";
  const playback = getState().playback;
  const before = { queue: [...playback.queue], index: playback.queueIndex };
  const edit = plan(before.queue, before.index);
  if (!edit) return "noop";
  const native = edit.native ? nativeQueueMethods(instance) : undefined;
  const tier: QueueEditTier = native && edit.native ? "native" : "rebuild";
  // The native path keeps the planned queue; a rebuild may drop unresolvable
  // songs, so it reports what was actually set.
  let applied = { queue: edit.next, index: before.index };
  try {
    if (native && edit.native) {
      if (!isCurrent()) return "noop";
      await edit.native(native, isCurrent);
    } else {
      applied = await rebuildQueue(
        instance,
        edit.rebuildNext ?? edit.next,
        edit.rebuildIndex ?? before.index,
        playback.positionSeconds,
        onSkipped,
        isCurrent,
      );
    }
  } catch (error) {
    if (isCurrent()) syncMusicKitQueue(instance);
    throw error;
  }
  if (!isCurrent()) return "noop";
  const now = getState().playback;
  const current = { queue: now.queue, index: now.queueIndex };
  if (sameQueue(current, before) || sameQueue(current, applied)) {
    // MusicKit tops autoplay up after an edit, and that top-up can land after
    // the plan's result was written. The provider is the authority when it can
    // be read; the plan's result is only the fallback for a hidden queue.
    if (!syncMusicKitQueue(instance)) {
      setQueueSnapshot(applied.queue, applied.index);
    }
    return tier;
  }
  syncMusicKitQueue(instance);
  throw new Error("The queue changed during this edit and was reloaded.");
}

/**
 * Runs one queue edit. Edits against the same MusicKit instance are queued:
 * each one waits for the edit ahead to settle before it reads local state and
 * plans, so consecutive clicks compose instead of racing the provider queue.
 * If that edit takes longer than the watchdog window, it is abandoned, the
 * provider queue is read back into local state, and this edit continues. An
 * abandoned edit re-checks the extra condition around every await, so its
 * late completion can never write local state.
 */
export async function editQueue(
  instance: MusicKit.MusicKitInstance,
  plan: (queue: readonly Track[], current: number) => QueueEditPlan | undefined,
  /** Told how many unplayable songs a rebuild dropped, so it can say so. */
  onSkipped?: (count: number) => void,
  isCurrent: () => boolean = () => true,
): Promise<QueueEditTier> {
  if (!isCurrent()) return "noop";
  const chain = editChain(instance);
  const previous = chain.tail;
  const pending = chain.current;
  const run: QueueEditRun = { abandoned: false };
  let settle = (): void => {};
  chain.tail = new Promise<void>((resolve) => {
    settle = resolve;
  });
  chain.current = run;
  try {
    // With nothing ahead, the edit starts synchronously as it always has; a
    // change that lands in the same turn stays "during the edit".
    if (pending) {
      const previousSettled = await waitForPreviousEdit(
        previous,
        QUEUE_EDIT_WATCHDOG_MS,
      );
      if (!previousSettled) {
        pending.abandoned = true;
        // Plan from what the provider actually holds now, not from the state
        // its stuck edit may never finish writing.
        if (isCurrent()) syncMusicKitQueue(instance);
      }
    }
    const current = (): boolean => !run.abandoned && isCurrent();
    if (!current()) return "noop";
    return await runQueueEdit(instance, plan, onSkipped, current);
  } catch (error) {
    // A successor already took over, so its report is the one that matters.
    if (run.abandoned) return "noop";
    throw error;
  } finally {
    settle();
    if (chain.current === run) chain.current = undefined;
  }
}

/**
 * Resolves once the queued edits for `instance` have settled, or once the
 * watchdog window passes. A shuffle toggle waits here so it never plans
 * against an edit that is still writing the provider queue.
 */
export async function settleQueueEdits(
  instance: MusicKit.MusicKitInstance,
): Promise<void> {
  const chain = editChain(instance);
  for (;;) {
    const tail = chain.tail;
    const settled = await waitForPreviousEdit(tail, QUEUE_EDIT_WATCHDOG_MS);
    if (!settled || chain.tail === tail) return;
  }
}

/** Track keys that identify a song, as `isSameTrack` compares them. */
function trackKeys(track: Pick<Track, "id" | "catalogId">): string[] {
  return [...new Set([track.id, track.catalogId])].filter(
    (key): key is string => Boolean(key),
  );
}

/**
 * A multiset of songs. `take` removes one copy of the song from the pool and
 * reports whether there was one, so duplicate IDs are counted, not merged.
 */
function trackPool(tracks: readonly Track[]) {
  const buckets = new Map<string, { track: Track; used: boolean }[]>();
  for (const track of tracks) {
    const entry = { track, used: false };
    for (const key of trackKeys(track)) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(entry);
      else buckets.set(key, [entry]);
    }
  }
  return {
    take(track: Track): boolean {
      for (const key of trackKeys(track)) {
        const hit = (buckets.get(key) ?? []).find(
          (entry) => !entry.used && isSameTrack(entry.track, track),
        );
        if (hit) {
          hit.used = true;
          return true;
        }
      }
      return false;
    },
  };
}

/** Where a collection song is now: in the queue, still in the rest, or neither. */
type CollectionPlace = "queued" | "rest" | "missing";

/**
 * Sorts each collection song by where it is. The playing occurrence is taken
 * first, so a duplicate ID resolves to the copy that is playing; the other
 * copies follow in collection order. Undefined when the playing song is not
 * among the queued songs, so the collection cannot be placed.
 */
function collectionPlaces(
  collection: readonly Track[],
  playing: number,
  queued: readonly Track[],
  rest: readonly Track[],
): CollectionPlace[] | undefined {
  const queuePool = trackPool(queued);
  const restPool = trackPool(rest);
  const playingTrack = collection[playing];
  if (!playingTrack || !queuePool.take(playingTrack)) return undefined;
  return collection.map((track, occurrence): CollectionPlace => {
    if (occurrence === playing) return "queued";
    if (queuePool.take(track)) return "queued";
    return restPool.take(track) ? "rest" : "missing";
  });
}

/**
 * The songs a shuffle turned on has to add so the whole collection is in play:
 * the collection songs neither queued nor in the rest (songs before the
 * playing one, and any after it), then the rest itself. Undefined when the
 * collection cannot be placed.
 */
export function shuffleOnAdds(
  collection: readonly Track[],
  playing: number,
  queued: readonly Track[],
  rest: readonly Track[],
): Track[] | undefined {
  const places = collectionPlaces(collection, playing, queued, rest);
  if (!places) return undefined;
  return [
    ...collection.filter((_, occurrence) => places[occurrence] === "missing"),
    ...rest,
  ];
}

export interface RestoreOrderInput {
  /** The whole ordered list the latest Play started. */
  collection: readonly Track[];
  /** Collection index of the song playing now. */
  playing: number;
  /** User songs in the provider queue before shuffle went off. */
  queued: readonly Track[];
  /** Songs not yet in the provider queue before shuffle went off. */
  rest: readonly Track[];
  /** Upcoming autoplay songs, kept after the user songs. */
  autoplay: readonly Track[];
  /** The provider queue as it reads now, after shuffle went off. */
  provider: readonly Track[];
  /** Index of the playing song in `provider`. */
  providerIndex: number;
}

export interface RestoreOrder {
  /** Songs before the restored run, kept for Previous. */
  startHistory: Track[];
  /** The restored user songs, in collection order. */
  queue: Track[];
  /** Collection index of each song in `queue`. */
  occurrences: number[];
  /** Position of the playing song in `queue`. */
  index: number;
  /** Songs after the run, in collection order, appended as the queue drains. */
  rest: Track[];
}

/**
 * Puts the collection back in album order when shuffle goes off. The run is
 * the contiguous stretch of queued songs around the playing one, so the
 * upcoming songs are in collection order. Songs before the run go to the
 * Previous history, and songs after it go to the rest, so the queue never
 * shows an order the collection does not have. `plan` is undefined when the
 * provider already holds that queue. Undefined when the collection cannot be
 * placed.
 */
export function planRestoreOrder(
  input: RestoreOrderInput,
): { order: RestoreOrder; plan: QueueEditPlan | undefined } | undefined {
  const { collection, playing, queued, rest, autoplay, provider } = input;
  const places = collectionPlaces(collection, playing, queued, rest);
  if (!places) return undefined;
  // Missing songs do not break a run: they are not in the list any more.
  let first = playing;
  for (let occurrence = playing - 1; occurrence >= 0; occurrence -= 1) {
    const place = places[occurrence];
    if (place === "missing") continue;
    if (place !== "queued") break;
    first = occurrence;
  }
  let last = playing;
  for (
    let occurrence = playing + 1;
    occurrence < collection.length;
    occurrence += 1
  ) {
    const place = places[occurrence];
    if (place === "missing") continue;
    if (place !== "queued") break;
    last = occurrence;
  }
  const queue: Track[] = [];
  const occurrences: number[] = [];
  for (let occurrence = first; occurrence <= last; occurrence += 1) {
    const track = collection[occurrence];
    if (track && places[occurrence] === "queued") {
      queue.push(track);
      occurrences.push(occurrence);
    }
  }
  const index = occurrences.indexOf(playing);
  if (index < 0) return undefined;
  const order: RestoreOrder = {
    startHistory: collection.filter(
      (_, occurrence) => occurrence < first && places[occurrence] !== "missing",
    ),
    queue,
    occurrences,
    index,
    rest: collection.filter(
      (_, occurrence) => occurrence > last && places[occurrence] !== "missing",
    ),
  };
  const providerUser = provider.filter((track) => !track.autoplay);
  const unchanged =
    input.providerIndex === index &&
    providerUser.length === queue.length &&
    queue.every((track, position) =>
      isSameTrack(track, providerUser[position]),
    );
  if (unchanged) return { order, plan: undefined };
  return {
    order,
    plan: {
      next: [...queue, ...autoplay],
      rebuildNext: queue,
      rebuildIndex: index,
    },
  };
}

/**
 * Collection index for each queue position, -1 for autoplay songs and songs
 * not in the collection. The playing position takes `playing` when it names
 * the same song. Other positions keep their `previous` label while it still
 * names the song, and any left take the lowest copy not yet claimed.
 */
export function labelOccurrences(
  collection: readonly Track[],
  queue: readonly Track[],
  index: number,
  previous: readonly number[],
  playing?: number,
): number[] {
  const byKey = new Map<string, number[]>();
  collection.forEach((track, occurrence) => {
    for (const key of trackKeys(track)) {
      const bucket = byKey.get(key);
      if (bucket) bucket.push(occurrence);
      else byKey.set(key, [occurrence]);
    }
  });
  const candidates = (track: Track): number[] => {
    const found = new Set<number>();
    for (const key of trackKeys(track)) {
      for (const occurrence of byKey.get(key) ?? []) found.add(occurrence);
    }
    return [...found]
      .sort((left, right) => left - right)
      .filter((occurrence) => isSameTrack(collection[occurrence], track));
  };
  const labels = queue.map((): number => -1);
  const taken = new Set<number>();
  const claim = (position: number, occurrence: number): void => {
    labels[position] = occurrence;
    taken.add(occurrence);
  };
  const playingTrack = queue[index];
  if (
    playing !== undefined &&
    playingTrack &&
    !playingTrack.autoplay &&
    candidates(playingTrack).includes(playing)
  ) {
    claim(index, playing);
  }
  queue.forEach((track, position) => {
    if (labels[position] !== -1 || track.autoplay) return;
    const prior = previous[position];
    if (
      prior !== undefined &&
      prior >= 0 &&
      !taken.has(prior) &&
      candidates(track).includes(prior)
    ) {
      claim(position, prior);
    }
  });
  queue.forEach((track, position) => {
    if (labels[position] !== -1 || track.autoplay) return;
    const free = candidates(track).find((occurrence) => !taken.has(occurrence));
    if (free !== undefined) claim(position, free);
  });
  return labels;
}
