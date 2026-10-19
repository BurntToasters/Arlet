import { getState, subscribe } from "../state.ts";

/**
 * Playback that runs this long with no user activity is paused. Written as a
 * literal so E2E can map the setTimeout delay to a short one by its value.
 */
export const IDLE_PLAYBACK_LIMIT_MS = 14_400_000;

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel"] as const;

export interface IdleGuard {
  /** Re-arms the timer. Called for user input and for every playback command. */
  noteActivity(): void;
  dispose(): void;
}

/**
 * Calls `onIdle` once playback has been `playing` for IDLE_PLAYBACK_LIMIT_MS
 * with no activity. One timer only, so a pause cannot fire twice. The timer
 * is cleared whenever playback is not `playing`.
 */
export function createIdleGuard(onIdle: () => void): IdleGuard {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const arm = (): void => {
    clear();
    timer = setTimeout(() => {
      timer = undefined;
      onIdle();
    }, IDLE_PLAYBACK_LIMIT_MS);
  };
  const noteActivity = (): void => {
    if (getState().playback.status === "playing") arm();
  };
  const sync = (): void => {
    if (getState().playback.status !== "playing") clear();
    else if (timer === undefined) arm();
  };

  const unsubscribe = subscribe(sync);
  const target = typeof window === "undefined" ? undefined : window;
  const onInput = (): void => noteActivity();
  for (const event of ACTIVITY_EVENTS) {
    target?.addEventListener(event, onInput, { passive: true });
  }
  sync();

  return {
    noteActivity,
    dispose(): void {
      unsubscribe();
      clear();
      for (const event of ACTIVITY_EVENTS) {
        target?.removeEventListener(event, onInput);
      }
    },
  };
}
