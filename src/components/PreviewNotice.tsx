import { CircleAlert, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { useAppController, useAppSlices } from "../app/context.tsx";
import { reportActionError } from "./action-errors.ts";

// Dismissal lives in module state so the player bar can re-open the notice.
// It resets only on app restart, which matches "this session".
let dismissedThisSession = false;
const dismissListeners = new Set<() => void>();

function setDismissedThisSession(next: boolean): void {
  if (dismissedThisSession === next) return;
  dismissedThisSession = next;
  for (const listener of dismissListeners) listener();
}

/** Shows the Previews only notice again, even after the user dismissed it. */
export function reopenPreviewNotice(): void {
  setDismissedThisSession(false);
}

function usePreviewNoticeDismissed(): boolean {
  const [dismissed, setDismissed] = useState(dismissedThisSession);
  useEffect(() => {
    const sync = (): void => setDismissed(dismissedThisSession);
    dismissListeners.add(sync);
    sync();
    return () => {
      dismissListeners.delete(sync);
    };
  }, []);
  return dismissed;
}

/**
 * Without an Apple Music subscription MusicKit only plays 30-second previews.
 * Shown only once MusicKit has reported "none", never for "unknown" or "active".
 */
export function PreviewNotice(): JSX.Element | null {
  const { account } = useAppSlices("account");
  const controller = useAppController();
  const dismissed = usePreviewNoticeDismissed();
  if (account.subscription !== "none" || dismissed) return null;
  return (
    <div className="preview-notice" role="status">
      <CircleAlert aria-hidden="true" size={16} strokeWidth={1.9} />
      <div className="preview-notice-copy">
        <strong>Previews only</strong>
        <span>
          Without an Apple Music subscription, Arlet can play 30-second
          previews.
        </span>
      </div>
      <div className="preview-notice-actions">
        <button
          className="primary-button"
          type="button"
          onClick={() =>
            void Promise.resolve(controller.openSubscribe()).catch(
              reportActionError,
            )
          }
        >
          Subscribe
        </button>
        <button
          className="preview-notice-dismiss"
          type="button"
          aria-label="Dismiss"
          onClick={() => setDismissedThisSession(true)}
        >
          <X aria-hidden="true" size={14} strokeWidth={1.9} />
        </button>
      </div>
    </div>
  );
}
