import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppController } from "../app/controller.ts";
import { LIBRARY_CACHE_SCOPE, MemoryLibraryCache } from "../library/cache.ts";
import { getState, resetApplicationState } from "../state.ts";
import type { AppleMusicLibraryClient } from "../musickit/library.ts";
import type { LibraryDetailState } from "../state.ts";

function fakeUpdater() {
  return {
    configure: vi.fn(),
    startupCheck: vi.fn(async () => undefined),
    checkNow: vi.fn(async () => undefined),
    dismissPending: vi.fn(),
    installPending: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
}

function fakeMusic(): MusicKit.MusicKitInstance {
  return {
    isAuthorized: true,
    storefrontId: "us",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setQueue: vi.fn().mockResolvedValue(undefined),
    play: vi.fn().mockResolvedValue(undefined),
  } as unknown as MusicKit.MusicKitInstance;
}

function controllerWith(
  client: AppleMusicLibraryClient,
  cache = new MemoryLibraryCache(),
) {
  const updater = fakeUpdater();
  const music = fakeMusic();
  return {
    cache,
    updater,
    music,
    controller: createAppController({
      initializeMusicKit: async () => music,
      createLibraryClient: () => client,
      libraryCache: cache,
      updater: updater as never,
    }),
  };
}

function playlistDetail(id: string): LibraryDetailState {
  const details = getState().library.details.playlist as unknown as Record<
    string,
    LibraryDetailState
  >;
  return details[id];
}

function albumDetail(id: string): LibraryDetailState {
  const details = getState().library.details.album as unknown as Record<
    string,
    LibraryDetailState
  >;
  return details[id];
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => resetApplicationState());

describe("detail stale-while-revalidate", () => {
  it("paints cache instantly then replaces with fresh network data", async () => {
    const cache = new MemoryLibraryCache();
    await cache.writePage(LIBRARY_CACHE_SCOPE, "playlist:p1", {
      items: [
        { id: "p1", name: "Stale Mix" },
        { id: "t-stale", title: "Stale" },
      ],
      updatedAt: 1,
    });
    let resolvePlaylist!: (value: unknown) => void;
    let resolveTracks!: (value: unknown) => void;
    const playlistPromise = new Promise<unknown>((resolve) => {
      resolvePlaylist = resolve;
    });
    const tracksPromise = new Promise<unknown>((resolve) => {
      resolveTracks = resolve;
    });
    const client = {
      getPlaylist: vi.fn(() => playlistPromise),
      getPlaylistTracks: vi.fn(() => tracksPromise),
    } as unknown as AppleMusicLibraryClient;
    const { controller } = controllerWith(client, cache);
    await controller.initialize();

    const pending = controller.loadPlaylist("p1");
    await tick();
    await tick();
    const painted = playlistDetail("p1");
    expect(painted.status).toBe("success");
    expect(painted.source).toBe("cache");
    expect(painted.stale).toBe(true);
    expect(painted.item).toMatchObject({ id: "p1", name: "Stale Mix" });

    resolvePlaylist({ id: "p1", name: "Fresh Mix" });
    resolveTracks([{ id: "t-fresh", title: "Fresh" }]);
    await pending;

    const fresh = playlistDetail("p1");
    expect(fresh.status).toBe("success");
    expect(fresh.source).toBe("network");
    expect(fresh.stale).toBe(false);
    expect(fresh.item).toMatchObject({ id: "p1", name: "Fresh Mix" });
    expect(fresh.tracks).toMatchObject([{ id: "t-fresh" }]);
    controller.dispose();
  });

  it("discards a slow first load when a fast second load wins", async () => {
    let resolveSlowPlaylist!: (value: unknown) => void;
    let resolveSlowTracks!: (value: unknown) => void;
    const slowPlaylist = new Promise<unknown>((resolve) => {
      resolveSlowPlaylist = resolve;
    });
    const slowTracks = new Promise<unknown>((resolve) => {
      resolveSlowTracks = resolve;
    });
    const getPlaylist = vi
      .fn()
      .mockReturnValueOnce(slowPlaylist)
      .mockResolvedValue({ id: "p1", name: "Fast Mix" });
    const getPlaylistTracks = vi
      .fn()
      .mockReturnValueOnce(slowTracks)
      .mockResolvedValue([{ id: "t-fast", title: "Fast" }]);
    const client = {
      getPlaylist,
      getPlaylistTracks,
    } as unknown as AppleMusicLibraryClient;
    const { controller } = controllerWith(client);
    await controller.initialize();

    const first = controller.loadPlaylist("p1");
    const second = controller.loadPlaylist("p1");
    await second;
    const fast = playlistDetail("p1");
    expect(fast.item).toMatchObject({ name: "Fast Mix" });

    resolveSlowPlaylist({ id: "p1", name: "Slow Mix" });
    resolveSlowTracks([{ id: "t-slow", title: "Slow" }]);
    await first;

    const kept = playlistDetail("p1");
    expect(kept.item).toMatchObject({ name: "Fast Mix" });
    expect(kept.tracks).toMatchObject([{ id: "t-fast" }]);
    controller.dispose();
  });

  it("keeps the stale page when background refresh fails", async () => {
    const cache = new MemoryLibraryCache();
    await cache.writePage(LIBRARY_CACHE_SCOPE, "playlist:p1", {
      items: [
        { id: "p1", name: "Stale Mix" },
        { id: "t-stale", title: "Stale" },
      ],
      updatedAt: 1,
    });
    const client = {
      getPlaylist: vi.fn(async () => {
        throw new Error("Apple Music unavailable");
      }),
      getPlaylistTracks: vi.fn(async () => {
        throw new Error("Apple Music unavailable");
      }),
    } as unknown as AppleMusicLibraryClient;
    const { controller } = controllerWith(client, cache);
    await controller.initialize();

    await expect(controller.loadPlaylist("p1")).resolves.toBeUndefined();
    const kept = playlistDetail("p1");
    expect(kept.status).toBe("success");
    expect(kept.source).toBe("cache");
    expect(kept.stale).toBe(true);
    expect(kept.item).toMatchObject({ name: "Stale Mix" });
    expect(kept.error).toContain("Apple Music unavailable");
    controller.dispose();
  });

  it("shows loading for explicit refresh even with cache", async () => {
    const cache = new MemoryLibraryCache();
    await cache.writePage(LIBRARY_CACHE_SCOPE, "playlist:p1", {
      items: [
        { id: "p1", name: "Stale Mix" },
        { id: "t-stale", title: "Stale" },
      ],
      updatedAt: 1,
    });
    let resolvePlaylist!: (value: unknown) => void;
    let resolveTracks!: (value: unknown) => void;
    const playlistPromise = new Promise<unknown>((resolve) => {
      resolvePlaylist = resolve;
    });
    const tracksPromise = new Promise<unknown>((resolve) => {
      resolveTracks = resolve;
    });
    const client = {
      getPlaylist: vi.fn(() => playlistPromise),
      getPlaylistTracks: vi.fn(() => tracksPromise),
    } as unknown as AppleMusicLibraryClient;
    const { controller } = controllerWith(client, cache);
    await controller.initialize();

    const pending = controller.loadPlaylist("p1", "library", {
      refresh: true,
    });
    const loading = playlistDetail("p1");
    expect(loading.status).toBe("loading");

    resolvePlaylist({ id: "p1", name: "Fresh Mix" });
    resolveTracks([{ id: "t-fresh", title: "Fresh" }]);
    await pending;
    const fresh = playlistDetail("p1");
    expect(fresh.source).toBe("network");
    expect(fresh.stale).toBe(false);
    controller.dispose();
  });

  it("applies stale-while-revalidate to album details", async () => {
    const cache = new MemoryLibraryCache();
    await cache.writePage(LIBRARY_CACHE_SCOPE, "album:a1", {
      items: [
        { id: "a1", name: "Stale Album" },
        { id: "t-stale", title: "Stale" },
      ],
      updatedAt: 1,
    });
    let resolveAlbum!: (value: unknown) => void;
    const albumPromise = new Promise<unknown>((resolve) => {
      resolveAlbum = resolve;
    });
    const client = {
      getAlbum: vi.fn(() => albumPromise),
    } as unknown as AppleMusicLibraryClient;
    const { controller } = controllerWith(client, cache);
    await controller.initialize();

    const pending = controller.loadAlbum("a1");
    await tick();
    await tick();
    const painted = albumDetail("a1");
    expect(painted.status).toBe("success");
    expect(painted.source).toBe("cache");
    expect(painted.stale).toBe(true);

    resolveAlbum({
      id: "a1",
      name: "Fresh Album",
      tracks: [{ id: "t-fresh", title: "Fresh" }],
    });
    await pending;
    const fresh = albumDetail("a1");
    expect(fresh.source).toBe("network");
    expect(fresh.stale).toBe(false);
    expect(fresh.item).toMatchObject({ id: "a1" });
    controller.dispose();
  });
});
