import { createContext } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import type { ComponentChildren, Context, JSX } from "preact";
import { getState, subscribe, type RuntimeAppState } from "../state.ts";
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

export function useOptionalAppController(): AppController | null {
  return useContext(AppControllerContext);
}

export const AppContext: Context<AppController | null> = AppControllerContext;

export function useAppRouter(): HashRouter {
  const router = useContext(AppRouterContext);
  if (!router) throw new Error("useAppRouter must be used inside AppProvider");
  return router;
}
