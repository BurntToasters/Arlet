import { X } from "lucide-preact";
import type { JSX } from "preact";
import { useRef } from "preact/hooks";
import {
  SHORTCUT_HELP,
  type ShortcutGroup,
  type ShortcutHelp,
} from "../app/shortcuts.ts";
import { useModalDialog } from "./use-modal-dialog.ts";

const GROUPS: readonly ShortcutGroup[] = ["Playback", "Navigation", "Window"];

/** Entries without a group are listed under Window so none go missing. */
function groupOf(entry: ShortcutHelp): ShortcutGroup {
  return entry.group ?? "Window";
}

export interface ShortcutOverlayProps {
  onClose: () => void;
}

/** Lists every keyboard shortcut; opened with Ctrl+/ or `?` from App.tsx. */
export function ShortcutOverlay({
  onClose,
}: ShortcutOverlayProps): JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // Capture phase, so Escape closes this dialog before App.tsx's window
  // listener can also close Now Playing underneath it.
  useModalDialog(dialogRef, {
    capture: true,
    escapeAnywhere: true,
    initialFocus: () => closeButton.current,
    onEscape: (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    },
  });

  return (
    <div
      className="playlist-dialog-backdrop shortcut-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="playlist-dialog shortcut-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-overlay-title"
        // A click on dialog text focuses the section, not the page behind it.
        tabIndex={-1}
      >
        <header className="playlist-dialog-header">
          <div>
            <span className="eyebrow">Arlet</span>
            <h2 id="shortcut-overlay-title">Keyboard shortcuts</h2>
          </div>
          <button
            ref={closeButton}
            className="icon-button"
            type="button"
            aria-label="Close"
            onClick={() => onClose()}
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>
        <p className="shortcut-overlay-note">
          Playback keys are off while you type in a field or dialog.
        </p>
        {GROUPS.map((group) => {
          const entries = SHORTCUT_HELP.filter(
            (entry) => groupOf(entry) === group,
          );
          if (entries.length === 0) return null;
          return (
            <div className="shortcut-overlay-group" key={group}>
              <h3>{group}</h3>
              <dl className="shortcut-overlay-list">
                {entries.map((entry) => (
                  <div key={entry.keys} className="shortcut-overlay-row">
                    <dt>
                      <kbd>{entry.keys}</kbd>
                    </dt>
                    <dd>{entry.action}</dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
      </section>
    </div>
  );
}
