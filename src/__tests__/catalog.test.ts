import { describe, expect, it, vi } from "vitest";
import {
  resolveMusicKitMusicRequest,
  resolveStorefront,
  loadBrowseCharts,
  loadRadioStations,
  searchMusicResources,
  searchCatalogSongs,
  stationsFromResponse,
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

describe("discovery resources", () => {
  it("normalizes grouped catalog search results", async () => {
    const music = vi.fn().mockResolvedValue({
      data: {
        results: {
          songs: {
            data: [
              {
                id: "song-1",
                type: "songs",
                attributes: { name: "Song", artistName: "Artist" },
              },
            ],
          },
          albums: {
            data: [
              {
                id: "album-1",
                type: "albums",
                attributes: { name: "Album", artistName: "Artist" },
              },
            ],
          },
          artists: {
            data: [
              {
                id: "artist-1",
                type: "artists",
                attributes: { name: "Artist" },
              },
            ],
          },
          playlists: {
            data: [
              {
                id: "playlist-1",
                type: "playlists",
                attributes: { name: "Mix" },
              },
            ],
          },
        },
      },
    });
    const result = await searchMusicResources(
      instanceWithMusic(music),
      "hello",
      "catalog",
    );
    expect(result.songs[0]?.title).toBe("Song");
    expect(result.albums[0]?.title).toBe("Album");
    expect(result.artists[0]?.name).toBe("Artist");
    expect(result.playlists[0]?.name).toBe("Mix");
    expect(music).toHaveBeenCalledWith("/v1/catalog/us/search", {
      term: "hello",
      types: "songs,albums,artists,playlists",
      limit: 10,
    });
  });

  it("loads chart groups and stations from documented paths", async () => {
    const music = vi.fn(async (path: string) => {
      if (path.endsWith("/charts")) {
        return {
          data: {
            results: {
              songs: [
                {
                  chart: "most-played",
                  name: "Top Songs",
                  href: "https://api.music.apple.com/v1/catalog/us/charts",
                  data: [
                    {
                      id: "song-1",
                      type: "songs",
                      attributes: { name: "Song", artistName: "Artist" },
                    },
                  ],
                },
              ],
              albums: [
                {
                  chart: "most-played",
                  data: [
                    {
                      id: "album-1",
                      type: "albums",
                      attributes: { name: "Album", artistName: "Artist" },
                    },
                  ],
                },
              ],
              playlists: [
                {
                  chart: "most-played",
                  data: [
                    {
                      id: "playlist-1",
                      type: "playlists",
                      attributes: { name: "Mix" },
                    },
                  ],
                },
              ],
            },
          },
        };
      }
      return {
        data: [
          {
            id: "station-1",
            type: "stations",
            attributes: {
              name: "My Station",
              url: "https://music.apple.com/us/station/my",
            },
          },
        ],
      };
    });
    await expect(
      loadBrowseCharts(instanceWithMusic(music)),
    ).resolves.toMatchObject({
      songs: [{ id: "song-1", title: "Song" }],
      albums: [{ id: "album-1", title: "Album" }],
      playlists: [{ id: "playlist-1", name: "Mix" }],
    });
    expect(music).toHaveBeenCalledWith("/v1/catalog/us/charts", {
      chart: "most-played",
      types: "songs,albums,playlists",
      limit: 20,
    });
    await expect(
      loadRadioStations(instanceWithMusic(music), "personal"),
    ).resolves.toMatchObject([{ id: "station-1", name: "My Station" }]);
    expect(stationsFromResponse({ data: [{ id: "bad" }] })).toEqual([]);
    expect(music).toHaveBeenCalledWith("/v1/catalog/us/stations", {
      "filter[identity]": "personal",
      limit: 10,
    });
  });

  it("normalizes single chart objects per type", async () => {
    const music = vi.fn().mockResolvedValue({
      data: {
        results: {
          songs: {
            chart: "most-played",
            data: [
              {
                id: "song-1",
                type: "songs",
                attributes: { name: "Song", artistName: "Artist" },
              },
            ],
          },
          albums: {
            chart: "most-played",
            data: [
              {
                id: "album-1",
                type: "albums",
                attributes: { name: "Album", artistName: "Artist" },
              },
            ],
          },
          playlists: {
            chart: "most-played",
            data: [
              {
                id: "playlist-1",
                type: "playlists",
                attributes: { name: "Mix" },
              },
            ],
          },
        },
      },
    });
    await expect(
      loadBrowseCharts(instanceWithMusic(music)),
    ).resolves.toMatchObject({
      songs: [{ id: "song-1", title: "Song" }],
      albums: [{ id: "album-1", title: "Album" }],
      playlists: [{ id: "playlist-1", name: "Mix" }],
    });
  });

  it("honors the station isLive attribute without losing live forcing", async () => {
    expect(
      stationsFromResponse({
        data: [
          {
            id: "station-live",
            type: "stations",
            attributes: { name: "Live", isLive: true },
          },
          {
            id: "station-recorded",
            type: "stations",
            attributes: { name: "Recorded", isLive: false },
          },
          {
            id: "station-unknown",
            type: "stations",
            attributes: { name: "Unknown" },
          },
        ],
      }),
    ).toMatchObject([
      { id: "station-live", isLive: true },
      { id: "station-recorded", isLive: false },
      { id: "station-unknown", isLive: false },
    ]);
    const music = vi.fn().mockResolvedValue({
      data: [
        {
          id: "station-1",
          type: "stations",
          attributes: { name: "Live Radio", isLive: false },
        },
      ],
    });
    await expect(
      loadRadioStations(instanceWithMusic(music), "live"),
    ).resolves.toMatchObject([{ id: "station-1", isLive: true }]);
    expect(music).toHaveBeenCalledWith("/v1/catalog/us/stations", {
      "filter[featured]": "apple-music-live-radio",
      limit: 25,
    });
  });
});
