import { describe, expect, it } from "vitest";
import { MemoryLibraryCache } from "../library/cache.ts";

describe("library metadata cache", () => {
  it("keeps opaque page cursors and rehydrates loaded pages", async () => {
    const cache = new MemoryLibraryCache();
    const cursor =
      "https://api.music.apple.com/v1/me/library/songs?offset=50&x=a%2Fb";
    await cache.writePage("scope", "songs", {
      items: [{ id: "song-1", title: "One" }],
      next: cursor,
      updatedAt: 10,
    });
    await cache.writePage("scope", "songs", {
      cursor,
      items: [{ id: "song-2", title: "Two" }],
      updatedAt: 20,
    });

    await expect(cache.readPage("scope", "songs", cursor)).resolves.toEqual({
      cursor,
      items: [{ id: "song-2", title: "Two" }],
      next: undefined,
      updatedAt: 20,
    });
    await expect(cache.readSection("scope", "songs")).resolves.toMatchObject({
      items: [{ id: "song-1" }, { id: "song-2" }],
      next: undefined,
      updatedAt: 20,
    });
  });

  it("clears one section without touching another account scope", async () => {
    const cache = new MemoryLibraryCache();
    await cache.writePage("a", "songs", {
      items: [{ id: "a-song" }],
      updatedAt: 1,
    });
    await cache.writePage("a", "albums", {
      items: [{ id: "a-album" }],
      updatedAt: 1,
    });
    await cache.writePage("b", "songs", {
      items: [{ id: "b-song" }],
      updatedAt: 1,
    });

    await cache.clearSection("a", "songs");
    await expect(cache.readSection("a", "songs")).resolves.toBeUndefined();
    await expect(cache.readSection("a", "albums")).resolves.toBeDefined();
    await expect(cache.readSection("b", "songs")).resolves.toBeDefined();
  });
});
