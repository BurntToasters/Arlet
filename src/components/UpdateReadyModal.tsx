import { Download, RefreshCw } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import type { JSX } from "preact";
import { useAppController, useAppSlices } from "../app/context.tsx";
import { lazyView } from "./lazy.tsx";
import { useModalDialog } from "./use-modal-dialog.ts";

// Release notes are only parsed when the modal shows them, so the Markdown
// renderer stays out of the entry bundle. The modal itself stays in the entry.
const ReleaseNotesView = lazyView(
  () => import("./ReleaseNotes.tsx").then((module) => module.ReleaseNotes),
  {
    name: "Release notes",
    loading: () => (
      <p className="update-modal-notes-loading" role="status">
        Loading release notes…
      </p>
    ),
  },
);

/**
 * The updater downloads in the background, then asks only when the signed
 * installer is ready. Keeping this in the shell means it is available over
 * every route without involving native notification or dialog surfaces.
 */
export function UpdateReadyModal(): JSX.Element | null {
  const state = useAppSlices("updates");
  const controller = useAppController();
  const dialogRef = useRef<HTMLElement>(null);
  const restartButton = useRef<HTMLButtonElement>(null);
  const installing = state.updates.status === "installing";
  const showReleaseNotes = state.updates.status === "ready";
  const open =
    (state.updates.promptOpen || installing) && Boolean(state.updates.version);

  useModalDialog(dialogRef, {
    active: open,
    initialFocus: () => restartButton.current,
    deferFocus: true,
    onEscape: (event) => {
      event.preventDefault();
      controller.dismissUpdate();
    },
  });

  // Installing disables both buttons, which drops focus to <body> and out of
  // the dialog's key handling; the dialog itself holds focus instead.
  useEffect(() => {
    if (open && installing) dialogRef.current?.focus();
  }, [open, installing]);

  if (!open) return null;

  const version = state.updates.version ?? "the latest version";
  return (
    <div className="update-modal-scrim" role="presentation">
      <section
        ref={dialogRef}
        className="update-modal"
        tabIndex={-1}
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
            <ReleaseNotesView markdown={state.updates.releaseNotes} />
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
