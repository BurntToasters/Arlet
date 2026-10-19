import type { AppErrorCode } from "../domain/errors.ts";
import { redactSensitive } from "../platform/redact.ts";

/** MusicKit `MKError` reason (`errorCode` or `reason`), also on a nested error. */
export function musicKitReasonOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const reason = record.errorCode ?? record.reason;
  if (typeof reason === "string") return reason;
  return record.error && record.error !== error
    ? musicKitReasonOf(record.error)
    : undefined;
}

const REASON_CODES: Record<string, AppErrorCode> = {
  AUTHORIZATION_ERROR: "AUTH_REQUIRED",
  UNAUTHORIZED_ERROR: "AUTH_REQUIRED",
  ACCESS_DENIED: "AUTH_REQUIRED",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  SUBSCRIPTION_ERROR: "SUBSCRIPTION_REQUIRED",
  NETWORK_ERROR: "NETWORK",
  QUOTA_EXCEEDED: "RATE_LIMITED",
  CONTENT_UNAVAILABLE: "CONTENT_UNAVAILABLE",
  CONTENT_RESTRICTED: "CONTENT_UNAVAILABLE",
  CONTENT_UNSUPPORTED: "CONTENT_UNAVAILABLE",
  NOT_FOUND: "CONTENT_UNAVAILABLE",
};

const LICENSE_REASONS = new Set(["MEDIA_LICENSE", "DEVICE_LIMIT"]);

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return String(error ?? "");
}

/** Player-bar text for a playback failure; never a raw MusicKit reason code. */
export function friendlyPlaybackMessage(error: unknown): string {
  const reason = musicKitReasonOf(error);
  if (reason && LICENSE_REASONS.has(reason)) {
    return "Apple Music couldn't start playback. If it's playing on another device, stop it there. If you changed your Apple ID password, sign in again.";
  }
  return redactSensitive(messageOf(error));
}

// Map unknown MusicKit/player failures to typed AppErrorCode values (plan
// section 19). Never report "song unavailable" unless the source actually
// says the content is unavailable; unknown runtime/DRM conditions stay
// PLAYBACK_FAILED so the UI can suggest a restart instead of blaming the song.
export function mapErrorToCode(error: unknown): AppErrorCode {
  const reason = musicKitReasonOf(error);
  const byReason = reason ? REASON_CODES[reason] : undefined;
  if (byReason) return byReason;
  const text = messageOf(error).toLowerCase();

  if (
    text.includes("network") ||
    text.includes("fetch failed") ||
    text.includes("failed to fetch") ||
    text.includes("offline") ||
    text.includes("timeout")
  ) {
    return "NETWORK";
  }
  // Checked before sign-in: "authorization token expired" is an expiry.
  if (
    text.includes("token") &&
    (text.includes("expir") ||
      text.includes("invalid") ||
      text.includes("revok"))
  ) {
    return "TOKEN_EXPIRED";
  }
  // Whole words only, so "author" or an id containing "auth" do not match.
  if (
    text.includes("unauthorized") ||
    text.includes("not authorized") ||
    /\bauth(?:entication|orization|orize|enticate)?\b/u.test(text) ||
    text.includes("sign in") ||
    text.includes("signin")
  ) {
    return "AUTH_REQUIRED";
  }
  if (
    text.includes("subscription") ||
    text.includes("membership") ||
    text.includes("not a member")
  ) {
    return "SUBSCRIPTION_REQUIRED";
  }
  // Status codes as whole numbers; ids often contain these digits.
  if (
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    /\b429\b/u.test(text)
  ) {
    return "RATE_LIMITED";
  }
  if (
    text.includes("unavailable") ||
    text.includes("not found") ||
    /\b404\b/u.test(text) ||
    text.includes("not playable") ||
    text.includes("region") ||
    text.includes("storefront")
  ) {
    return "CONTENT_UNAVAILABLE";
  }
  if (
    text.includes("musickit") &&
    (text.includes("init") ||
      text.includes("configur") ||
      text.includes("load"))
  ) {
    return "MUSICKIT_INIT_FAILED";
  }
  return "PLAYBACK_FAILED";
}

const MK_REASON_STATUS: Record<string, number> = {
  UNAUTHORIZED_ERROR: 401,
  ACCESS_DENIED: 403,
  NOT_FOUND: 404,
  QUOTA_EXCEEDED: 429,
};

/**
 * HTTP status of a failed Apple Music request. MusicKit v3 `MKError` keeps the
 * fetch `Response` on `data` and maps the status to `errorCode`.
 */
export function httpStatusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const nested = [record.data, record.response].map((value) =>
    value && typeof value === "object"
      ? (value as Record<string, unknown>).status
      : undefined,
  );
  for (const value of [record.status, record.statusCode, ...nested]) {
    if (typeof value === "number") return value;
  }
  const reason = record.errorCode ?? record.reason;
  return typeof reason === "string" ? MK_REASON_STATUS[reason] : undefined;
}
