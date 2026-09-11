import { describe, expect, it } from "vitest";
import { registerLifecycleDiagnostics } from "../phase0/lifecycle.ts";

describe("lifecycle diagnostics", () => {
  it("logs visibility, network, and focus changes", () => {
    const lines: string[] = [];
    const stop = registerLifecycleDiagnostics((message) => {
      lines.push(message);
    });

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));

    expect(lines).toEqual([
      `lifecycle: visibility ${document.visibilityState}`,
      "lifecycle: network offline",
      "lifecycle: network online",
      "lifecycle: window blur",
      "lifecycle: window focus",
    ]);
    stop();
  });
});
