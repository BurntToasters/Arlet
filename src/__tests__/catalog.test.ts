import { describe, expect, it, vi } from "vitest";
import {
  resolveMusicKitMusicRequest,
  resolveStorefront,
  searchCatalogSongs,
  songsFromSearchResponse,
  storefrontFromMeResponse,
} from "../musickit/catalog.ts";

function instanceWithMusic(
  music: (path: string, query?: Record<string, unknown>) => Promise<unknown>,
  storefrontId = "us",
): MusicKit.MusicKitInstance {
  return {
    storefrontId,
    api: { music },
  } as unknown as MusicKit.MusicKitInstance;
}

describe("resolveMusicKitMusicRequest", () => {
  it("uses api.music on MusicKit v3", () => {
    const music = vi.fn();
    const request = resolveMusicKitMusicRequest(instanceWithMusic(music));
    void request("/v1/catalog/us/search");
    expect(music).toHaveBeenCalledWith("/v1/catalog/us/search");
  });

  it("falls back to api.v3.music", () => {
    const music = vi.fn();
    const request = resolveMusicKitMusicRequest({
      api: { v3: { music } },
    } as unknown as MusicKit.MusicKitInstance);
    void request("/v1/me/storefront");
    expect(music).toHaveBeenCalledWith("/v1/me/storefront");
  });

  it("fails closed when the v3 catalog API is missing", () => {
    expect(() =>
      resolveMusicKitMusicRequest({
        api: {},
      } as unknown as MusicKit.MusicKitInstance),
    ).toThrow("MusicKit v3 catalog API is not available.");
  });
});

describe("search response unwrapping", () => {
  it("reads songs from the v3 data.results envelope", () => {
    const songs = songsFromSearchResponse({
      data: {
        results: {
          songs: {
            data: [{ id: "1", attributes: { name: "Hello" } }],
          },
        },
      },
    });
    expect(songs).toEqual([{ id: "1", attributes: { name: "Hello" } }]);
  });

  it("reads a me/storefront id", () => {
    expect(storefrontFromMeResponse({ data: [{ id: "gb" }] })).toBe("gb");
  });
});

describe("searchCatalogSongs", () => {
  it("calls the catalog search path for the instance storefront", async () => {
    const music = vi.fn().mockResolvedValue({
      data: {
        results: {
          songs: {
            data: [
              {
                id: "song-1",
                attributes: {
                  name: "Hello",
                  artistName: "Adele",
                  albumName: "25",
                  durationInMillis: 295000,
                },
              },
            ],
          },
        },
      },
    });
    const tracks = await searchCatalogSongs(
      instanceWithMusic(music, "gb"),
      "hello",
      { limit: 25 },
    );
    expect(music).toHaveBeenCalledWith("/v1/catalog/gb/search", {
      term: "hello",
      types: "songs",
      limit: 25,
    });
    expect(tracks).toEqual([
      {
        id: "song-1",
        title: "Hello",
        artistName: "Adele",
        albumTitle: "25",
        artwork: undefined,
        durationMs: 295000,
      },
    ]);
  });

  it("loads storefront from /v1/me/storefront when missing", async () => {
    const music = vi.fn(async (path: string) => {
      if (path === "/v1/me/storefront") return { data: [{ id: "jp" }] };
      return { data: { results: { songs: { data: [] } } } };
    });
    await searchCatalogSongs(instanceWithMusic(music, ""), "hello");
    expect(music).toHaveBeenCalledWith("/v1/me/storefront");
    expect(music).toHaveBeenCalledWith("/v1/catalog/jp/search", {
      term: "hello",
      types: "songs",
      limit: 25,
    });
  });
});

describe("resolveStorefront", () => {
  it("throws when storefront cannot be resolved", async () => {
    const music = vi.fn().mockResolvedValue({ data: [] });
    await expect(
      resolveStorefront(instanceWithMusic(music, "")),
    ).rejects.toThrow("MusicKit storefront is not available");
  });
});
