import type { Track } from "../domain/music.ts";
import { getState, setQueueSnapshot } from "../state.ts";
import {
  changeToMediaAtIndex,
  queueOptionsForTracks,
  readPlaybackModes,
  seekToTime,
  setShuffleMode,
  syncMusicKitQueue,
} from "./player.ts";

/**
 * native: the runtime exposes queue mutation methods. rebuild: the queue is
 * replaced and the current song reselected, which restarts audio briefly.
 * noop: the edit changes nothing.
 */
export type QueueEditTier = "native" | "rebuild" | "noop";

/** Undocumented in MusicKit JS v3; detected at runtime and never assumed. */
interface NativeQueue {
  remove(index: number): unknown;
  splice(index: number, options: MusicKit.QueueOptions): unknown;
  append?(options: MusicKit.QueueOptions): unknown;
}

export interface QueueEditPlan {
  /** Queue after the edit. The current index never changes. */
  next: Track[];
  native?: (queue: NativeQueue) => Promise<void>;
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
      await native.remove(index);
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
  const options = queueOptionsForTracks([moved]);
  return {
    next,
    native: async (native) => {
      await native.remove(from);
      // After removal the queue has one fewer item, so an end-slot insert
      // is an append.
      if (to === next.length - 1 && native.append) {
        await native.append(options);
      } else {
        await native.splice(to, options);
      }
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
      for (let index = queue.length - 1; index > current; index -= 1) {
        await native.remove(index);
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
  if (
    typeof methods.remove !== "function" ||
    typeof methods.splice !== "function"
  ) {
    return undefined;
  }
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

/** Replaces the provider queue, reselects the current song, and resumes. */
async function rebuildQueue(
  instance: MusicKit.MusicKitInstance,
  next: readonly Track[],
  index: number,
  positionSeconds: number,
): Promise<void> {
  if (!canSelectIndex(instance)) {
    throw new Error(
      "Editing the queue is not available in this MusicKit runtime.",
    );
  }
  const wasPlaying = instance.playbackState === MusicKit.PlaybackStates.playing;
  const shuffled = readPlaybackModes(instance).shuffleMode === "songs";
  // Shuffle reorders upcoming songs on setQueue, which would corrupt the
  // explicit order. Turn it off for the rebuild and restore it afterwards.
  if (shuffled && !setShuffleMode(instance, false)) {
    throw new Error("Shuffle must be off to edit the queue in this runtime.");
  }
  try {
    await instance.setQueue(queueOptionsForTracks(next));
    if (!(await changeToMediaAtIndex(instance, index))) {
      throw new Error(
        "Selecting a song in the MusicKit queue is not available in this runtime.",
      );
    }
    await seekToTime(instance, positionSeconds);
  } finally {
    if (shuffled) setShuffleMode(instance, true);
  }
  if (wasPlaying) await instance.play();
  else if (instance.playbackState === MusicKit.PlaybackStates.playing) {
    instance.pause();
  }
}

/**
 * Applies a plan to the provider queue. The snapshot is read before the
 * first await. If the provider changed the queue during the edit, the local
 * state is resynced from the provider instead of overwritten with the stale
 * result.
 */
export async function editQueue(
  instance: MusicKit.MusicKitInstance,
  plan: (queue: readonly Track[], current: number) => QueueEditPlan | undefined,
): Promise<QueueEditTier> {
  syncMusicKitQueue(instance);
  const playback = getState().playback;
  const before = { queue: [...playback.queue], index: playback.queueIndex };
  const edit = plan(before.queue, before.index);
  if (!edit) return "noop";
  const native = edit.native ? nativeQueueMethods(instance) : undefined;
  const tier: QueueEditTier = native && edit.native ? "native" : "rebuild";
  try {
    if (native && edit.native) await edit.native(native);
    else {
      await rebuildQueue(
        instance,
        edit.next,
        before.index,
        playback.positionSeconds,
      );
    }
  } catch (error) {
    syncMusicKitQueue(instance);
    throw error;
  }
  const now = getState().playback;
  const current = { queue: now.queue, index: now.queueIndex };
  if (
    sameQueue(current, before) ||
    sameQueue(current, { queue: edit.next, index: before.index })
  ) {
    setQueueSnapshot(edit.next, before.index);
    return tier;
  }
  syncMusicKitQueue(instance);
  throw new Error("The queue changed during this edit and was reloaded.");
}
