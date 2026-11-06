import type { Track } from "../domain/music.ts";
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

export function planClear(
  queue: readonly Track[],
  current: number,
): QueueEditPlan | undefined {
  if (current < 0 || current >= queue.length) {
    throw new Error("Queue item is unavailable.");
  }
  if (current === queue.length - 1) return undefined;
  return {
    next: queue.slice(0, current + 1),
    native: async (native) => {
      await native.splice(current + 1, queue.length - current - 1);
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

function sameQueue(
  left: { queue: readonly Track[]; index: number },
  right: { queue: readonly Track[]; index: number },
): boolean {
  return (
    left.index === right.index &&
    left.queue.length === right.queue.length &&
    left.queue.every(
      (track, position) => track.id === right.queue[position]?.id,
    )
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
  // Shuffle reorders upcoming songs on setQueue, which would corrupt the
  // explicit order. The lease keeps the user's desired mode separate.
  const releaseShuffleOverride = shuffled
    ? acquireShuffleModeOverride(instance, false)
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
        edit.next,
        before.index,
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
    setQueueSnapshot(applied.queue, applied.index);
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
