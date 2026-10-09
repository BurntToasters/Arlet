import type { PlaybackState } from "../domain/music.ts";

/**
 * MusicKit reasons that belong to one song. Account-wide failures
 * (subscription, sign-in, DRM licence, device limit, network) are left out:
 * every song would fail the same way, so skipping would only race the queue.
 */
const SKIPPABLE_REASONS = new Set([
  "CONTENT_UNAVAILABLE",
  "CONTENT_RESTRICTED",
  "CONTENT_UNSUPPORTED",
  "NOT_FOUND",
]);

/** Consecutive failures skipped before playback stops on the error. */
export const MAX_CONSECUTIVE_SKIPS = 3;

export interface AutoSkipDependencies {
  readPlayback(): Pick<
    PlaybackState,
    "current" | "queue" | "queueIndex" | "repeatMode"
  >;
  skipToNext(): Promise<void>;
  notify(message: string): void;
  log(message: string): void;
}

export interface AutoSkip {
  /** Returns true when the failing song was skipped. */
  onPlaybackError(error: unknown): boolean;
  /** Real playback resets the consecutive-failure count. */
  onPlaying(): void;
}

function reasonOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const reason = record.errorCode ?? record.reason;
  return typeof reason === "string" ? reason : undefined;
}

/** Skips a song that fails when it starts, like Apple Music does. */
export function createAutoSkip(dependencies: AutoSkipDependencies): AutoSkip {
  let consecutive = 0;
  return {
    onPlaybackError(error: unknown): boolean {
      const reason = reasonOf(error);
      if (!reason || !SKIPPABLE_REASONS.has(reason)) return false;
      const { current, queue, queueIndex, repeatMode } =
        dependencies.readPlayback();
      const hasNext =
        queueIndex < queue.length - 1 ||
        (repeatMode === "all" && queue.length > 1);
      if (!hasNext || consecutive >= MAX_CONSECUTIVE_SKIPS) return false;
      consecutive += 1;
      const title = current?.title ?? "A song";
      dependencies.log(`Skipping unplayable song (${reason}).`);
      dependencies.notify(`Skipped “${title}” because it can't be played.`);
      void dependencies.skipToNext().catch((skipError: unknown) => {
        dependencies.log(
          `Skip after playback error failed: ${
            skipError instanceof Error ? skipError.message : String(skipError)
          }`,
        );
      });
      return true;
    },
    onPlaying(): void {
      consecutive = 0;
    },
  };
}
