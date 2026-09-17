import { describe, expect, it, vi } from "vitest";
import {
  createAppleMusicLibraryClient,
  type AppleMusicLibraryClient,
} from "../musickit/library.ts";
import {
  normalizeAlbumResource,
  normalizeArtistResource,
  normalizeLibraryItems,
  normalizeMusicResourceRef,
  normalizePlaylistFolderResource,
  normalizePlaylistResource,
  normalizeTrackResource,
} from "../musickit/normalize.ts";

type MusicRequest = (
  path: string,
  query?: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<unknown>;

function clientWithRequest(request: MusicRequest): {
  client: AppleMusicLibraryClient;
  request: ReturnType<typeof vi.fn>;
} {
  const music = vi.fn(request);
  const client = createAppleMusicLibraryClient({
    storefrontId: "us",
    api: { music },
  } as unknown as MusicKit.MusicKitInstance);
  return { client, request: music };
}

function song(id = "song-1", type = "library-songs") {
  return {
    id,
    type,
    href: `/v1/me/library/songs/${id}`,
    attributes: {
      name: "Song",
      artistName: "Artist",
      albumName: "Album",
      durationInMillis: 123000,
      artwork: { url: "https://example.com/{w}x{h}.jpg" },
      playParams: { id: "catalog-song-1", kind: "song" },
    },
    relationships: {
      catalog: { data: [{ id: "catalog-song-1", type: "songs" }] },
    },
  };
}

describe("Apple Music resource normalization", () => {
  it("normalizes library resources with safe playback metadata", () => {
    expect(normalizeTrackResource(song())).toMatchObject({
      id: "song-1",
      title: "Song",
      artistName: "Artist",
      resourceType: "library-songs",
      catalogId: "catalog-song-1",
      playable: true,
      addable: true,
      artwork: {
        url: "https://example.com/300x300.jpg",
        width: 300,
        height: 300,
      },
    });
  });

  it("normalizes artist, album, playlist, and folder descriptors", () => {
    expect(
      normalizeArtistResource({
        id: "artist-1",
        type: "library-artists",
        attributes: { name: "Artist", albumCount: 4 },
      }),
    ).toMatchObject({ id: "artist-1", name: "Artist", albumCount: 4 });
    expect(
      normalizeAlbumResource({
        id: "album-1",
        type: "library-albums",
        attributes: { name: "Album", artistName: "Artist", trackCount: 8 },
      }),
    ).toMatchObject({ id: "album-1", title: "Album", trackCount: 8 });
    expect(
      normalizePlaylistResource({
        id: "playlist-1",
        type: "library-playlists",
        attributes: {
          name: "Mix",
          description: { standard: "Description" },
          canEdit: true,
          isPublic: false,
        },
      }),
    ).toMatchObject({
      id: "playlist-1",
      name: "Mix",
      description: "Description",
      canEdit: true,
      isPublic: false,
    });
    expect(
      normalizePlaylistFolderResource({
        id: "folder-1",
        type: "library-playlist-folders",
        attributes: { name: "Folder" },
      }),
    ).toMatchObject({ id: "folder-1", name: "Folder" });
  });

  it("skips malformed and unknown resources in mixed collections", () => {
    expect(
      normalizeLibraryItems([
        song(),
        { id: "unsupported", type: "stations", attributes: { name: "Radio" } },
        { type: "library-songs", attributes: { name: "No id" } },
        null,
      ]),
    ).toHaveLength(1);
    expect(normalizeMusicResourceRef({ id: "1", type: "songs" })).toEqual({
      id: "1",
      type: "songs",
    });
    expect(
      normalizeMusicResourceRef({ id: "1", type: "albums" }),
    ).toBeUndefined();
  });
});

describe("AppleMusicLibraryClient", () => {
  it("uses documented library endpoint and follows Apple next path verbatim", async () => {
    const next = "/v1/me/library/songs?offset=opaque%2Ftoken";
    const { client, request } = clientWithRequest(
      vi
        .fn<MusicRequest>()
        .mockResolvedValueOnce({ data: [song()], meta: { total: 17 }, next })
        .mockResolvedValueOnce({ data: [song("song-2")] }),
    );
    const first = await client.getSongs();
    expect(request).toHaveBeenNthCalledWith(1, "/v1/me/library/songs");
    expect(first.next).toBe(next);
    expect(first.total).toBe(17);
    await client.getSongs(next);
    expect(request).toHaveBeenNthCalledWith(2, next);
  });

  it("unwraps direct arrays and nested search result envelopes", async () => {
    const { client, request } = clientWithRequest(
      vi
        .fn<MusicRequest>()
        .mockResolvedValueOnce([song()])
        .mockResolvedValueOnce({
          data: {
            results: {
              playlists: {
                data: [
                  { id: "p-1", type: "playlists", attributes: { name: "Mix" } },
                ],
              },
            },
          },
        }),
    );
    expect((await client.getSongs()).items).toHaveLength(1);
    const result = await client.searchPlaylists("  mix ");
    expect(request).toHaveBeenNthCalledWith(2, "/v1/me/library/search", {
      term: "mix",
      types: "library-playlists",
    });
    expect(result.items[0]).toMatchObject({ id: "p-1", name: "Mix" });
  });

  it("uses documented recent, root-folder, detail, and playlist-track paths", async () => {
    const { client, request } = clientWithRequest(
      vi.fn<MusicRequest>().mockResolvedValue({ data: [song()] }),
    );
    await client.getAlbums();
    await client.getArtists();
    await client.getPlaylists();
    await client.getRecentlyAdded();
    await client.getRecentlyPlayedTracks();
    await client.getAlbum("album-1");
    await client.getArtist("artist-1");
    await client.getPlaylist("playlist-1");
    await client.getPlaylistTracks("playlist-1");
    await client.getRootPlaylistFolder();
    await client.getPlaylistFolder("folder-1");
    expect(request).toHaveBeenNthCalledWith(1, "/v1/me/library/albums");
    expect(request).toHaveBeenNthCalledWith(2, "/v1/me/library/artists");
    expect(request).toHaveBeenNthCalledWith(3, "/v1/me/library/playlists");
    expect(request).toHaveBeenNthCalledWith(4, "/v1/me/library/recently-added");
    expect(request).toHaveBeenNthCalledWith(5, "/v1/me/recent/played/tracks", {
      types: "library-music-videos,library-songs,music-videos,songs",
    });
    expect(request).toHaveBeenNthCalledWith(6, "/v1/me/library/albums/album-1");
    expect(request).toHaveBeenNthCalledWith(
      7,
      "/v1/me/library/artists/artist-1",
    );
    expect(request).toHaveBeenNthCalledWith(
      8,
      "/v1/me/library/playlists/playlist-1",
    );
    expect(request).toHaveBeenNthCalledWith(
      9,
      "/v1/me/library/playlists/playlist-1/tracks",
    );
    expect(request).toHaveBeenNthCalledWith(
      10,
      "/v1/me/library/playlist-folders",
      {
        "filter[identity]": "playlistsroot",
        limit: 1,
      },
    );
    expect(request).toHaveBeenNthCalledWith(
      11,
      "/v1/me/library/playlist-folders/folder-1",
    );
  });

  it("hydrates nested playlist folders from their children relationships", async () => {
    const root = {
      id: "p.playlistsroot",
      type: "library-playlist-folders",
      attributes: { name: "Playlists" },
    };
    const folder = {
      id: "folder-1",
      type: "library-playlist-folders",
      attributes: { name: "Favorites" },
    };
    const playlist = {
      id: "playlist-1",
      type: "library-playlists",
      attributes: { name: "Daily mix" },
    };
    const nested = {
      id: "playlist-2",
      type: "library-playlists",
      attributes: { name: "Deep cuts" },
    };
    const { client, request } = clientWithRequest(
      vi
        .fn<MusicRequest>()
        .mockResolvedValueOnce({
          data: [],
          meta: { filters: { identity: { playlistsroot: [root] } } },
        })
        .mockResolvedValueOnce({ data: [folder, playlist] })
        .mockResolvedValueOnce({ data: [nested] }),
    );

    const result = await client.getRootPlaylistFolder();

    expect(request).toHaveBeenNthCalledWith(
      2,
      "/v1/me/library/playlist-folders/p.playlistsroot/children",
      { limit: 100 },
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "/v1/me/library/playlist-folders/folder-1/children",
      { limit: 100 },
    );
    expect(result).toMatchObject({
      id: "p.playlistsroot",
      children: [
        {
          id: "folder-1",
          parentId: "p.playlistsroot",
          children: [{ id: "playlist-2", parentId: "folder-1" }],
        },
        { id: "playlist-1", parentId: "p.playlistsroot" },
      ],
    });
  });

  it("sends documented JSON POST bodies and accepts 204 append responses", async () => {
    const playlist = {
      id: "p-1",
      type: "library-playlists",
      attributes: { name: "Mix", canEdit: true },
    };
    const folder = {
      id: "f-1",
      type: "library-playlist-folders",
      attributes: { name: "Folder" },
    };
    const { client, request } = clientWithRequest(
      vi
        .fn<MusicRequest>()
        .mockResolvedValueOnce({ data: [playlist] })
        .mockResolvedValueOnce({ data: [folder] })
        .mockResolvedValueOnce(undefined),
    );
    await client.createPlaylist({
      name: "Mix",
      description: "Songs",
      isPublic: true,
      parentFolderId: "f-1",
    });
    await client.createPlaylistFolder({
      name: "Folder",
      parentFolderId: "root",
    });
    await client.addTracksToPlaylist("p-1", [
      { id: "song-1", type: "songs" },
      { id: "library-song-1", type: "library-songs" },
      { id: "video-1", type: "music-videos" },
      { id: "library-video-1", type: "library-music-videos" },
    ]);
    const createOptions = request.mock.calls[0][2] as {
      method: string;
      body: string;
    };
    expect(createOptions.method).toBe("POST");
    expect(JSON.parse(createOptions.body)).toEqual({
      attributes: { name: "Mix", description: "Songs", isPublic: true },
      relationships: {
        parent: {
          data: [{ id: "f-1", type: "library-playlist-folders" }],
        },
      },
    });
    const folderOptions = request.mock.calls[1][2] as {
      method: string;
      body: string;
    };
    expect(folderOptions.method).toBe("POST");
    expect(JSON.parse(folderOptions.body)).toEqual({
      attributes: { name: "Folder" },
      relationships: {
        parent: {
          data: [{ id: "root", type: "library-playlist-folders" }],
        },
      },
    });
    const appendOptions = request.mock.calls[2][2] as {
      method: string;
      body: string;
    };
    expect(appendOptions.method).toBe("POST");
    expect(JSON.parse(appendOptions.body)).toEqual({
      data: [
        { id: "song-1", type: "songs" },
        { id: "library-song-1", type: "library-songs" },
        { id: "video-1", type: "music-videos" },
        { id: "library-video-1", type: "library-music-videos" },
      ],
    });
  });

  it("rejects empty names and unsupported track references", async () => {
    const { client } = clientWithRequest(vi.fn<MusicRequest>());
    await expect(client.createPlaylist({ name: " " })).rejects.toThrow(
      "Playlist name is required",
    );
    await expect(
      client.addTracksToPlaylist("p-1", [
        { id: "album-1", type: "albums" } as never,
      ]),
    ).rejects.toThrow("Unsupported playlist track resource reference");
  });
});
