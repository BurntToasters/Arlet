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
export const SESSION_SAVE_DEBOUNCE_MS = 2_000;
export const SESSION_SAVE_INTERVAL_MS = 15_000;

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

/** Writes at most MAX_SESSION_ITEMS entries, windowed around the current track. */
export function serializePlaybackSession(snapshot: {
  tracks: readonly Track[];
  index: number;
  positionSeconds: number;
  savedAt: number;
}): string {
  const start = Math.max(
    0,
    Math.min(
      snapshot.index - Math.floor(MAX_SESSION_ITEMS / 2),
      snapshot.tracks.length - MAX_SESSION_ITEMS,
    ),
  );
  const window = snapshot.tracks.slice(start, start + MAX_SESSION_ITEMS);
  const index = Math.max(
    0,
    Math.min(snapshot.index - start, window.length - 1),
  );
  return JSON.stringify({
    schemaVersion: 1,
    items: window.map((track) => ({
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
    })),
    index,
    positionSeconds: snapshot.positionSeconds,
    savedAt: snapshot.savedAt,
  });
}

export interface PlaybackSessionDependencies {
  invokeFn?: InvokeFunction;
  now?: () => number;
  log: (message: string) => void;
  playTracks: (tracks: readonly Track[], startIndex: number) => Promise<void>;
  seek: (seconds: number) => Promise<void>;
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
    lastSaveAt = savedAt;
    const json = serializePlaybackSession({
      tracks: playback.queue,
      index: playback.queueIndex,
      positionSeconds: playback.positionSeconds,
      savedAt,
    });
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
    setQueueSnapshot(snapshot.tracks, snapshot.index);
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
      await dependencies.playTracks(playback.queue, playback.queueIndex);
      if (pending && pending.positionSeconds > 0) {
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

    resumePendingRestore(): Promise<boolean> {
      const { playback } = getState();
      if (!playback.pendingRestore) return Promise.resolve(false);
      if (playback.queue.length === 0) {
        setPendingRestore(undefined);
        return Promise.resolve(false);
      }
      // A second press while the first resume is running waits for it.
      resuming ??= resumeRestoredQueue().finally(() => {
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
