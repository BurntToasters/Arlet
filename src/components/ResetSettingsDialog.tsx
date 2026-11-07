import { RotateCcw } from "lucide-preact";
import { useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { useModalDialog } from "./use-modal-dialog.ts";

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

  useModalDialog(dialogRef, {
    // Cancel gets focus so Enter never resets by accident.
    initialFocus: () => cancelButton.current,
    deferFocus: true,
    onEscape: (event) => {
      event.preventDefault();
      if (!resetting) onCancel();
    },
  });

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

  return (
    <div className="update-modal-scrim" role="presentation">
      <section
        ref={dialogRef}
        className="update-modal"
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
