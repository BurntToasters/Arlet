import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "preact/test-utils";
import { h, render } from "preact";
import {
  ACTION_TOAST_LIMIT,
  ACTION_TOAST_TIMEOUT_MS,
  ActionToasts,
} from "../components/ActionToasts.tsx";
import { reportActionError } from "../components/action-errors.ts";

// Failure modes: a failed user action leaves no visible trace; tokens in
// provider error text reach the screen; repeated failures pile up without
// bound; toasts never dismiss; the region is not announced to assistive tech.
describe("action error toasts", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement("div");
    document.body.append(root);
    void act(() => {
      render(h(ActionToasts, {}), root);
    });
  });

  afterEach(() => {
    void act(() => {
      render(null, root);
    });
    root.remove();
    vi.useRealTimers();
  });

  const messages = (): string[] =>
    [...root.querySelectorAll(".action-toast-message")].map(
      (node) => node.textContent ?? "",
    );

  it("shows a failed action's message in a live region", () => {
    void act(() =>
      reportActionError(new Error("This playlist cannot be edited.")),
    );
    expect(messages()).toEqual(["This playlist cannot be edited."]);
    const region = root.querySelector(".action-toasts");
    expect(region?.getAttribute("aria-live")).toBe("polite");
  });

  it("redacts tokens and bounds message length", () => {
    void act(() =>
      reportActionError(
        `Music-User-Token: AqmL0f7xY2Zp9wR3kT8vN1bC4dE6gH ${"x".repeat(500)}`,
      ),
    );
    const [message = ""] = messages();
    expect(message).not.toContain("AqmL0f7xY2Zp9wR3kT8vN1bC4dE6gH");
    expect(message.length).toBeLessThanOrEqual(200);
  });

  it("keeps only the newest toasts and dismisses them", () => {
    void act(() => {
      for (let index = 0; index < ACTION_TOAST_LIMIT + 2; index += 1) {
        reportActionError(new Error(`failure ${index}`));
      }
    });
    expect(messages()).toHaveLength(ACTION_TOAST_LIMIT);
    expect(messages().at(-1)).toBe(`failure ${ACTION_TOAST_LIMIT + 1}`);

    void act(() => {
      root.querySelector<HTMLButtonElement>(".action-toast button")?.click();
    });
    expect(messages()).toHaveLength(ACTION_TOAST_LIMIT - 1);

    void act(() => {
      vi.advanceTimersByTime(ACTION_TOAST_TIMEOUT_MS);
    });
    expect(messages()).toEqual([]);
  });

  it("collapses an identical repeated failure", () => {
    void act(() => {
      reportActionError(new Error("MusicKit is still initializing."));
      reportActionError(new Error("MusicKit is still initializing."));
    });
    expect(messages()).toEqual(["MusicKit is still initializing."]);
  });
});
