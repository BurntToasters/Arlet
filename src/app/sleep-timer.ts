import {
  isSameTrack,
  type PlaybackState,
  type SleepTimerState,
  type Track,
} from "../domain/music.ts";

export type SleepTimerOption =
  { mode: "minutes"; minutes: number } | { mode: "endOfTrack" };

export interface SleepTimerDependencies {
  pause(): void;
  setState(state: SleepTimerState | undefined): void;
  readPlayback(): Pick<PlaybackState, "current" | "status">;
  now?: () => number;
}

export interface SleepTimer {
  start(option: SleepTimerOption): void;
  cancel(): void;
  /**
   * Called after every playback change. An end-of-track timer pauses at the
   * first item change or stop after it was armed.
   */
  observe(playback: Pick<PlaybackState, "current" | "status">): void;
}

const MS_PER_MINUTE = 60_000;

/** In-memory sleep timer. Nothing is persisted, so a restart clears it. */
export function createSleepTimer(
  dependencies: SleepTimerDependencies,
): SleepTimer {
  const now = dependencies.now ?? Date.now;
  // Bumped on every reset so a callback that outlived its timer does nothing.
  let generation = 0;
  let handle: ReturnType<typeof setTimeout> | undefined;
  let armed:
    { track: Track | undefined; status: PlaybackState["status"] } | undefined;

  const clear = (): void => {
    generation += 1;
    if (handle !== undefined) clearTimeout(handle);
    handle = undefined;
    armed = undefined;
  };

  const fire = (): void => {
    clear();
    dependencies.setState(undefined);
    try {
      dependencies.pause();
    } catch {
      // The sleep timer must not throw into the playback event that ended it.
    }
  };

  return {
    start(option: SleepTimerOption): void {
      clear();
      if (option.mode === "minutes") {
        if (!Number.isFinite(option.minutes) || option.minutes <= 0) {
          throw new Error("Sleep timer needs a positive number of minutes.");
        }
        const token = generation;
        const delay = option.minutes * MS_PER_MINUTE;
        handle = setTimeout(() => {
          if (token === generation) fire();
        }, delay);
        dependencies.setState({ mode: "minutes", endsAt: now() + delay });
        return;
      }
      // Arm on the playing item. If nothing is loaded, the first item that
      // starts becomes the one to finish.
      const playback = dependencies.readPlayback();
      armed = { track: playback.current, status: playback.status };
      dependencies.setState({ mode: "endOfTrack" });
    },

    cancel(): void {
      clear();
      dependencies.setState(undefined);
    },

    observe(playback): void {
      if (!armed) return;
      const { current, status } = playback;
      armed.track ??= current;
      const trackChanged =
        armed.track !== undefined && !isSameTrack(armed.track, current);
      const stopped = status === "stopped" && armed.status !== "stopped";
      armed.status = status;
      if (trackChanged || stopped) fire();
    },
  };
}
