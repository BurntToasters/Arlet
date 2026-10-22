import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { setUiState } from "../state.ts";

function currentWindow(): Window | null {
  try {
    return getCurrentWindow();
  } catch {
    // Browser preview has no Tauri window; every helper then reads as windowed.
    return null;
  }
}

/** Fullscreen state of the main window. Never rejects; false when unknown. */
export async function isWindowFullscreen(
  window = currentWindow(),
): Promise<boolean> {
  if (!window) return false;
  try {
    return await window.isFullscreen();
  } catch {
    return false;
  }
}

/** Toggles fullscreen for the window and resolves to the new state. */
export async function toggleWindowFullscreen(
  window = currentWindow(),
): Promise<boolean> {
  if (!window) return false;
  const next = !(await window.isFullscreen());
  await window.setFullscreen(next);
  return next;
}

/**
 * Esc leaves fullscreen before Now Playing closes. A refused fullscreen change
 * must not keep the overlay open, so the close always happens.
 */
export async function closeNowPlayingLeavingFullscreen(
  window = currentWindow(),
): Promise<void> {
  try {
    if (window && (await window.isFullscreen())) {
      await window.setFullscreen(false);
    }
  } catch {
    // The window kept its state; closing the overlay still proceeds.
  }
  setUiState({ nowPlayingOpen: false });
}
