import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "preact/test-utils";
import { h, render } from "preact";
import { AppProvider } from "../app/context.tsx";
import type { AppController } from "../app/controller.ts";
import { PlaylistDialogs } from "../components/PlaylistDialogs.tsx";
import { requestPlaylistDialog } from "../components/playlist-events.ts";
import { createHashRouter } from "../routing/router.ts";
import { resetApplicationState } from "../state.ts";

// Failure modes: folder naming falls back to the native window.prompt
// ("tauri.localhost says…"); an empty name reaches Apple; a failed create
// closes the dialog with no message.
describe("new playlist folder dialog", () => {
  let root: HTMLDivElement;
  let createPlaylistFolder: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetApplicationState();
    root = document.createElement("div");
    document.body.append(root);
    createPlaylistFolder = vi.fn().mockResolvedValue({ id: "f1" });
    const controller = { createPlaylistFolder } as unknown as AppController;
    void act(() => {
      render(
        h(AppProvider, {
          controller,
          router: createHashRouter(),
          children: h(PlaylistDialogs, {}),
        }),
        root,
      );
    });
  });

  afterEach(() => {
    void act(() => render(null, root));
    root.remove();
    resetApplicationState();
  });

  const open = (): void => {
    void act(() => requestPlaylistDialog("folder"));
  };
  const input = (): HTMLInputElement =>
    root.querySelector<HTMLInputElement>(".playlist-dialog-form input")!;
  const submit = async (): Promise<void> => {
    await act(async () => {
      root
        .querySelector<HTMLFormElement>(".playlist-dialog-form")!
        .dispatchEvent(new Event("submit", { cancelable: true }));
      await Promise.resolve();
    });
  };

  it("renders an in-app folder form without a description", () => {
    const prompt = vi.spyOn(window, "prompt");
    open();
    expect(root.querySelector("#playlist-dialog-title")?.textContent).toBe(
      "New playlist folder",
    );
    expect(root.querySelector(".playlist-dialog-form textarea")).toBeNull();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("creates the folder with the trimmed name and closes", async () => {
    open();
    void act(() => {
      input().value = "  Road trips  ";
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await submit();
    expect(createPlaylistFolder).toHaveBeenCalledWith("Road trips");
    expect(root.querySelector(".playlist-dialog")).toBeNull();
  });

  it("rejects an empty name and keeps failures in the dialog", async () => {
    open();
    await submit();
    expect(createPlaylistFolder).not.toHaveBeenCalled();
    expect(root.querySelector(".playlist-dialog-error")?.textContent).toBe(
      "Folder name is required.",
    );

    createPlaylistFolder.mockRejectedValueOnce(new Error("Apple said no"));
    void act(() => {
      input().value = "Work";
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await submit();
    await act(async () => {
      await Promise.resolve();
    });
    expect(root.querySelector(".playlist-dialog-error")?.textContent).toBe(
      "Apple said no",
    );
  });
});
