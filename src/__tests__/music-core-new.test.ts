import { describe, expect, it, vi } from "vitest";
import {
  createAppleMusicLibraryClient,
  normalizeRecommendationGroups,
} from "../musickit/library.ts";
import { parseRoute, serializeRoute } from "../routing/router.ts";
import { createAppController } from "../app/controller.ts";
import { getState, resetApplicationState } from "../state.ts";
import { registerMusicKitEvents } from "../musickit/events.ts";

function song(id: string, type = "songs") {
  return { id, type, attributes: { name: id, artistName: "Artist" } };
}

describe("music discovery and source routing", () => {
  it("loads home endpoints with documented paths and limits", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: "p", type: "playlists", attributes: { name: "Mix" } }],
      })
      .mockResolvedValueOnce({
        data: [{ id: "a", type: "albums", attributes: { name: "Album" } }],
      })
      .mockResolvedValueOnce({ data: [] });
    const client = createAppleMusicLibraryClient({
      storefrontId: "us",
      api: { music: request },
    } as unknown as MusicKit.MusicKitInstance);
    await client.getRecentlyPlayedPlaylists();
    await client.getHeavyRotation();
    await client.getRecommendations();
    expect(request).toHaveBeenNthCalledWith(1, "/v1/me/recent/played", {
      types: "playlists,library-playlists",
      limit: 10,
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/v1/me/history/heavy-rotation",
      {
        limit: 10,
      },
    );
    expect(request).toHaveBeenNthCalledWith(3, "/v1/me/recommendations");
  });

  it("normalizes recommendation content and ignores unsupported resources", () => {
    const groups = normalizeRecommendationGroups({
      data: [
        {
          id: "rec",
          type: "personal-recommendation",
          attributes: {
            title: { stringForDisplay: "Made for you" },
            reason: { stringForDisplay: "Because you listened" },
          },
          relationships: {
            contents: {
              data: [
                { id: "album", type: "albums" },
                { id: "artist", type: "artists" },
              ],
            },
          },
        },
      ],
      included: [
        { id: "album", type: "albums", attributes: { name: "Blue" } },
        { id: "artist", type: "artists", attributes: { name: "Nope" } },
      ],
    });
    expect(groups).toMatchObject([
      {
        id: "rec",
        title: "Made for you",
        reason: "Because you listened",
        items: [{ id: "album", title: "Blue" }],
      },
    ]);
  });

  it("keeps old detail hashes library-backed and serializes catalog source", () => {
    expect(parseRoute("#/album/a")).toEqual({ kind: "album", id: "a" });
    const route = {
      kind: "playlist" as const,
      id: "p",
      source: "catalog" as const,
    };
    expect(parseRoute(serializeRoute(route))).toEqual(route);
  });

  it("loads home sections independently and caches successful session data", async () => {
    resetApplicationState();
    const recent = vi.fn(async () => ({
      items: [{ id: "p", name: "Mix", resourceType: "library-playlists" }],
    }));
    const heavy = vi.fn(async () => {
      throw new Error("Heavy rotation unavailable");
    });
    const recommendations = vi.fn(async () => []);
    const music = {
      isAuthorized: true,
      storefrontId: "us",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MusicKit.MusicKitInstance;
    const controller = createAppController({
      initializeMusicKit: async () => music,
      createLibraryClient: () =>
        ({
          getRecentlyPlayedPlaylists: recent,
          getHeavyRotation: heavy,
          getRecommendations: recommendations,
        }) as never,
      updater: {
        configure: vi.fn(),
        startupCheck: vi.fn(async () => undefined),
        checkNow: vi.fn(async () => undefined),
        dismissPending: vi.fn(),
        installPending: vi.fn(async () => undefined),
        dispose: vi.fn(),
      } as never,
    });
    await controller.initialize();
    await controller.loadHome?.();
    expect(getState().home.status).toBe("success");
    expect(getState().home.errors.heavyRotation).toContain("unavailable");
    expect(getState().home.recentPlaylists[0]?.id).toBe("p");
    await controller.loadHome?.();
    expect(recent).toHaveBeenCalledOnce();
    controller.dispose();
  });
});

describe("queue resource helper", () => {
  it("keeps duplicate queue positions from provider snapshots", async () => {
    const { syncMusicKitQueue } = await import("../musickit/player.ts");
    resetApplicationState();
    syncMusicKitQueue({
      queue: {
        items: [song("same"), song("same")],
        currentItemIndex: 1,
      },
    } as unknown as MusicKit.MusicKitInstance);
    expect(getState().playback.queueIndex).toBe(1);
  });

  it("reads the live queue and position from MusicKit's nested player", async () => {
    const { readMusicKitQueue, syncMusicKitQueue } =
      await import("../musickit/player.ts");
    resetApplicationState();
    const first = song("same");
    const second = song("same");
    const instance = {
      player: {
        queue: { items: [first, second], position: 1 },
        nowPlayingItemIndex: 1,
      },
    } as unknown as MusicKit.MusicKitInstance;
    expect(readMusicKitQueue(instance)).toMatchObject({
      items: [first, second],
      index: 1,
    });
    expect(syncMusicKitQueue(instance)).toBe(true);
    expect(getState().playback.queueIndex).toBe(1);
  });

  it("registers and handles queueItemsDidChange", async () => {
    resetApplicationState();
    const listeners = new Map<
      string,
      (event: Record<string, unknown>) => void
    >();
    const instance = {
      player: {
        queue: { items: [song("a"), song("b")], position: 1 },
      },
      addEventListener: vi.fn(
        (name: string, callback: (event: Record<string, unknown>) => void) => {
          listeners.set(name, callback);
        },
      ),
      removeEventListener: vi.fn(),
    } as unknown as MusicKit.MusicKitInstance;
    const onQueueChange = vi.fn();
    const stop = registerMusicKitEvents(
      instance,
      undefined,
      undefined,
      onQueueChange,
    );
    listeners.get(MusicKit.Events.queueItemsDidChange)?.({});
    expect(getState().playback.queue.map((track) => track.id)).toEqual([
      "a",
      "b",
    ]);
    expect(getState().playback.queueIndex).toBe(1);
    expect(onQueueChange).toHaveBeenCalledOnce();
    stop();
  });

  it("falls back to deterministic insertion when provider hides queue", async () => {
    resetApplicationState();
    const music = {
      isAuthorized: true,
      storefrontId: "us",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setQueue: vi.fn().mockResolvedValue(undefined),
      play: vi.fn().mockResolvedValue(undefined),
      playNext: vi.fn().mockResolvedValue(undefined),
      playLater: vi.fn().mockResolvedValue(undefined),
    } as unknown as MusicKit.MusicKitInstance;
    const controller = createAppController({
      initializeMusicKit: async () => music,
      createLibraryClient: () => ({}) as never,
      updater: {
        configure: vi.fn(),
        startupCheck: vi.fn(async () => undefined),
        checkNow: vi.fn(async () => undefined),
        dismissPending: vi.fn(),
        installPending: vi.fn(async () => undefined),
        dispose: vi.fn(),
      } as never,
    });
    await controller.initialize();
    const a = { id: "a", title: "A", artistName: "Artist" };
    const b = { id: "b", title: "B", artistName: "Artist" };
    const c = { id: "c", title: "C", artistName: "Artist" };
    await controller.playTracks([a, b]);
    await controller.playNextTracks([c]);
    expect(getState().playback.queue.map((track) => track.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
    await controller.playQueueItem?.(2);
    expect(music.setQueue).toHaveBeenLastCalledWith({ songs: ["b"] });
    controller.dispose();
  });

  it("does not discard a local insertion when the readable provider queue is stale", async () => {
    resetApplicationState();
    const { syncMusicKitQueue } = await import("../musickit/player.ts");
    const media = (id: string) => ({
      id,
      title: id.toUpperCase(),
      artistName: "Artist",
      albumName: "Album",
      artworkURL: "",
      playbackDuration: 0,
    });
    const music = {
      isAuthorized: true,
      storefrontId: "us",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setQueue: vi.fn().mockResolvedValue(undefined),
      play: vi.fn().mockResolvedValue(undefined),
      playNext: vi.fn().mockResolvedValue(undefined),
      playLater: vi.fn().mockResolvedValue(undefined),
      player: {
        queue: {
          items: [media("a"), media("b"), media("c")],
          position: 1,
        },
      },
    } as unknown as MusicKit.MusicKitInstance;
    const controller = createAppController({
      initializeMusicKit: async () => music,
      createLibraryClient: () => ({}) as never,
      updater: {
        configure: vi.fn(),
        startupCheck: vi.fn(async () => undefined),
        checkNow: vi.fn(async () => undefined),
        dismissPending: vi.fn(),
        installPending: vi.fn(async () => undefined),
        dispose: vi.fn(),
      } as never,
    });
    await controller.initialize();
    const a = { id: "a", title: "A", artistName: "Artist" };
    const b = { id: "b", title: "B", artistName: "Artist" };
    const c = { id: "c", title: "C", artistName: "Artist" };
    const d = { id: "d", title: "D", artistName: "Artist" };
    const e = { id: "e", title: "E", artistName: "Artist" };
    await controller.playTracks([a, b, c]);
    // Capture a middle queue position before the provider acknowledges a
    // mutation while still exposing its stale queue snapshot.
    syncMusicKitQueue(music);
    await controller.playNextTracks([d]);
    expect(getState().playback.queue.map((track) => track.id)).toEqual([
      "a",
      "b",
      "d",
      "c",
    ]);
    await controller.playLaterTracks([e]);
    expect(getState().playback.queue.map((track) => track.id)).toEqual([
      "a",
      "b",
      "d",
      "c",
      "e",
    ]);
    controller.dispose();
  });
});
