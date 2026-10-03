import { redactSensitive } from "../platform/redact.ts";

export const ACTION_ERROR_EVENT = "arlet:action-error";
const MAX_MESSAGE_LENGTH = 200;

/**
 * Surfaces a failed user action (play, queue, pin, sign-in) as a toast. The
 * controller has already logged the failure; this only tells the user.
 */
export function reportActionError(error: unknown): void {
  const raw =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  const message =
    redactSensitive(raw).replace(/\s+/gu, " ").trim() ||
    "Something went wrong.";
  window.dispatchEvent(
    new CustomEvent<string>(ACTION_ERROR_EVENT, {
      detail:
        message.length > MAX_MESSAGE_LENGTH
          ? `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
          : message,
    }),
  );
}
