import { RotateCcw } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ResetSettingsDialogProps {
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

/** Confirms a settings reset; Arlet restarts as soon as it succeeds. */
export function ResetSettingsDialog({
  onCancel,
  onConfirm,
}: ResetSettingsDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    // Cancel gets focus so Enter never resets by accident.
    const focusTimer = window.setTimeout(
      () => cancelButton.current?.focus(),
      0,
    );
    return () => {
      window.clearTimeout(focusTimer);
      previousFocus?.focus?.();
    };
  }, []);

  const confirm = (): void => {
    setResetting(true);
    setError(null);
    void onConfirm().catch((reason: unknown) => {
      setResetting(false);
      setError(
        `Could not reset settings. ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    });
  };

  const onDialogKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!resetting) onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (
      (event.shiftKey && (active === first || !dialog.contains(active))) ||
      (!event.shiftKey && (active === last || !dialog.contains(active)))
    ) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  };

  return (
    <div className="update-modal-scrim" role="presentation">
      <section
        ref={dialogRef}
        className="update-modal"
        onKeyDown={onDialogKeyDown}
        role="alertdialog"
        aria-modal="true"
        aria-busy={resetting}
        aria-labelledby="reset-settings-title"
        aria-describedby="reset-settings-description"
      >
        <div className="update-modal-icon" aria-hidden="true">
          <RotateCcw size={20} strokeWidth={1.8} />
        </div>
        <p className="eyebrow">Settings</p>
        <h2 id="reset-settings-title">Reset settings and restart?</h2>
        <p id="reset-settings-description">
          Theme, window material, volume, and update preferences go back to
          their defaults, then Arlet restarts. You stay signed in, and your
          pinned playlists and library are kept.
        </p>
        {error ? (
          <p className="update-modal-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="update-modal-actions">
          <button
            ref={cancelButton}
            className="secondary-button"
            type="button"
            disabled={resetting}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={resetting}
            onClick={confirm}
          >
            <RotateCcw
              aria-hidden="true"
              size={15}
              strokeWidth={1.9}
              className={resetting ? "spin" : undefined}
            />
            {resetting ? "Restarting…" : "Reset and restart"}
          </button>
        </div>
      </section>
    </div>
  );
}
