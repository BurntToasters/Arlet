import { CircleAlert, X } from "lucide-preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { useAppState } from "../app/context.tsx";

export const TOKEN_EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * The developer token is compiled into each release. Users who turned off
 * auto-update get this notice before Apple Music stops working.
 */
export function TokenExpiryNotice({
  now = Date.now,
  isDevelopment = import.meta.env.DEV,
}: {
  now?: () => number;
  isDevelopment?: boolean;
}): JSX.Element | null {
  const state = useAppState();
  const [dismissed, setDismissed] = useState(false);
  const expiresAt = state.developerTokenExpiresAt;
  if (isDevelopment || dismissed || expiresAt === undefined) return null;
  const remaining = expiresAt - now();
  if (remaining > TOKEN_EXPIRY_WARNING_DAYS * DAY_MS) return null;
  const days = Math.max(1, Math.floor(remaining / DAY_MS));
  const message =
    remaining <= 0
      ? "This version of Arlet has expired and can no longer play Apple Music. Install the latest update."
      : `This version of Arlet stops working with Apple Music in ${days} ${days === 1 ? "day" : "days"}. Install the latest update.`;
  return (
    <div className="token-expiry-notice" role="alert">
      <CircleAlert aria-hidden="true" size={16} strokeWidth={1.9} />
      <span>{message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
      >
        <X aria-hidden="true" size={14} strokeWidth={1.9} />
      </button>
    </div>
  );
}
