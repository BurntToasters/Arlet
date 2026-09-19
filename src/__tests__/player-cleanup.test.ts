import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { AppController } from "../app/controller.ts";
import { AppProvider } from "../app/context.tsx";
import type { HashRouter } from "../routing/router.ts";
import { playerErrorLabel } from "../components/PlayerBar.tsx";
import { QueueDrawer } from "../components/QueueDrawer.tsx";
import type { AppErrorCode } from "../domain/errors.ts";
import type { Track } from "../domain/music.ts";
import { resetApplicationState, setQueue, setUiState } from "../state.ts";

beforeEach(() => resetApplicationState());
afterEach(() => resetApplicationState());

describe("playerErrorLabel", () => {
  it("maps every error code to a short human label", () => {
    expect(playerErrorLabel("NETWORK")).toBe("No connection");
    expect(playerErrorLabel("AUTH_REQUIRED")).toBe("Sign in needed");
    expect(playerErrorLabel("SUBSCRIPTION_REQUIRED")).toBe(
      "Subscription needed",
    );
    expect(playerErrorLabel("TOKEN_EXPIRED")).toBe("Session expired");
    expect(playerErrorLabel("MUSICKIT_INIT_FAILED")).toBe("Player unavailable");
    expect(playerErrorLabel("PLAYBACK_FAILED")).toBe("Can't play");
    expect(playerErrorLabel("CONTENT_UNAVAILABLE")).toBe("Unavailable");
    expect(playerErrorLabel("RATE_LIMITED")).toBe("Rate limited");
    expect(playerErrorLabel("UPDATER_FAILED")).toBe("Update failed");
    expect(playerErrorLabel("UNKNOWN")).toBe("Error");
  });

  it("never leaks raw codes", () => {
    const codes: AppErrorCode[] = [
      "NETWORK",
      "AUTH_REQUIRED",
      "SUBSCRIPTION_REQUIRED",
      "TOKEN_EXPIRED",
      "MUSICKIT_INIT_FAILED",
      "PLAYBACK_FAILED",
      "CONTENT_UNAVAILABLE",
      "RATE_LIMITED",
      "UPDATER_FAILED",
      "UNKNOWN",
    ];
    for (const code of codes) {
      expect(playerErrorLabel(code)).not.toBe(code);
    }
  });
});

function track(id: string, title: string): Track {
  return { id, title, artistName: "Artist" };
}

function stubController(): AppController {
  return {
    playQueueItem: vi.fn(async () => undefined),
    toggleQueue: vi.fn(),
  } as unknown as AppController;
}

function testRouter(): HashRouter {
  return {
    getRoute: () => ({ kind: "home" }),
    navigate: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    subscribe: () => () => undefined,
    start: () => () => undefined,
  };
}

async function renderQueue(): Promise<HTMLDivElement> {
  const root = document.createElement("div");
  document.body.append(root);
  await act(async () => {
    render(
      h(AppProvider, {
        controller: stubController(),
        router: testRouter(),
        children: h(QueueDrawer, null),
      }),
      root,
    );
    await Promise.resolve();
  });
  return root;
}

describe("QueueDrawer cleanup", () => {
  it("shows an icon for the playing row and numbers elsewhere", async () => {
    setQueue([track("a", "First"), track("b", "Second")], 0);
    setUiState({ queueOpen: true });
    const root = await renderQueue();
    const indexes = root.querySelectorAll(".queue-index");
    expect(indexes).toHaveLength(2);
    expect(indexes[0].querySelector("svg")).not.toBeNull();
    expect(indexes[0].textContent).not.toContain("♫");
    expect(indexes[1].textContent).toContain("2");
    render(null, root);
    root.remove();
  });

  it("describes every queue source in the empty state", async () => {
    setQueue([], 0);
    setUiState({ queueOpen: true });
    const root = await renderQueue();
    expect(root.textContent).toContain("Your queue is empty");
    expect(root.textContent).toContain("playlist");
    expect(root.textContent).not.toContain("from Search");
    render(null, root);
    root.remove();
  });
});
