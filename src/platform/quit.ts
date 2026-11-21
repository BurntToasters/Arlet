import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `BEFORE_QUIT_EVENT` in src-tauri/src/tray.rs. */
const BEFORE_QUIT_EVENT = "arlet-before-quit";

/** True inside the Tauri webview; a browser preview has no Arlet process to end. */
function inTauri(): boolean {
  return (
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
    undefined
  );
}

/** Quits Arlet. The native side has the page save its queue first. */
export async function quitArlet(): Promise<void> {
  if (!inTauri()) {
    window.close();
    return;
  }
  await invoke<void>("quit_app");
}

/** Restarts Arlet. The native side has the page save its queue first. */
export async function restartArlet(): Promise<void> {
  if (!inTauri()) {
    window.location.reload();
    return;
  }
  await invoke<void>("restart_app");
}

/**
 * Runs `save` when Arlet is about to quit, then tells the native side it may
 * exit. The native side waits a short while for this and then exits anyway,
 * so a failed save never blocks quitting.
 */
export function listenBeforeQuit(
  save: () => Promise<void>,
): Promise<UnlistenFn> {
  return listen(BEFORE_QUIT_EVENT, () => {
    void save()
      .catch(() => undefined)
      .finally(() => {
        void invoke("quit_ready").catch(() => undefined);
      });
  });
}
