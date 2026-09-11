import { describe, expect, it } from "vitest";
import { redactSensitive } from "../platform/redact.ts";

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
});
