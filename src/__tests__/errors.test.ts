import { describe, expect, it } from "vitest";
import { mapErrorToCode } from "../musickit/errors.ts";

describe("mapErrorToCode", () => {
  it("maps network failures", () => {
    expect(mapErrorToCode(new Error("fetch failed"))).toBe("NETWORK");
    expect(mapErrorToCode("Network timeout")).toBe("NETWORK");
  });

  it("maps authorization failures", () => {
    expect(mapErrorToCode(new Error("Not authorized"))).toBe("AUTH_REQUIRED");
  });

  it("maps subscription failures", () => {
    expect(mapErrorToCode("Apple Music membership required")).toBe(
      "SUBSCRIPTION_REQUIRED",
    );
  });

  it("maps expired tokens", () => {
    expect(mapErrorToCode("Developer token expired")).toBe("TOKEN_EXPIRED");
  });

  it("maps rate limiting", () => {
    expect(mapErrorToCode("429 too many requests")).toBe("RATE_LIMITED");
  });

  it("maps unavailable content", () => {
    expect(mapErrorToCode("Song not playable in this storefront")).toBe(
      "CONTENT_UNAVAILABLE",
    );
  });

  it("maps MusicKit init failures", () => {
    expect(mapErrorToCode("MusicKit configuration failed")).toBe(
      "MUSICKIT_INIT_FAILED",
    );
  });

  it("defaults unknown DRM/runtime failures to PLAYBACK_FAILED", () => {
    expect(mapErrorToCode(new Error("EME key error 0x1234"))).toBe(
      "PLAYBACK_FAILED",
    );
    expect(mapErrorToCode(undefined)).toBe("PLAYBACK_FAILED");
  });
});
