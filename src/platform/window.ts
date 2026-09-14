import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";

export type InvokeFunction = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

function currentWindow(): Window | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export async function minimizeWindow(window = currentWindow()): Promise<void> {
  await window?.minimize();
}

export async function toggleMaximize(
  window = currentWindow(),
): Promise<boolean | undefined> {
  if (!window) return undefined;
  await window.toggleMaximize();
  return window.isMaximized();
}

export async function closeWindow(window = currentWindow()): Promise<void> {
  await window?.close();
}

export async function startWindowDrag(window = currentWindow()): Promise<void> {
  await window?.startDragging();
}

export async function isWindowMaximized(
  window = currentWindow(),
): Promise<boolean | undefined> {
  return window ? window.isMaximized() : undefined;
}

export async function listenWindowResize(
  listener: () => void,
  window = currentWindow(),
): Promise<() => void> {
  if (!window) return () => undefined;
  return window.onResized(() => listener());
}

export async function listenWindowEvent<T>(
  event: string,
  listener: (payload: T) => void,
  window = currentWindow(),
): Promise<() => void> {
  if (!window) return () => undefined;
  return window.listen<T>(event, ({ payload }) => listener(payload));
}

export interface SnapBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function setSnapOverlayBounds(
  bounds: SnapBounds,
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  try {
    await invokeFn("set_snap_overlay_bounds", { ...bounds });
  } catch {
    // Older native builds do not register the snap adapter yet.
  }
}

export interface SnapLayoutBinding {
  dispose(): void;
}

function physicalRect(element: HTMLElement, scale: number): SnapBounds {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.left * scale),
    y: Math.round(rect.top * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  };
}

/** Bind the maximize button to the native Snap Layout hit-test overlay. */
export function bindSnapLayout(
  button: HTMLElement,
  options: {
    invokeFn?: InvokeFunction;
    window?: Window | null;
    resizeObserver?: typeof ResizeObserver;
  } = {},
): SnapLayoutBinding {
  const windowHandle = options.window ?? currentWindow();
  const invokeFn = options.invokeFn ?? (invoke as InvokeFunction);
  let disposed = false;
  let scale = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  let observer: ResizeObserver | undefined;
  let unlistenResize: (() => void) | undefined;
  let unlistenHover: (() => void) | undefined;

  const report = async (): Promise<void> => {
    if (disposed) return;
    if (windowHandle) {
      try {
        scale = (await windowHandle.scaleFactor()) || scale;
      } catch {
        // Browser preview and older Tauri hosts use devicePixelRatio.
      }
    }
    await setSnapOverlayBounds(physicalRect(button, scale), invokeFn);
  };

  if (options.resizeObserver ?? globalThis.ResizeObserver) {
    const ResizeObserverCtor =
      options.resizeObserver ?? globalThis.ResizeObserver;
    observer = new ResizeObserverCtor(() => void report());
    observer.observe(button);
  }
  void report();

  if (windowHandle) {
    void windowHandle
      .onResized(() => void report())
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenResize = unlisten;
      })
      .catch(() => undefined);
    void windowHandle
      .listen<boolean>("snap-max-hover", ({ payload }) => {
        if (payload) button.setAttribute("data-snap-hover", "true");
        else button.removeAttribute("data-snap-hover");
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenHover = unlisten;
      })
      .catch(() => undefined);
  }

  return {
    dispose() {
      disposed = true;
      observer?.disconnect();
      unlistenResize?.();
      unlistenHover?.();
      button.removeAttribute("data-snap-hover");
      void setSnapOverlayBounds({ x: 0, y: 0, width: 0, height: 0 }, invokeFn);
    },
  };
}
