import type { AppErrorCode } from "../domain/errors.ts";

// Map unknown MusicKit/player failures to typed AppErrorCode values (plan
// section 19). Never report "song unavailable" unless the source actually
// says the content is unavailable; unknown runtime/DRM conditions stay
// PLAYBACK_FAILED so the UI can suggest a restart instead of blaming the song.
export function mapErrorToCode(error: unknown): AppErrorCode {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const text = message.toLowerCase();

  if (
    text.includes("network") ||
    text.includes("fetch failed") ||
    text.includes("failed to fetch") ||
    text.includes("offline") ||
    text.includes("timeout")
  ) {
    return "NETWORK";
  }
  if (
    text.includes("unauthorized") ||
    text.includes("not authorized") ||
    text.includes("auth") ||
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
  if (
    text.includes("token") &&
    (text.includes("expir") ||
      text.includes("invalid") ||
      text.includes("revok"))
  ) {
    return "TOKEN_EXPIRED";
  }
  if (
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("429")
  ) {
    return "RATE_LIMITED";
  }
  if (
    text.includes("unavailable") ||
    text.includes("not found") ||
    text.includes("404") ||
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
