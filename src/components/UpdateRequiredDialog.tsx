import { Download, RefreshCw } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { useAppController, useAppSlices } from "../app/context.tsx";
import {
  getUpdateRequirement,
  subscribeUpdateRequirement,
  type UpdateRequirement,
} from "../platform/min-version.ts";
import { quitArlet } from "../platform/quit.ts";
import { reportActionError } from "./action-errors.ts";
import { useModalDialog } from "./use-modal-dialog.ts";

/**
 * Shown when this build is below the minimum version. It cannot be dismissed:
 * the update check runs, and the updater's own dialog takes over when an
 * update is ready to install.
 */
export function UpdateRequiredDialog(): JSX.Element | null {
  const [requirement, setRequirement] = useState<UpdateRequirement | null>(
    getUpdateRequirement,
  );
  const state = useAppSlices("updates");
  const controller = useAppController();
  const dialogRef = useRef<HTMLElement>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const updates = state.updates;
  const checking =
    updates.status === "checking" ||
    updates.status === "downloading" ||
    updates.status === "installing";
  // The updater's dialog shows the ready update; this one returns if it closes.
  const open =
    requirement !== null &&
    !updates.promptOpen &&
    updates.status !== "installing";

  useEffect(() => {
    setRequirement(getUpdateRequirement());
    return subscribeUpdateRequirement(() =>
      setRequirement(getUpdateRequirement()),
    );
  }, []);

  useModalDialog(dialogRef, {
    active: open,
    initialFocus: () => checkButton.current,
    deferFocus: true,
    escapeAnywhere: true,
    onEscape: (event) => {
      event.preventDefault();
    },
  });

  if (!open || !requirement) return null;

  const checkForUpdates = (): void => {
    void controller.checkForUpdates().catch(() => undefined);
  };

  const quit = (): void => {
    void quitArlet().catch(reportActionError);
  };

  return (
    <div className="update-modal-scrim" role="presentation">
      <section
        ref={dialogRef}
        className="update-modal"
        role="alertdialog"
        aria-modal="true"
        aria-busy={checking}
        aria-labelledby="update-required-title"
        aria-describedby="update-required-description"
      >
        <div className="update-modal-icon" aria-hidden="true">
          <Download size={20} strokeWidth={1.8} />
        </div>
        <p className="eyebrow">Arlet update</p>
        <h2 id="update-required-title">Update required</h2>
        <p id="update-required-description">
          This version of Arlet (v{requirement.current}) is no longer supported.
          Arlet v{requirement.minimum} or newer is required to keep listening.
        </p>
        {updates.status === "up-to-date" ? (
          <p role="status">No newer version is available yet.</p>
        ) : null}
        {updates.error ? (
          <p className="update-modal-error" role="alert">
            {updates.error}
          </p>
        ) : null}
        <div className="update-modal-actions">
          <button
            ref={checkButton}
            className="primary-button"
            type="button"
            disabled={checking}
            onClick={checkForUpdates}
          >
            <RefreshCw
              aria-hidden="true"
              size={15}
              strokeWidth={1.9}
              className={checking ? "spin" : undefined}
            />
            Check for updates
          </button>
          <button className="secondary-button" type="button" onClick={quit}>
            Quit Arlet
          </button>
        </div>
      </section>
    </div>
  );
}

export default UpdateRequiredDialog;
