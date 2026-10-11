import {
  isSameTrack,
  type PlaybackState,
  type SleepTimerState,
  type Track,
} from "../domain/music.ts";

export type SleepTimerOption =
  { mode: "minutes"; minutes: number } | { mode: "endOfTrack" };

type SleepTimerPlayback = Pick<
  PlaybackState,
  "current" | "status" | "positionSeconds" | "durationSeconds"
>;

export interface SleepTimerDependencies {
  pause(): void;
  setState(state: SleepTimerState | undefined): void;
  readPlayback(): SleepTimerPlayback;
  now?: () => number;
}

export interface SleepTimer {
  start(option: SleepTimerOption): void;
  cancel(): void;
  /**
   * Called after every playback change and position tick. An end-of-track
   * timer pauses at the first item change, stop, or restart of the same track
   * after it was armed. A minutes timer also fires here once its deadline has
   * passed, which covers a PC that slept through the setTimeout.
   */
  observe(playback: SleepTimerPlayback): void;
}

const MS_PER_MINUTE = 60_000;
/** A position this close to the end counts as having finished the track. */
const END_WINDOW_SECONDS = 3;
/** A position this close to the start counts as the track restarting. */
const START_WINDOW_SECONDS = 2;

/** In-memory sleep timer. Nothing is persisted, so a restart clears it. */
export function createSleepTimer(
  dependencies: SleepTimerDependencies,
): SleepTimer {
  const now = dependencies.now ?? Date.now;
  // Bumped on every reset so a callback that outlived its timer does nothing.
  let generation = 0;
  let handle: ReturnType<typeof setTimeout> | undefined;
  // Wall-clock deadline for minutes mode. The setTimeout pauses while the PC
  // sleeps, so observe() compares against this to fire on time after resume.
  let minutesEndsAt: number | undefined;
  let armed:
    | {
        track: Track | undefined;
        status: PlaybackState["status"];
        positionSeconds: number;
        durationSeconds: number;
      }
    | undefined;

  const clear = (): void => {
    generation += 1;
    if (handle !== undefined) clearTimeout(handle);
    handle = undefined;
    minutesEndsAt = undefined;
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
        minutesEndsAt = now() + delay;
        dependencies.setState({ mode: "minutes", endsAt: minutesEndsAt });
        return;
      }
      // Arm on the playing item. If nothing is loaded, the first item that
      // starts becomes the one to finish.
      const playback = dependencies.readPlayback();
      armed = {
        track: playback.current,
        status: playback.status,
        positionSeconds: playback.positionSeconds,
        durationSeconds: playback.durationSeconds,
      };
      dependencies.setState({ mode: "endOfTrack" });
    },

    cancel(): void {
      clear();
      dependencies.setState(undefined);
    },

    observe(playback): void {
      if (minutesEndsAt !== undefined && now() >= minutesEndsAt) {
        fire();
        return;
      }
      if (!armed) return;
      const { current, status, positionSeconds, durationSeconds } = playback;
      armed.track ??= current;
      const trackChanged =
        armed.track !== undefined && !isSameTrack(armed.track, current);
      const stopped = status === "stopped" && armed.status !== "stopped";
      // Repeat One, or the same song queued twice, keeps the track the same, so
      // the end shows up as the position wrapping from the end to the start.
      const restarted =
        !trackChanged &&
        armed.durationSeconds > 0 &&
        armed.positionSeconds >= armed.durationSeconds - END_WINDOW_SECONDS &&
        positionSeconds < START_WINDOW_SECONDS;
      armed.status = status;
      armed.positionSeconds = positionSeconds;
      armed.durationSeconds = durationSeconds;
      if (trackChanged || stopped || restarted) fire();
    },
  };
}
