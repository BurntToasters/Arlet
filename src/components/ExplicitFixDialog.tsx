import { ShieldAlert } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { useModalDialog } from "./use-modal-dialog.ts";

/** Seconds the "I Agree" button waits after the dialog opens. */
export const EXPLICIT_FIX_AGREE_DELAY_SECONDS = 15;

export interface ExplicitFixDialogProps {
  onCancel: () => void;
  onAgree: () => Promise<void>;
}

/** Asks before the explicit-content fix turns on; the fix is on only after "I Agree". */
export function ExplicitFixDialog({
  onCancel,
  onAgree,
}: ExplicitFixDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [secondsLeft, setSecondsLeft] = useState(
    EXPLICIT_FIX_AGREE_DELAY_SECONDS,
  );
  const [agreeing, setAgreeing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (secondsLeft <= 0) return undefined;
    const timer = window.setTimeout(
      () => setSecondsLeft((seconds) => seconds - 1),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [secondsLeft]);

  useModalDialog(dialogRef, {
    // Cancel gets focus so Enter never agrees by accident.
    initialFocus: () => cancelButton.current,
    deferFocus: true,
    onEscape: (event) => {
      event.preventDefault();
      if (!agreeing) onCancel();
    },
  });

  const agree = (): void => {
    setAgreeing(true);
    setError(null);
    void onAgree().catch((reason: unknown) => {
      setAgreeing(false);
      setError(
        `Could not turn on the fix. ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    });
  };

  const waiting = secondsLeft > 0;

  return (
    <div className="update-modal-scrim" role="presentation">
      <section
        ref={dialogRef}
        className="update-modal"
        role="alertdialog"
        aria-modal="true"
        aria-busy={agreeing}
        aria-labelledby="explicit-fix-title"
        aria-describedby="explicit-fix-description"
      >
        <div className="update-modal-icon" aria-hidden="true">
          <ShieldAlert size={20} strokeWidth={1.8} />
        </div>
        <p className="eyebrow">Settings</p>
        <h2 id="explicit-fix-title">Fix explicit songs not playing</h2>
        <div id="explicit-fix-description">
          <p>
            Apple sometimes reports an Apple Account as restricted from explicit
            content even when explicit songs play in the Apple Music app and on
            music.apple.com. When that happens, Arlet skips every explicit song.
          </p>
          <p>
            This fix tells Arlet to ignore that report for this Apple Account on
            this PC. Turn it on only if explicit content is allowed on your
            account and Arlet is still skipping explicit songs. Do not use it to
            get around restrictions someone else set.
          </p>
          <p>
            Arlet sets this back to Auto if a different Apple Account signs in,
            or if you turn this off.
          </p>
        </div>
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
            disabled={agreeing}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={waiting || agreeing}
            onClick={agree}
          >
            {waiting ? `I Agree (${secondsLeft})` : "I Agree"}
          </button>
        </div>
      </section>
    </div>
  );
}
