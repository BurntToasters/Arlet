import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppController } from "../app/controller.ts";
import { LIBRARY_CACHE_SCOPE, MemoryLibraryCache } from "../library/cache.ts";
import { getState, resetApplicationState } from "../state.ts";

// Failure modes: offline, MusicKit (loaded from Apple's CDN) never starts,
// so every library call fails and the user sees a sign-in prompt although
// the cache holds their library; a machine that never signed in claims an
// offline library; offline reads try the network.
async function seededCache(withMeta: boolean): Promise<MemoryLibraryCache> {
  const cache = new MemoryLibraryCache();
  await cache.writePage(LIBRARY_CACHE_SCOPE, "songs", {
    items: [{ id: "s1", title: "Cached song" }],
    updatedAt: 5,
  });
  await cache.writePage(LIBRARY_CACHE_SCOPE, "playlist:p1", {
    items: [
      { id: "p1", name: "Mix" },
      { id: "t1", title: "Track" },
    ],
    updatedAt: 6,
  });
  if (withMeta) {
    await cache.setMeta({
      scope: LIBRARY_CACHE_SCOPE,
      storefront: "us",
      lastRefreshAt: 5,
    });
  }
  return cache;
}

function offlineController(cache: MemoryLibraryCache) {
  const createLibraryClient = vi.fn();
  const controller = createAppController({
    initializeMusicKit: () =>
      Promise.reject(new Error("MusicKit JS did not load within timeout")),
    libraryCache: cache,
    createLibraryClient,
    invokeFn: (async () => undefined) as never,
  });
  return { controller, createLibraryClient };
}

describe("offline cached library", () => {
  beforeEach(() => resetApplicationState());

  it("serves the cached library when MusicKit cannot start", async () => {
    const { controller, createLibraryClient } = offlineController(
      await seededCache(true),
    );
    await controller.initialize();
    expect(getState().initialization.status).toBe("error");
    expect(getState().library.offline).toBe(true);

    await controller.loadLibrarySection("songs");
    const songs = getState().library.collections.songs;
    expect(songs.items.map((item) => item.id)).toEqual(["s1"]);
    expect(songs.source).toBe("cache");

    await controller.loadPlaylist("p1");
    const detail = getState().library.details.playlist["p1"] as {
      item?: { id: string };
      items?: Array<{ id: string }>;
    };
    expect(detail.item?.id).toBe("p1");
    expect(detail.items?.map((item) => item.id)).toEqual(["t1"]);
    expect(createLibraryClient).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("does not claim an offline library for a machine never signed in", async () => {
    const { controller } = offlineController(await seededCache(false));
    await controller.initialize();
    expect(getState().library.offline).toBe(false);
    await expect(controller.loadLibrarySection("songs")).rejects.toThrow(
      /MusicKit/u,
    );
    controller.dispose();
  });
});
