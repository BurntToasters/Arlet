import { invoke } from "@tauri-apps/api/core";

/** True inside the Tauri webview; browser previews have no native window. */
function inTauri(): boolean {
  return (
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
    undefined
  );
}

/** Switches the main window between full and compact size. No-op in browsers. */
export async function setMiniPlayer(enabled: boolean): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>("set_mini_player", { enabled });
}

/** Pins or unpins the compact window above other windows. No-op in browsers. */
export async function setMiniPlayerOnTop(onTop: boolean): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>("set_mini_player_on_top", { onTop });
}
