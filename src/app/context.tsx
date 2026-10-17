import { createContext } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import {
  getState,
  subscribe,
  subscribePlaybackPosition,
  type RuntimeAppState,
} from "../state.ts";
import type { AppController } from "./controller.ts";
import type { HashRouter } from "../routing/router.ts";

export const AppControllerContext = createContext<AppController | null>(null);
export const AppRouterContext = createContext<HashRouter | null>(null);

export function AppProvider({
  controller,
  router,
  children,
}: {
  controller: AppController;
  router: HashRouter;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <AppControllerContext.Provider value={controller}>
      <AppRouterContext.Provider value={router}>
        {children}
      </AppRouterContext.Provider>
    </AppControllerContext.Provider>
  );
}

export function useAppController(): AppController {
  const controller = useContext(AppControllerContext);
  if (!controller) {
    throw new Error("useAppController must be used inside AppProvider");
  }
  return controller;
}

/** Shallow equality: same own keys, each value compared with `Object.is`. */
export function shallowEqual<T>(previous: T, next: T): boolean {
  if (Object.is(previous, next)) return true;
  if (
    typeof previous !== "object" ||
    typeof next !== "object" ||
    previous === null ||
    next === null
  ) {
    return false;
  }
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(before);
  if (keys.length !== Object.keys(after).length) return false;
  return keys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(after, key) &&
      Object.is(before[key], after[key]),
  );
}

/**
 * Position ticks replace `playback` with a new object, so the playback slice
 * is compared without `positionSeconds` and `durationSeconds`. Readers of
 * those fields use `usePlaybackPosition`; see `setPlaybackPosition`.
 */
function playbackSliceEqual(
  previous: RuntimeAppState["playback"],
  next: RuntimeAppState["playback"],
): boolean {
  return shallowEqual(
    { ...previous, positionSeconds: 0, durationSeconds: 0 },
    { ...next, positionSeconds: 0, durationSeconds: 0 },
  );
}

function sliceChanged<K extends keyof RuntimeAppState>(
  key: K,
  previous: RuntimeAppState[K],
  next: RuntimeAppState[K],
): boolean {
  if (key === "playback") {
    return !playbackSliceEqual(
      previous as RuntimeAppState["playback"],
      next as RuntimeAppState["playback"],
    );
  }
  return !Object.is(previous, next);
}

/**
 * Subscribes to named top-level slices only. A component re-renders when one
 * of its slices changes, not on every store update, and a playback position
 * tick is not a `playback` change. The result is a `Pick`, so reading a slice
 * that was not requested fails to type-check; prefer this over subscribing to
 * the whole store.
 */
export function useAppSlices<K extends keyof RuntimeAppState>(
  ...keys: K[]
): Pick<RuntimeAppState, K> {
  const [, setVersion] = useState(0);
  // Keys are fixed per call site; a ref keeps the subscription stable.
  const keysRef = useRef(keys);
  const seenRef = useRef<Pick<RuntimeAppState, K> | undefined>(undefined);
  useEffect(() => {
    const check = (): void => {
      const seen = seenRef.current;
      const state = getState();
      if (
        !seen ||
        keysRef.current.some((key) => sliceChanged(key, seen[key], state[key]))
      ) {
        setVersion((version) => version + 1);
      }
    };
    const unsubscribe = subscribe(check);
    // An update between render and subscribing would otherwise be missed.
    check();
    return unsubscribe;
  }, []);
  const state = getState();
  const slices = {} as Pick<RuntimeAppState, K>;
  for (const key of keys) slices[key] = state[key];
  seenRef.current = slices;
  return slices;
}

/**
 * Subscribes to one derived value and re-renders only when `equal` says it
 * changed. Use it for a single field, e.g. `useAppSelector((state) => state.ui.queueOpen)`.
 */
export function useAppSelector<T>(
  selector: (state: Readonly<RuntimeAppState>) => T,
  equal: (previous: T, next: T) => boolean = Object.is,
): T {
  const [, setVersion] = useState(0);
  // The selector and equality may close over props; refs keep the single
  // subscription pointing at the latest ones.
  const selectorRef = useRef(selector);
  const equalRef = useRef(equal);
  selectorRef.current = selector;
  equalRef.current = equal;
  const selected = selector(getState());
  const seenRef = useRef(selected);
  seenRef.current = selected;
  useEffect(() => {
    const check = (): void => {
      const next = selectorRef.current(getState());
      if (!equalRef.current(seenRef.current, next)) {
        setVersion((version) => version + 1);
      }
    };
    const unsubscribe = subscribe(check);
    // An update between render and subscribing would otherwise be missed.
    check();
    return unsubscribe;
  }, []);
  return selected;
}

export interface PlaybackPosition {
  positionSeconds: number;
  durationSeconds: number;
}

/** Subscribes only to playback ticks; see `setPlaybackPosition`. */
export function usePlaybackPosition(): PlaybackPosition {
  const [, setVersion] = useState(0);
  useEffect(
    () => subscribePlaybackPosition(() => setVersion((version) => version + 1)),
    [],
  );
  const { positionSeconds, durationSeconds } = getState().playback;
  return { positionSeconds, durationSeconds };
}

export function useOptionalAppController(): AppController | null {
  return useContext(AppControllerContext);
}

export function useAppRouter(): HashRouter {
  const router = useContext(AppRouterContext);
  if (!router) throw new Error("useAppRouter must be used inside AppProvider");
  return router;
}
