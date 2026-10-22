import { getCurrentWindow } from "@tauri-apps/api/window";
import { setMiniPlayer } from "../platform/mini-player.ts";
import { getState, setUiState } from "../state.ts";

// Transitions run one at a time, so a quick double press cannot interleave
// two native resizes and leave the UI and the window disagreeing.
let queue: Promise<void> = Promise.resolve();
// Full screen when the mini player opened; leaving it returns there.
let resumeFullscreen = false;

function serialize(task: () => Promise<void>): Promise<void> {
  const next = queue.then(task);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * A full-screen window ignores the compact size, so leave full screen first.
 * Returns whether the window was full screen.
 */
async function leaveFullscreen(): Promise<boolean> {
  try {
    const window = getCurrentWindow();
    if (!(await window.isFullscreen())) return false;
    await window.setFullscreen(false);
    return true;
  } catch {
    // Browser preview has no window; the native call reports real failures.
    return false;
  }
}

async function returnToFullscreen(): Promise<void> {
  try {
    await getCurrentWindow().setFullscreen(true);
  } catch {
    // The window is back at its normal size, which is still usable.
  }
}

async function enter(): Promise<void> {
  if (getState().ui.miniPlayer) return;
  const wasFullscreen = await leaveFullscreen();
  // Native first: a refused resize keeps the normal shell on screen.
  try {
    await setMiniPlayer(true);
  } catch (error) {
    // The normal shell stays, so put the window back as it was.
    if (wasFullscreen) await returnToFullscreen();
    throw error;
  }
  resumeFullscreen = wasFullscreen;
  setUiState({ miniPlayer: true, nowPlayingOpen: false });
}

async function exit(): Promise<void> {
  if (!getState().ui.miniPlayer) return;
  await setMiniPlayer(false);
  setUiState({ miniPlayer: false });
  if (resumeFullscreen) {
    resumeFullscreen = false;
    await returnToFullscreen();
  }
}

/** Switches the window to the compact player. Rejects if the window refuses. */
export function enterMiniPlayer(): Promise<void> {
  return serialize(enter);
}

/** Returns the window to the normal shell. Rejects if the window refuses. */
export function exitMiniPlayer(): Promise<void> {
  return serialize(exit);
}

/** Ctrl+Shift+M and the PlayerBar button. */
export function toggleMiniPlayer(): Promise<void> {
  return serialize(() => (getState().ui.miniPlayer ? exit() : enter()));
}
