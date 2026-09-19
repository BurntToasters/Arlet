import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { AppProvider } from "../app/context.tsx";
import type { AppController } from "../app/controller.ts";
import type { DiscoveryResource } from "../domain/music.ts";
import type { HashRouter } from "../routing/router.ts";
import { HomeView } from "../views/HomeView.tsx";
import {
  resetApplicationState,
  setAuthState,
  setHomeState,
  setInitializationState,
} from "../state.ts";

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

function testController(
  loadHome = vi.fn(async () => undefined),
): AppController {
  return {
    loadHome,
    authorize: vi.fn(async () => undefined),
  } as unknown as AppController;
}

afterEach(() => resetApplicationState());

async function renderHome(
  controller: AppController,
  router = testRouter(),
): Promise<HTMLDivElement> {
  const root = document.createElement("div");
  document.body.append(root);
  await act(async () => {
    render(
      h(AppProvider, {
        controller,
        router,
        children: h(HomeView, null),
      }),
      root,
    );
    await Promise.resolve();
  });
  return root;
}

describe("home discovery UI", () => {
  it("loads and renders supported recent, recommendation, and rotation cards", async () => {
    setInitializationState({ status: "ready" });
    setAuthState({ status: "authorized" });
    const loadHome = vi.fn(async () => undefined);
    setHomeState({
      status: "success",
      recentPlaylists: [
        {
          id: "playlist-1",
          name: "Late night",
          resourceType: "library-playlists",
          source: "library",
        },
        { id: "recent-album", name: "Not a playlist", resourceType: "albums" },
      ],
      recommendations: [
        {
          id: "rec-1",
          title: "Made for you",
          items: [
            {
              id: "album-1",
              name: "Blue hour",
              resourceType: "albums",
            },
            {
              id: "artist-1",
              name: "Unsupported artist",
              type: "artists",
            } as unknown as DiscoveryResource,
          ],
        },
      ],
      heavyRotation: [
        { id: "album-2", name: "Repeat", resourceType: "albums" },
      ],
      errors: {},
      stale: false,
    });
    const router = testRouter();
    const root = await renderHome(testController(loadHome), router);

    expect(loadHome).toHaveBeenCalled();
    expect(root.textContent).toContain("Recent Playlists");
    expect(root.textContent).toContain("Late night");
    expect(root.textContent).toContain("Made for you");
    expect(root.textContent).toContain("Blue hour");
    expect(root.textContent).not.toContain("Unsupported artist");
    expect(root.textContent).toContain("Heavy Rotation");
    expect(root.querySelectorAll(".home-discovery-card")).toHaveLength(3);

    await act(async () => {
      root.querySelector<HTMLElement>(".home-discovery-card")?.click();
    });
    expect(router.navigate).toHaveBeenCalledWith({
      kind: "playlist",
      id: "playlist-1",
      source: "library",
    });
    await act(async () => {
      root
        .querySelector<HTMLElement>('[data-context-source="catalog"]')
        ?.click();
    });
    expect(router.navigate).toHaveBeenCalledWith({
      kind: "album",
      id: "album-1",
      source: "catalog",
    });
    root.remove();
  });

  it("keeps section failures local and exposes refresh action", async () => {
    setInitializationState({ status: "ready" });
    setAuthState({ status: "authorized" });
    setHomeState({
      status: "success",
      recentPlaylists: [],
      recommendations: [],
      heavyRotation: [],
      errors: { heavyRotation: "Heavy Rotation unavailable" },
      stale: true,
    });
    const loadHome = vi.fn(async () => undefined);
    const root = await renderHome(testController(loadHome));

    expect(root.textContent).toContain("Recent Playlists");
    expect(root.textContent).toContain("Heavy Rotation unavailable");
    const retry = Array.from(root.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Try again"),
    );
    await act(async () => {
      retry?.click();
    });
    expect(loadHome).toHaveBeenLastCalledWith({ refresh: true });
    root.remove();
  });

  it("shows recommendation loading and empty error states independently", async () => {
    setInitializationState({ status: "ready" });
    setAuthState({ status: "authorized" });
    setHomeState({
      status: "refreshing",
      recentPlaylists: [],
      recommendations: [],
      heavyRotation: [],
      errors: {},
      stale: false,
    });
    const loadHome = vi.fn(async () => undefined);
    const root = await renderHome(testController(loadHome));
    expect(root.textContent).toContain("Loading…");
    root.remove();

    setHomeState({
      status: "success",
      recentPlaylists: [],
      recommendations: [],
      heavyRotation: [],
      errors: { recommendations: "Recommendations unavailable" },
      stale: true,
    });
    const errorRoot = await renderHome(testController(loadHome));
    expect(errorRoot.textContent).toContain("Recommendations unavailable");
    expect(errorRoot.querySelector('[role="alert"]')).not.toBeNull();
    errorRoot.remove();
  });
});
