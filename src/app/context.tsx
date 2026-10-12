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

export function useAppState(): Readonly<RuntimeAppState> {
  const [, setVersion] = useState(0);
  useEffect(() => subscribe(() => setVersion((version) => version + 1)), []);
  return getState();
}

/**
 * Subscribes to named top-level slices only. A component re-renders when one
 * of its slices changes, not on every store update. The result is a `Pick`,
 * so reading a slice that was not requested fails to type-check; prefer this
 * over `useAppState` in components that stay mounted.
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
      if (!seen || keysRef.current.some((key) => seen[key] !== state[key])) {
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
