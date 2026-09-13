import { describe, expect, it, vi } from "vitest";
import { describePopupUrl, installAuthPopupProbe } from "../musickit/auth.ts";

describe("describePopupUrl", () => {
  it("logs host only and drops JWT query strings", () => {
    expect(
      describePopupUrl(
        "https://authorize.music.apple.com/woa?a=eyJhbGciOiJFUzI1NiJ9.payload",
      ),
    ).toBe("host=authorize.music.apple.com");
  });

  it("describes blank and about:blank without throwing", () => {
    expect(describePopupUrl("")).toBe("host=(blank)");
    expect(describePopupUrl("about:blank")).toBe("host=about:blank");
  });

  it("marks unparseable values", () => {
    expect(describePopupUrl("https://[")).toBe("host=(unparseable)");
  });
});

describe("installAuthPopupProbe", () => {
  it("reports a blocked window.open", () => {
    const lines: string[] = [];
    const open = vi.fn(() => null);
    const restore = installAuthPopupProbe(
      (message) => lines.push(message),
      open,
    );
    const result = window.open("https://authorize.music.apple.com/woa");
    restore();
    expect(result).toBeNull();
    expect(open).toHaveBeenCalledOnce();
    expect(lines).toEqual([
      "Auth popup host=authorize.music.apple.com",
      "Auth popup blocked (window.open returned null).",
    ]);
  });

  it("does not report blocked when a window is returned", () => {
    const lines: string[] = [];
    const fake = {} as Window;
    const open = vi.fn(() => fake);
    const restore = installAuthPopupProbe(
      (message) => lines.push(message),
      open,
    );
    expect(window.open("https://authorize.music.apple.com/woa")).toBe(fake);
    restore();
    expect(lines).toEqual(["Auth popup host=authorize.music.apple.com"]);
  });
});
