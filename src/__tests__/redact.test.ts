import { describe, expect, it } from "vitest";
import {
  clearSensitiveValues,
  redactSensitive,
  registerSensitiveValue,
} from "../platform/redact.ts";

describe("redactSensitive", () => {
  it("redacts JWT-shaped tokens", () => {
    const text =
      "Authorization: Bearer eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.payload";
    const result = redactSensitive(text);
    expect(result).not.toContain("eyJ");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts bare tokens without a header", () => {
    const result = redactSensitive("token=eyJabc123, next=1");
    expect(result).not.toContain("eyJ");
  });

  it("redacts every token in one entry", () => {
    const result = redactSensitive("dev=eyJkZXYtdG9rZW4 user=eyJ1c2VyLXRva2Vu");
    expect(result).not.toContain("eyJ");
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("preserves ordinary request logs", () => {
    const text = "GET /v1/catalog/us/songs status=200";
    expect(redactSensitive(text)).toBe(text);
  });

  // Failure modes: Music User Tokens are not JWTs, so the eyJ rule misses
  // them in headers, query strings, JSON bodies, and bare error text.
  it("redacts Music User Tokens by key in headers, queries, and JSON", () => {
    const token = "AqmL0f7xY2/Zp+Q9wR3kT8vN1bC4dE6gH5jK7mP0sU2yW==";
    for (const text of [
      `Music-User-Token: ${token}`,
      `media-user-token=${token}&l=en`,
      `{"musicUserToken":"${token}"}`,
      `developerToken = '${token}'`,
    ]) {
      const result = redactSensitive(text);
      expect(result).not.toContain(token);
      expect(result).toContain("[REDACTED]");
    }
  });

  it("redacts registered token values anywhere in text", () => {
    const token = "Ar7sQk2LmN9pX4vB8cD1fG6hJ3kL5mN0pQ2rS4tU6vW8xY";
    registerSensitiveValue(token);
    try {
      expect(redactSensitive(`playback failed for ${token} (403)`)).toBe(
        "playback failed for [REDACTED] (403)",
      );
    } finally {
      clearSensitiveValues();
    }
    expect(redactSensitive(`after clear ${token}`)).toContain(token);
  });

  it("ignores short or empty registered values", () => {
    registerSensitiveValue("");
    registerSensitiveValue("us");
    try {
      expect(redactSensitive("storefront us status")).toBe(
        "storefront us status",
      );
    } finally {
      clearSensitiveValues();
    }
  });
});
