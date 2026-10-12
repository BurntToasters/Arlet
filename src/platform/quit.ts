import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `BEFORE_QUIT_EVENT` in src-tauri/src/tray.rs. */
const BEFORE_QUIT_EVENT = "arlet-before-quit";

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
