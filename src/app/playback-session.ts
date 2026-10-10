import { z } from "zod";
import type { Track } from "../domain/music.ts";
import {
  deletePlaybackSessionPayload,
  loadPlaybackSessionPayload,
  savePlaybackSessionPayload,
  type InvokeFunction,
} from "../platform/playback-session.ts";
import {
  getState,
  setPendingRestore,
  setPlaybackPosition,
  setPlaybackStatus,
  setQueueSnapshot,
  subscribe,
  subscribePlaybackPosition,
} from "../state.ts";
import { safeErrorMessage } from "./controller-support.ts";

export const MAX_SESSION_ITEMS = 500;
/** Must match MAX_SESSION_BYTES in src-tauri/src/playback_session.rs. */
export const MAX_SESSION_BYTES = 256 * 1024;
export const SESSION_SAVE_DEBOUNCE_MS = 2_000;
export const SESSION_SAVE_INTERVAL_MS = 15_000;

const utf8Encoder = new TextEncoder();

const artworkSchema = z.object({
  url: z.string().startsWith("https://").max(2048),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

/**
 * Only id, title, and artist are required. Optional fields that fail
 * validation are dropped instead of dropping the whole track.
 */
const trackLiteSchema = z.object({
  id: z.string().min(1).max(512),
  catalogId: z.string().min(1).max(512).optional().catch(undefined),
  resourceType: z.string().min(1).max(100).optional().catch(undefined),
  title: z.string().min(1).max(1000),
  artistName: z.string().max(1000),
  albumTitle: z.string().max(1000).optional().catch(undefined),
  artwork: artworkSchema.optional().catch(undefined),
  durationMs: z.number().positive().optional().catch(undefined),
});

const sessionSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(z.unknown()).max(MAX_SESSION_ITEMS),
  index: z.number().catch(0),
  positionSeconds: z.number().nonnegative().catch(0),
  savedAt: z.number().nonnegative().catch(0),
});

export interface PlaybackSessionSnapshot {
  tracks: Track[];
  index: number;
  positionSeconds: number;
  durationSeconds: number;
  savedAt: number;
}

function parseRaw(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Validates a stored session. The index follows its track when earlier
 * entries are dropped, and the position is clamped to the track's duration.
 */
export function parsePlaybackSession(
  raw: unknown,
): PlaybackSessionSnapshot | undefined {
  const envelope = sessionSchema.safeParse(parseRaw(raw));
  if (!envelope.success || envelope.data.items.length === 0) return undefined;
  const { items, positionSeconds, savedAt } = envelope.data;
  const wanted = Math.max(
    0,
    Math.min(Math.trunc(envelope.data.index), items.length - 1),
  );
  const tracks: Track[] = [];
  let index = 0;
  items.forEach((item, position) => {
    if (position === wanted) index = tracks.length;
    const candidate = trackLiteSchema.safeParse(item);
    if (candidate.success) tracks.push(candidate.data);
  });
  if (tracks.length === 0) return undefined;
  const selected = tracks[Math.min(index, tracks.length - 1)];
  if (!selected) return undefined;
  const durationSeconds = selected.durationMs ? selected.durationMs / 1000 : 0;
  const maxPosition =
    durationSeconds > 0 ? durationSeconds : Number.POSITIVE_INFINITY;
  return {
    tracks,
    index: Math.min(index, tracks.length - 1),
    positionSeconds: Math.min(positionSeconds, maxPosition),
    durationSeconds,
    savedAt,
  };
}

/** Writes a bounded UTF-8 snapshot window that always contains the current track. */
export function serializePlaybackSession(snapshot: {
  tracks: readonly Track[];
  index: number;
  positionSeconds: number;
  savedAt: number;
}): string {
  const currentIndex = snapshot.tracks.length
    ? Math.max(
        0,
        Math.min(Math.trunc(snapshot.index), snapshot.tracks.length - 1),
      )
    : 0;
  const windowStart = Math.max(
    0,
    Math.min(
      currentIndex - Math.floor(MAX_SESSION_ITEMS / 2),
      snapshot.tracks.length - MAX_SESSION_ITEMS,
    ),
  );
  const windowEnd = Math.min(
    windowStart + MAX_SESSION_ITEMS,
    snapshot.tracks.length,
  );
  const selectedIndex = currentIndex - windowStart;
  let start = 0;
  let end = windowEnd - windowStart;
  const items: Record<string, unknown>[] = snapshot.tracks
    .slice(windowStart, windowEnd)
    .map((track) => ({
      id: track.id,
      catalogId: track.catalogId,
      resourceType: track.resourceType,
      title: track.title,
      artistName: track.artistName,
      albumTitle: track.albumTitle,
      artwork: track.artwork
        ? {
            url: track.artwork.url,
            width: track.artwork.width,
            height: track.artwork.height,
          }
        : undefined,
      durationMs: track.durationMs,
    }));
  const itemBytes = items.map(
    (item) => utf8Encoder.encode(JSON.stringify(item)).byteLength,
  );
  // prefixBytes[n] is the total size of the first n items.
  const prefixBytes = [0];
  for (const size of itemBytes) {
    prefixBytes.push((prefixBytes.at(-1) ?? 0) + size);
  }
  const prefixAt = (position: number): number => prefixBytes[position] ?? 0;

  const serializedSize = (): number => {
    const count = end - start;
    const index = count > 0 ? selectedIndex - start : 0;
    const envelope = JSON.stringify({
      schemaVersion: 1,
      items: [],
      index,
      positionSeconds: snapshot.positionSeconds,
      savedAt: snapshot.savedAt,
    });
    const envelopeBytes = utf8Encoder.encode(envelope).byteLength;
    if (count === 0) return envelopeBytes;
    return envelopeBytes + prefixAt(end) - prefixAt(start) + count - 1;
  };

  while (end - start > 1 && serializedSize() > MAX_SESSION_BYTES) {
    const leftOfCurrent = selectedIndex - start;
    const rightOfCurrent = end - 1 - selectedIndex;
    if (
      leftOfCurrent > 0 &&
      (leftOfCurrent >= rightOfCurrent || rightOfCurrent === 0)
    ) {
      start += 1;
    } else if (rightOfCurrent > 0) {
      end -= 1;
    } else {
      break;
    }
  }

  if (end - start === 1 && serializedSize() > MAX_SESSION_BYTES) {
    const current = snapshot.tracks[currentIndex];
    if (!current) throw new RangeError("The current track is missing.");
    items[start] = {
      id: current.id,
      title: current.title,
      artistName: current.artistName,
    };
    itemBytes[start] = utf8Encoder.encode(
      JSON.stringify(items[start]),
    ).byteLength;
    prefixBytes[0] = 0;
    for (let position = 0; position < itemBytes.length; position += 1) {
      prefixBytes[position + 1] =
        prefixAt(position) + (itemBytes[position] ?? 0);
    }
    if (serializedSize() > MAX_SESSION_BYTES) {
      throw new RangeError(
        "The current track exceeds the playback session size limit.",
      );
    }
  }

  const index = end > start ? selectedIndex - start : 0;
  const json = JSON.stringify({
    schemaVersion: 1,
    items: items.slice(start, end),
    index,
    positionSeconds: snapshot.positionSeconds,
    savedAt: snapshot.savedAt,
  });
  if (utf8Encoder.encode(json).byteLength > MAX_SESSION_BYTES) {
    throw new RangeError("Playback session exceeds the serialized size limit.");
  }
  return json;
}

export interface PlaybackSessionDependencies {
  invokeFn?: InvokeFunction;
  now?: () => number;
  log: (message: string) => void;
  playTracks: (tracks: readonly Track[], startIndex: number) => Promise<void>;
  seek: (seconds: number) => Promise<void>;
  /**
   * Changes with every play request. When it moved during the restored play,
   * a newer play replaced it and the saved position must not be applied.
   */
  playIntent?: () => number;
}

export interface PlaybackSession {
  /** Begins observing playback so queue changes are saved. Idempotent. */
  start(): void;
  stop(): void;
  /** Settings must be loaded before the saved file is read. */
  markSettingsLoaded(): void;
  /** Reads the saved queue once MusicKit is ready and the user is signed in. */
  tryRestore(): void;
  /**
   * Starts the restored queue on the first play request. Resolves true when
   * it handled the request, so the caller skips the normal toggle.
   */
  resumePendingRestore(): Promise<boolean>;
  /** True while the restored queue is being started. */
  isResuming(): boolean;
  /** Deletes the saved file and cancels any save already scheduled. */
  clear(): Promise<void>;
}

/**
 * Saves and restores the queue. Nothing is sent to MusicKit until the user
 * presses play. Every file operation runs in order on one chain.
 */
export function createPlaybackSession(
  dependencies: PlaybackSessionDependencies,
): PlaybackSession {
  const { invokeFn } = dependencies;
  const now = dependencies.now ?? Date.now;
  let started = false;
  let settingsLoaded = false;
  let restoreStarted = false;
  // Saves stay off until the saved file has been read or deliberately skipped;
  // otherwise an early save would overwrite the file before it is restored.
  let ready = false;
  // Bumped on clear so an in-flight load or save cannot bring the file back.
  let generation = 0;
  let chain: Promise<void> = Promise.resolve();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSaveAt = Number.NEGATIVE_INFINITY;
  let resuming: Promise<void> | undefined;
  let observed = {
    queue: getState().playback.queue,
    index: getState().playback.queueIndex,
    status: getState().playback.status,
  };
  let unsubscribeState: (() => void) | undefined;
  let unsubscribePosition: (() => void) | undefined;

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = chain.then(() => task());
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const cancelSaveTimer = (): void => {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = undefined;
  };

  const canSave = (): boolean => {
    const state = getState();
    return (
      ready &&
      state.auth.status === "authorized" &&
      state.settings.restoreSession &&
      state.playback.queue.length > 0
    );
  };

  const persist = (): void => {
    if (!canSave()) return;
    const { playback } = getState();
    const savedAt = now();
    let json: string;
    try {
      json = serializePlaybackSession({
        tracks: playback.queue,
        index: playback.queueIndex,
        positionSeconds: playback.positionSeconds,
        savedAt,
      });
    } catch (error) {
      // Runs inside timers, pagehide, and position subscribers; a throw here
      // would stop the remaining subscribers.
      dependencies.log(
        `Playback session not saved: ${safeErrorMessage(error)}`,
      );
      return;
    }
    lastSaveAt = savedAt;
    const saveGeneration = generation;
    void enqueue(async () => {
      if (saveGeneration !== generation) return;
      await savePlaybackSessionPayload(json, invokeFn);
    }).catch((error: unknown) => {
      dependencies.log(
        `Playback session save failed: ${safeErrorMessage(error)}`,
      );
    });
  };

  const scheduleSave = (): void => {
    cancelSaveTimer();
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      persist();
    }, SESSION_SAVE_DEBOUNCE_MS);
  };

  const flushSave = (): void => {
    cancelSaveTimer();
    persist();
  };

  const onStateChange = (): void => {
    const { playback } = getState();
    if (
      playback.queue === observed.queue &&
      playback.queueIndex === observed.index &&
      playback.status === observed.status
    ) {
      return;
    }
    observed = {
      queue: playback.queue,
      index: playback.queueIndex,
      status: playback.status,
    };
    scheduleSave();
  };

  // Position ticks arrive several times a second; at most one write per interval.
  const onPosition = (): void => {
    if (now() - lastSaveAt < SESSION_SAVE_INTERVAL_MS) return;
    persist();
  };

  const onPageHide = (): void => flushSave();
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") flushSave();
  };

  const applySnapshot = (
    snapshot: PlaybackSessionSnapshot | undefined,
  ): void => {
    if (!snapshot) return;
    // Playback the user started while the file was loading wins.
    if (getState().playback.queue.length > 0) return;
    setQueueSnapshot(snapshot.tracks, snapshot.index, false);
    setPlaybackStatus("paused");
    setPlaybackPosition(snapshot.positionSeconds, snapshot.durationSeconds);
    setPendingRestore({
      positionSeconds: snapshot.positionSeconds,
      savedAt: snapshot.savedAt,
    });
    dependencies.log(
      `Restored ${snapshot.tracks.length} queued tracks, paused. Press play to resume.`,
    );
  };

  const tryRestore = (): void => {
    if (restoreStarted || !settingsLoaded) return;
    const state = getState();
    if (state.initialization.status !== "ready") return;
    restoreStarted = true;
    // Only an authorized account with restore enabled reads the file. Other
    // cases need no read, so saves can start right away.
    if (state.auth.status !== "authorized" || !state.settings.restoreSession) {
      ready = true;
      return;
    }
    const restoreGeneration = generation;
    void enqueue(() => loadPlaybackSessionPayload(invokeFn))
      .then((raw) => {
        if (restoreGeneration === generation) {
          applySnapshot(parsePlaybackSession(raw));
        }
      })
      .catch((error: unknown) => {
        dependencies.log(
          `Playback session restore failed: ${safeErrorMessage(error)}`,
        );
      })
      .finally(() => {
        ready = true;
      });
  };

  const resumeRestoredQueue = async (): Promise<void> => {
    const { playback } = getState();
    const pending = playback.pendingRestore;
    try {
      const played = dependencies.playTracks(
        playback.queue,
        playback.queueIndex,
      );
      // playTracks registers its request before its first await.
      const intent = dependencies.playIntent?.();
      await played;
      const replaced =
        intent !== undefined && dependencies.playIntent?.() !== intent;
      if (!replaced && pending && pending.positionSeconds > 0) {
        try {
          await dependencies.seek(pending.positionSeconds);
        } catch (error) {
          dependencies.log(
            `Restored position not applied: ${safeErrorMessage(error)}`,
          );
        }
      }
    } finally {
      // Cleared even on failure, so a stale restore cannot retry forever.
      setPendingRestore(undefined);
    }
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      observed = {
        queue: getState().playback.queue,
        index: getState().playback.queueIndex,
        status: getState().playback.status,
      };
      unsubscribeState = subscribe(onStateChange);
      unsubscribePosition = subscribePlaybackPosition(onPosition);
      if (typeof window !== "undefined") {
        window.addEventListener("pagehide", onPageHide);
      }
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibilityChange);
      }
    },

    stop(): void {
      if (!started) return;
      started = false;
      unsubscribeState?.();
      unsubscribePosition?.();
      unsubscribeState = undefined;
      unsubscribePosition = undefined;
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", onPageHide);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      cancelSaveTimer();
    },

    markSettingsLoaded(): void {
      settingsLoaded = true;
      tryRestore();
    },

    tryRestore,

    isResuming: (): boolean => resuming !== undefined,

    resumePendingRestore(): Promise<boolean> {
      // A second press while the first resume is running waits for it.
      if (resuming) return resuming.then(() => true);
      const { playback } = getState();
      if (!playback.pendingRestore) return Promise.resolve(false);
      if (playback.queue.length === 0) {
        setPendingRestore(undefined);
        return Promise.resolve(false);
      }
      resuming = resumeRestoredQueue().finally(() => {
        resuming = undefined;
      });
      return resuming.then(() => true);
    },

    async clear(): Promise<void> {
      generation += 1;
      cancelSaveTimer();
      if (getState().playback.pendingRestore) setPendingRestore(undefined);
      try {
        await enqueue(() => deletePlaybackSessionPayload(invokeFn));
      } catch (error) {
        dependencies.log(
          `Playback session clear failed: ${safeErrorMessage(error)}`,
        );
      }
    },
  };
}
