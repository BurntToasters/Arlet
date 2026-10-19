import { CircleAlert } from "lucide-preact";
import type { JSX } from "preact";
import { useAppController, useAppSlices } from "../app/context.tsx";
import { reportActionError } from "./action-errors.ts";

/**
 * Apple rejected the saved sign-in, usually after an Apple ID password change.
 * Local data stays; it clears only once the user signs in again.
 */
export function SessionExpiredNotice(): JSX.Element | null {
  const { auth } = useAppSlices("auth");
  const controller = useAppController();
  if (auth.status !== "authorized" || auth.sessionExpired !== true) return null;
  const pending = auth.pending === true;
  return (
    <div className="session-expired-notice" role="alert">
      <CircleAlert aria-hidden="true" size={16} strokeWidth={1.9} />
      <span>
        Your Apple Music sign-in expired. This happens after an Apple ID
        password change. Sign in again to keep listening.
      </span>
      <div className="session-expired-actions">
        <button
          className="primary-button"
          type="button"
          disabled={pending}
          onClick={() => void controller.reauthorize().catch(reportActionError)}
        >
          {pending ? "Signing in…" : "Sign in again"}
        </button>
        {pending ? (
          <button
            className="secondary-button"
            type="button"
            data-action="cancel-sign-in"
            onClick={() => controller.cancelSignIn()}
          >
            Cancel
          </button>
        ) : null}
        <button
          className="secondary-button"
          type="button"
          disabled={pending}
          onClick={() => void controller.signOut().catch(reportActionError)}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
