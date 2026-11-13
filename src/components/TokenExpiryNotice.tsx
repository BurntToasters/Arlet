import { CircleAlert, X } from "lucide-preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { useAppSlices } from "../app/context.tsx";

export const TOKEN_EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * Apple Music access uses a developer token that Arlet downloads at launch.
 * Warn before it expires; restarting Arlet downloads a fresh token.
 */
export function TokenExpiryNotice({
  now = Date.now,
  isDevelopment = import.meta.env.DEV,
}: {
  now?: () => number;
  isDevelopment?: boolean;
}): JSX.Element | null {
  const state = useAppSlices("developerTokenExpiresAt");
  const [dismissed, setDismissed] = useState(false);
  const expiresAt = state.developerTokenExpiresAt;
  if (isDevelopment || dismissed || expiresAt === undefined) return null;
  const remaining = expiresAt - now();
  if (remaining > TOKEN_EXPIRY_WARNING_DAYS * DAY_MS) return null;
  const days = Math.max(1, Math.floor(remaining / DAY_MS));
  const message =
    remaining <= 0
      ? "Arlet's Apple Music access has expired. Restart Arlet to refresh it."
      : `Arlet's Apple Music access expires in ${days} ${days === 1 ? "day" : "days"}. Restart Arlet to refresh it.`;
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
