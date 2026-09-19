import { Download, RefreshCw } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import type { JSX } from "preact";
import { useAppController, useAppState } from "../app/context.tsx";
import { ReleaseNotes } from "./ReleaseNotes.tsx";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The updater downloads in the background, then asks only when the signed
 * installer is ready. Keeping this in the shell means it is available over
 * every route without involving native notification or dialog surfaces.
 */
export function UpdateReadyModal(): JSX.Element | null {
  const state = useAppState();
  const controller = useAppController();
  const dialogRef = useRef<HTMLElement>(null);
  const restartButton = useRef<HTMLButtonElement>(null);
  const installing = state.updates.status === "installing";
  const showReleaseNotes = state.updates.status === "ready";
  const open =
    (state.updates.promptOpen || installing) && Boolean(state.updates.version);

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(
      () => restartButton.current?.focus(),
      0,
    );
    return () => {
      window.clearTimeout(focusTimer);
      previousFocus?.focus?.();
    };
  }, [controller, open]);

  if (!open) return null;

  const version = state.updates.version ?? "the latest version";
  const onDialogKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      controller.dismissUpdate();
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
      (event.shiftKey ? last : first).focus();
    }
  };

  return (
    <div className="update-modal-scrim" role="presentation">
      <section
        ref={dialogRef}
        className="update-modal"
        onKeyDown={onDialogKeyDown}
        role="dialog"
        aria-modal="true"
        aria-busy={installing}
        aria-labelledby="update-modal-title"
        aria-describedby="update-modal-description"
      >
        <div className="update-modal-icon" aria-hidden="true">
          <Download size={20} strokeWidth={1.8} />
        </div>
        <p className="eyebrow">Arlet update</p>
        <h2 id="update-modal-title">
          {installing ? "Installing update" : "Update downloaded"}
        </h2>
        {installing ? (
          <p id="update-modal-description">
            Version <strong>{version}</strong> is being installed. Arlet will
            restart automatically when installation finishes.
          </p>
        ) : (
          <p id="update-modal-description">
            Version <strong>{version}</strong> is ready to install. Restart
            Arlet now to apply the update.
          </p>
        )}
        {showReleaseNotes ? (
          <div
            className="update-modal-notes"
            role="region"
            aria-label="Release notes"
          >
            <ReleaseNotes markdown={state.updates.releaseNotes} />
          </div>
        ) : null}
        {state.updates.error ? (
          <p className="update-modal-error" role="alert">
            {state.updates.error}
          </p>
        ) : null}
        <div className="update-modal-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={installing}
            onClick={controller.dismissUpdate}
          >
            Later
          </button>
          <button
            ref={restartButton}
            className="primary-button"
            type="button"
            disabled={installing}
            onClick={() =>
              void controller.installUpdate().catch(() => undefined)
            }
          >
            <RefreshCw
              aria-hidden="true"
              size={15}
              strokeWidth={1.9}
              className={installing ? "spin" : undefined}
            />
            {installing ? "Installing…" : "Restart and update"}
          </button>
        </div>
      </section>
    </div>
  );
}

export default UpdateReadyModal;
