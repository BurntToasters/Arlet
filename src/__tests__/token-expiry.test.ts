import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "preact/test-utils";
import { h, render } from "preact";
import {
  TOKEN_EXPIRY_WARNING_DAYS,
  TokenExpiryNotice,
} from "../components/TokenExpiryNotice.tsx";
import { developerTokenExpiry } from "../musickit/token.ts";
import { resetApplicationState, setDeveloperTokenExpiry } from "../state.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 3);

function jwt(payload: unknown): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/u, "");
  return `${encode({ alg: "ES256" })}.${encode(payload)}.sig`;
}

// Failure modes: users with auto-update off get no warning before the
// embedded token expires and Apple Music stops working; a malformed token
// crashes the shell; the notice nags long before it matters or in dev.
describe("developer token expiry notice", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    resetApplicationState();
    root = document.createElement("div");
  });

  afterEach(() => {
    void act(() => render(null, root));
    resetApplicationState();
  });

  const show = (expiresAt: number | undefined, isDevelopment = false) => {
    void act(() => {
      setDeveloperTokenExpiry(expiresAt);
      render(h(TokenExpiryNotice, { now: () => NOW, isDevelopment }), root);
    });
    return root.textContent ?? "";
  };

  it("reads exp from the JWT and ignores malformed tokens", () => {
    expect(developerTokenExpiry(jwt({ exp: NOW / 1000 + 60 }))).toBe(
      NOW + 60_000,
    );
    for (const bad of [undefined, "", "a.b", jwt({ exp: "soon" }), "x.!!.y"]) {
      expect(developerTokenExpiry(bad)).toBeUndefined();
    }
  });

  it("warns only inside the window and counts the days", () => {
    expect(show(NOW + (TOKEN_EXPIRY_WARNING_DAYS + 1) * DAY)).toBe("");
    expect(show(undefined)).toBe("");
    expect(show(NOW + 3 * DAY + 1000)).toContain("3 days");
    expect(show(NOW - DAY)).toContain("has expired");
    expect(show(NOW + 2 * DAY, true)).toBe("");
  });
});
