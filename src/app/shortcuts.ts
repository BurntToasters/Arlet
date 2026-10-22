/** Transport and volume keys. Routing to the controller happens in App.tsx. */
export type ShortcutAction =
  | { type: "togglePlayback" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "seekBy"; seconds: number }
  | { type: "adjustVolume"; delta: number }
  | { type: "toggleMute" }
  | { type: "closeNowPlaying" }
  | { type: "toggleFullscreen" };

/** Headings the shortcut overlay groups entries under, in display order. */
export type ShortcutGroup = "Playback" | "Navigation" | "Window";

export interface ShortcutHelp {
  keys: string;
  action: string;
  group?: ShortcutGroup;
}

/**
 * Listed in Settings and the shortcut overlay; keep in step with `shortcutFor`
 * and the App.tsx keys.
 */
export const SHORTCUT_HELP: readonly ShortcutHelp[] = [
  { keys: "Space", action: "Play or pause", group: "Playback" },
  { keys: "Ctrl+→", action: "Next song", group: "Playback" },
  { keys: "Ctrl+←", action: "Previous song", group: "Playback" },
  { keys: "Ctrl+↑", action: "Volume up", group: "Playback" },
  { keys: "Ctrl+↓", action: "Volume down", group: "Playback" },
  { keys: "Shift+→", action: "Skip forward 10 seconds", group: "Playback" },
  { keys: "Shift+←", action: "Skip back 10 seconds", group: "Playback" },
  { keys: "M", action: "Mute or unmute", group: "Playback" },
  { keys: "Esc", action: "Close Now Playing", group: "Navigation" },
  { keys: "F11", action: "Toggle full screen", group: "Window" },
  { keys: "Ctrl+K", action: "Search Apple Music", group: "Navigation" },
  { keys: "Ctrl+R", action: "Refresh current data", group: "Window" },
  { keys: "Alt+←", action: "Back", group: "Navigation" },
  { keys: "Alt+→", action: "Forward", group: "Navigation" },
  { keys: "Ctrl+/", action: "Show keyboard shortcuts", group: "Window" },
  { keys: "Ctrl+Shift+M", action: "Mini player", group: "Window" },
  {
    keys: "Ctrl+Click / Shift+Click",
    action: "Select songs",
    group: "Navigation",
  },
  { keys: "Ctrl+A", action: "Select all songs in list", group: "Navigation" },
  { keys: "Esc", action: "Clear selection", group: "Navigation" },
];

const VOLUME_STEP = 0.05;
const SEEK_STEP_SECONDS = 10;

const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='slider']",
].join(", ");
// Now Playing is a full-window view where transport keys should still work.
const DIALOG_SELECTOR = "[role='dialog']:not(.now-playing), dialog[open]";
const NATIVE_ACTIVATION_SELECTOR =
  "button, a[href], [role='button'], [role='link']";

function elementOf(target: EventTarget | null): Element | undefined {
  return target instanceof Element ? target : undefined;
}

/** True when typing or adjusting a control owns the key press. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return elementOf(target)?.closest(EDITABLE_SELECTOR) != null;
}

function isInsideDialog(target: EventTarget | null): boolean {
  return elementOf(target)?.closest(DIALOG_SELECTOR) != null;
}

/** True when any dialog other than Now Playing is open in the document. */
export function hasOpenDialog(): boolean {
  return document.querySelector(DIALOG_SELECTOR) != null;
}

/** Ctrl+/ or `?` (Shift+/ on US layouts) opens the shortcut overlay. */
export function isShortcutOverlayKey(event: KeyboardEvent): boolean {
  if (event.altKey || event.metaKey) return false;
  if (event.ctrlKey) return event.key === "/" && !event.shiftKey;
  return event.key === "?";
}

/**
 * Maps a keydown to a transport action. Returns undefined when the key belongs
 * to the focused control, an open dialog, or Alt-based history navigation.
 */
export function shortcutFor(event: KeyboardEvent): ShortcutAction | undefined {
  if (event.altKey) return undefined;
  // Fullscreen is a window action, so it works while typing or in any dialog.
  if (event.key === "F11" && !event.ctrlKey && !event.metaKey) {
    return event.shiftKey ? undefined : { type: "toggleFullscreen" };
  }
  if (isEditableTarget(event.target) || isInsideDialog(event.target)) {
    return undefined;
  }
  const { key, ctrlKey, metaKey, shiftKey } = event;
  const bare = !ctrlKey && !metaKey && !shiftKey;

  if (key === "Escape" && bare) return { type: "closeNowPlaying" };
  if (key === " " && bare) {
    // Native activation already runs the focused button or link.
    if (elementOf(event.target)?.closest(NATIVE_ACTIVATION_SELECTOR)) {
      return undefined;
    }
    return { type: "togglePlayback" };
  }
  if ((key === "m" || key === "M") && !ctrlKey && !metaKey) {
    if (!shiftKey || key === "M") return { type: "toggleMute" };
    return undefined;
  }
  if (ctrlKey && !metaKey && !shiftKey) {
    switch (key) {
      case "ArrowRight":
        return { type: "next" };
      case "ArrowLeft":
        return { type: "previous" };
      case "ArrowUp":
        return { type: "adjustVolume", delta: VOLUME_STEP };
      case "ArrowDown":
        return { type: "adjustVolume", delta: -VOLUME_STEP };
    }
  }
  if (shiftKey && !ctrlKey && !metaKey) {
    if (key === "ArrowRight") {
      return { type: "seekBy", seconds: SEEK_STEP_SECONDS };
    }
    if (key === "ArrowLeft") {
      return { type: "seekBy", seconds: -SEEK_STEP_SECONDS };
    }
  }
  return undefined;
}
