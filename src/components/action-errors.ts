import type { QueueEditTier } from "../musickit/queue-edit.ts";
import { redactSensitive } from "../platform/redact.ts";

export const ACTION_ERROR_EVENT = "arlet:action-error";
export const ACTION_NOTICE_EVENT = "arlet:action-notice";
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

/** A short success confirmation toast, for actions with no other feedback. */
export function reportNotice(message: string): void {
  window.dispatchEvent(
    new CustomEvent<string>(ACTION_NOTICE_EVENT, { detail: message }),
  );
}

let queueRebuildNoticeShown = false;

/**
 * Reports a queue edit. Failures use the error toast. The first edit that
 * rebuilds the provider queue also notes the brief audio restart.
 */
export function reportQueueEdit(edit: Promise<QueueEditTier>): void {
  void edit
    .then((tier) => {
      if (tier !== "rebuild" || queueRebuildNoticeShown) return;
      queueRebuildNoticeShown = true;
      reportNotice("Queue edits briefly restart audio in this runtime.");
    })
    .catch(reportActionError);
}
