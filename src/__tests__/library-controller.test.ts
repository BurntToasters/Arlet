import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppController } from "../app/controller.ts";
import { MemoryLibraryCache } from "../library/cache.ts";
import { getState, resetApplicationState } from "../state.ts";
import type { AppleMusicLibraryClient } from "../musickit/library.ts";

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

beforeEach(() => resetApplicationState());

describe("library controller", () => {
  it("loads pages, follows opaque cursors, and appends without duplicates", async () => {
    const getSongs = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ id: "song-1", title: "One" }],
        next: "opaque://next?offset=a%2Fb",
      })
      .mockResolvedValueOnce({ items: [{ id: "song-1" }, { id: "song-2" }] });
    const client = { getSongs } as unknown as AppleMusicLibraryClient;
    const { controller } = controllerWith(client);
    await controller.initialize();

    await controller.loadLibrarySection("songs");
    await controller.loadMoreLibrarySection("songs");

    expect(getSongs).toHaveBeenNthCalledWith(1, undefined);
    expect(getSongs).toHaveBeenNthCalledWith(2, "opaque://next?offset=a%2Fb");
    expect(
      getState().library.collections.songs.items.map((item) => item.id),
    ).toEqual(["song-1", "song-2"]);
    expect(getState().library.collections.songs.source).toBe("network");
    controller.dispose();
  });

  it("keeps cached items and marks them stale when refresh fails", async () => {
    const getSongs = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: "song-1", title: "One" }] })
      .mockRejectedValueOnce(new Error("Apple Music unavailable"));
    const client = { getSongs } as unknown as AppleMusicLibraryClient;
    const { controller } = controllerWith(client);
    await controller.initialize();

    await controller.loadLibrarySection("songs");
    await controller.refreshLibrarySection("songs");

    const collection = getState().library.collections.songs;
    expect(collection.items).toHaveLength(1);
    expect(collection.source).toBe("network");
    expect(collection.stale).toBe(true);
    expect(collection.error).toContain("Apple Music unavailable");
    controller.dispose();
  });

  it("queues library tracks through catalog identifiers", async () => {
    const client = {} as AppleMusicLibraryClient;
    const { controller, music } = controllerWith(client);
    await controller.initialize();

    await controller.playTracks([
      {
        id: "i.library-song",
        title: "Uploaded song",
        artistName: "Artist",
        resourceType: "library-songs",
      },
      {
        id: "i.library-match",
        title: "Matched song",
        artistName: "Artist",
        resourceType: "library-songs",
        catalogId: "catalog-song",
      },
    ]);

    expect(music.setQueue).toHaveBeenCalledWith({
      songs: ["i.library-song", "catalog-song"],
    });
    expect(music.play).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("flattens the loaded playlist folder tree for hierarchy rendering", async () => {
    const client = {
      getRootPlaylistFolder: vi.fn(async () => ({
        id: "root",
        name: "Playlists",
        resourceType: "library-playlist-folders",
        children: [
          {
            id: "folder-1",
            name: "Favorites",
            resourceType: "library-playlist-folders",
            children: [
              {
                id: "playlist-1",
                name: "Mix",
                resourceType: "library-playlists",
              },
            ],
          },
        ],
      })),
    } as unknown as AppleMusicLibraryClient;
    const { controller } = controllerWith(client);
    await controller.initialize();

    await controller.loadPlaylistFolder();

    expect(getState().library.details.playlistFolder.items).toMatchObject([
      { id: "folder-1", parentId: "root" },
      { id: "playlist-1", parentId: "folder-1" },
    ]);
    controller.dispose();
  });
});
