/** Transport and volume keys. Routing to the controller happens in App.tsx. */
export type ShortcutAction =
  | { type: "togglePlayback" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "seekBy"; seconds: number }
  | { type: "adjustVolume"; delta: number }
  | { type: "toggleMute" }
  | { type: "closeNowPlaying" };

const VOLUME_STEP = 0.05;
const SEEK_STEP_SECONDS = 10;

const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='slider']",
].join(", ");
const DIALOG_SELECTOR = "[role='dialog'], dialog[open]";
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

/**
 * Maps a keydown to a transport action. Returns undefined when the key belongs
 * to the focused control, an open dialog, or Alt-based history navigation.
 */
export function shortcutFor(event: KeyboardEvent): ShortcutAction | undefined {
  if (event.altKey) return undefined;
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
