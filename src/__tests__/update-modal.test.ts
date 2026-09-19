import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { AppProvider } from "../app/context.tsx";
import type { AppController } from "../app/controller.ts";
import { UpdateReadyModal } from "../components/UpdateReadyModal.tsx";
import { createHashRouter } from "../routing/router.ts";
import { resetApplicationState, setUpdateState } from "../state.ts";

describe("update ready modal", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    resetApplicationState();
    root = document.createElement("div");
    document.body.append(root);
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    resetApplicationState();
  });

  it("keeps Tab and Shift+Tab inside the dialog", async () => {
    const controller = {
      dismissUpdate: vi.fn(),
      installUpdate: vi.fn().mockResolvedValue(undefined),
    } as unknown as AppController;
    setUpdateState({
      status: "ready",
      version: "0.2.0",
      promptOpen: true,
    });
    render(
      h(AppProvider, {
        controller,
        router: createHashRouter(),
        children: h(UpdateReadyModal, {}),
      }),
      root,
    );
    await new Promise<void>((resolve) => window.setTimeout(resolve, 10));

    const dialog = root.querySelector<HTMLElement>('[role="dialog"]');
    const buttons = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );
    expect(buttons).toHaveLength(2);
    const [later, restart] = buttons;

    restart?.focus();
    const forward = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    });
    expect(forward.key).toBe("Tab");
    restart?.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(later);

    const backward = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
      shiftKey: true,
    });
    later?.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(restart);
  });

  it("keeps the dialog visible with an installing status", async () => {
    const controller = {
      dismissUpdate: vi.fn(),
      installUpdate: vi.fn().mockResolvedValue(undefined),
    } as unknown as AppController;
    setUpdateState({
      status: "installing",
      version: "0.2.0",
      promptOpen: false,
      message: "Installing version 0.2.0…",
    });
    render(
      h(AppProvider, {
        controller,
        router: createHashRouter(),
        children: h(UpdateReadyModal, {}),
      }),
      root,
    );
    await new Promise<void>((resolve) => window.setTimeout(resolve, 10));

    const dialog = root.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Installing update");
    expect(dialog?.textContent).toContain("restart automatically");
    expect(
      dialog?.querySelector<HTMLButtonElement>("button.primary-button")
        ?.disabled,
    ).toBe(true);
    expect(
      dialog?.querySelector<HTMLButtonElement>("button.secondary-button")
        ?.disabled,
    ).toBe(true);
    expect(dialog?.querySelector(".update-modal-notes")).toBeNull();
  });

  it("renders release-note Markdown as safe, non-navigating content", async () => {
    const controller = {
      dismissUpdate: vi.fn(),
      installUpdate: vi.fn().mockResolvedValue(undefined),
    } as unknown as AppController;
    setUpdateState({
      status: "ready",
      version: "0.2.0",
      promptOpen: true,
      releaseNotes: [
        "# Heading",
        "",
        "A paragraph with **bold**, *emphasis*, and `inline code`.",
        "",
        "- One",
        "- Two",
        "",
        "1. First",
        "2. Second",
        "",
        "> A quote",
        "",
        "```ts",
        "const value = 1;",
        "```",
        "",
        "[Documentation](https://example.test) ![image](https://example.test/image.png) <script>alert(1)</script>",
      ].join("\n"),
    });
    render(
      h(AppProvider, {
        controller,
        router: createHashRouter(),
        children: h(UpdateReadyModal, {}),
      }),
      root,
    );
    await new Promise<void>((resolve) => window.setTimeout(resolve, 10));

    const notes = root.querySelector<HTMLElement>(".update-modal-notes");
    expect(notes).not.toBeNull();
    expect(notes?.querySelector("h1")?.textContent).toBe("Heading");
    expect(notes?.querySelector("ul li")?.textContent).toBe("One");
    expect(notes?.querySelector("ol li")?.textContent).toBe("First");
    expect(notes?.querySelector("blockquote")?.textContent).toContain(
      "A quote",
    );
    expect(notes?.querySelector("strong")?.textContent).toBe("bold");
    expect(notes?.querySelector("em")?.textContent).toBe("emphasis");
    expect(notes?.querySelector("pre code")?.textContent).toContain(
      "const value = 1;",
    );
    expect(notes?.querySelector("p code")?.textContent).toBe("inline code");
    expect(notes?.querySelector("a")).toBeNull();
    expect(notes?.querySelector("img")).toBeNull();
    expect(notes?.textContent).toContain(
      "[image](https://example.test/image.png)",
    );
    expect(notes?.textContent).toContain("<script>alert(1)</script>");
    expect(notes?.querySelector(".update-modal-actions")).toBeNull();
    expect(root.querySelector(".update-modal-actions")).not.toBeNull();
  });

  it("shows a generic fallback when release notes are unavailable", async () => {
    const controller = {
      dismissUpdate: vi.fn(),
      installUpdate: vi.fn().mockResolvedValue(undefined),
    } as unknown as AppController;
    setUpdateState({
      status: "ready",
      version: "0.2.0",
      promptOpen: true,
      releaseNotes: undefined,
    });
    render(
      h(AppProvider, {
        controller,
        router: createHashRouter(),
        children: h(UpdateReadyModal, {}),
      }),
      root,
    );
    await new Promise<void>((resolve) => window.setTimeout(resolve, 10));

    expect(root.querySelector(".update-modal-notes")?.textContent).toBe(
      "Release notes unavailable.",
    );
  });
});
