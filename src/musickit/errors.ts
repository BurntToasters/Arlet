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
