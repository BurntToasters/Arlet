import type { Station, Track } from "../domain/music.ts";
import { getState, subscribe } from "../state.ts";
import { parkQueue } from "./playback-session.ts";
import { safeErrorMessage } from "./controller-support.ts";

/**
 * How long playback may stay paused before the stream goes back to Apple.
 * MusicKit keeps renewing its DRM lease while paused, and Apple pauses the
 * user's other devices ("More than one device is trying to play music").
 */
export const STREAM_RELEASE_DELAY_MS = 60_000;

export interface StreamReleaseDependencies {
  getMusic: () => MusicKit.MusicKitInstance | undefined;
  fullQueue: () => { tracks: readonly Track[]; index: number };
  currentStation: () => Station | undefined;
  log: (message: string) => void;
  now?: () => number;
}

export interface StreamRelease {
  /** Hands the stream back now, whatever the playback state. */
  releaseNow(reason: string): void;
  /** Resolves once the last handoff's `stop()` finished. */
  settled(): Promise<void>;
  /** Drops a pending timer. */
  cancel(): void;
  /** Cancels and stops observing state. */
  dispose(): void;
}

/**
 * Parks a long-paused queue and stops MusicKit, the only call that releases
 * its lease. The parked queue behaves like a restored session: Play starts
 * it again at the saved position.
 */
export function createStreamRelease(
  dependencies: StreamReleaseDependencies,
): StreamRelease {
  const now = dependencies.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped: Promise<void> = Promise.resolve();

  const cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const release = (message: string): void => {
    cancel();
    const instance = dependencies.getMusic();
    const { playback } = getState();
    if (!instance || playback.pendingRestore || !playback.current) return;
    const full = dependencies.fullQueue();
    if (full.tracks.length === 0) return;
    // Parked before stop() so its echoes find the parked queue in place.
    parkQueue({
      tracks: [...full.tracks],
      index: full.index,
      positionSeconds: playback.positionSeconds,
      durationSeconds: playback.durationSeconds,
      savedAt: now(),
      released: true,
      station: dependencies.currentStation(),
    });
    try {
      stopped = Promise.resolve(instance.stop()).then(
        () => undefined,
        (error: unknown) => {
          dependencies.log(
            `Stopping MusicKit after the handoff failed: ${safeErrorMessage(error)}`,
          );
        },
      );
    } catch (error) {
      dependencies.log(
        `Stopping MusicKit after the handoff failed: ${safeErrorMessage(error)}`,
      );
    }
    dependencies.log(message);
  };

  const evaluate = (): void => {
    const { playback, auth } = getState();
    const eligible =
      (playback.status === "paused" || playback.status === "error") &&
      playback.current !== undefined &&
      playback.pendingRestore === undefined &&
      auth.status === "authorized";
    if (!eligible) {
      cancel();
      return;
    }
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      release("Handed the Apple Music stream back after 1 minute paused.");
    }, STREAM_RELEASE_DELAY_MS);
  };

  const unsubscribe = subscribe(evaluate);

  return {
    releaseNow: (reason) =>
      release(`Handed the Apple Music stream back (${reason}).`),
    settled: () => stopped,
    cancel,
    dispose(): void {
      cancel();
      unsubscribe();
    },
  };
}
