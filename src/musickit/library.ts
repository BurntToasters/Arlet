import {
  createPageReaders,
  type LibraryPageOptions,
  type MusicRequest,
  type Page,
} from "./library-pages.ts";
import {
  createDetailMethods,
  type ArtistDetail,
  type DetailWithTracks,
} from "./library-detail.ts";
import {
  createFolderMethods,
  type CreatePlaylistFolderInput,
  type CreatePlaylistInput,
} from "./library-folders.ts";
import {
  createHomeMethods,
  type HomeRecommendationSection,
  type HomeResource,
} from "./library-home.ts";
import { addTracksToPlaylist } from "./library-mutations.ts";
import { resolveMusicKitMusicRequest } from "./catalog.ts";
import {
  normalizeAlbumResource,
  normalizeArtistResource,
  normalizeLibraryItemResource,
  normalizePlaylistResource,
  normalizeTrackResource,
} from "./normalize.ts";
import type {
  Album,
  Artist,
  LibraryItem,
  MusicResourceRef,
  MusicSource,
  Playlist,
  PlaylistFolder,
  Track,
} from "../domain/music.ts";

export { LIBRARY_PAGE_LIMIT } from "./library-pages.ts";
export type {
  LibraryPageOptions,
  MusicRequest,
  Page,
} from "./library-pages.ts";
export type { ArtistDetail, DetailWithTracks } from "./library-detail.ts";
export type {
  CreatePlaylistFolderInput,
  CreatePlaylistInput,
  PlaylistCreationInput,
  PlaylistFolderCreationInput,
} from "./library-folders.ts";
export type {
  HomeRecommendationSection,
  HomeResource,
} from "./library-home.ts";
export { normalizeRecommendationGroups } from "./library-home.ts";
export type { AddToLibraryIds } from "./library-mutations.ts";
export { addToLibrary } from "./library-mutations.ts";
export type { RatingResourceType } from "./library-ratings.ts";
export { clearRating, getRatings, setRating } from "./library-ratings.ts";

export interface AppleMusicLibraryClient {
  getSongs(cursor?: string | LibraryPageOptions): Promise<Page<Track>>;
  getAlbums(cursor?: string | LibraryPageOptions): Promise<Page<Album>>;
  getArtists(cursor?: string | LibraryPageOptions): Promise<Page<Artist>>;
  getPlaylists(cursor?: string | LibraryPageOptions): Promise<Page<Playlist>>;
  getRecentlyAdded(
    cursor?: string | LibraryPageOptions,
  ): Promise<Page<LibraryItem>>;
  getRecentlyPlayedTracks(
    cursor?: string | LibraryPageOptions,
  ): Promise<Page<Track>>;
  getRecentlyPlayed(limit?: number): Promise<Page<HomeResource>>;
  getHeavyRotation(limit?: number): Promise<Page<HomeResource>>;
  getRecommendations(limit?: number): Promise<HomeRecommendationSection[]>;
  getAlbum(id: string, source?: MusicSource): Promise<Album | undefined>;
  /** One request for the album and, when complete, its first track page. */
  getAlbumDetail(
    id: string,
    source?: MusicSource,
  ): Promise<DetailWithTracks<Album>>;
  getAlbumTracks(
    id: string,
    source?: MusicSource,
    cursor?: string | LibraryPageOptions,
  ): Promise<Page<Track>>;
  getArtist(id: string, source?: MusicSource): Promise<Artist | undefined>;
  /**
   * The artist page's shelves in one catalog request. A library artist first
   * resolves its catalog ID; without one it returns the library record alone.
   */
  getArtistDetail(id: string, source?: MusicSource): Promise<ArtistDetail>;
  getArtistAlbums(
    id: string,
    cursor?: string | LibraryPageOptions,
    source?: MusicSource,
  ): Promise<Page<Album>>;
  getPlaylist(id: string, source?: MusicSource): Promise<Playlist | undefined>;
  /** One request for the playlist and, when complete, its first track page. */
  getPlaylistDetail(
    id: string,
    source?: MusicSource,
  ): Promise<DetailWithTracks<Playlist>>;
  /** Batched lookup: 25 ids per catalog request, 100 per library request. */
  getPlaylistsByIds(
    ids: readonly string[],
    source?: MusicSource,
  ): Promise<Playlist[]>;
  getPlaylistTracks(
    id: string,
    cursor?: string | LibraryPageOptions,
    source?: MusicSource,
  ): Promise<Page<Track>>;
  getRootPlaylistFolder(): Promise<PlaylistFolder | undefined>;
  getPlaylistFolder(id: string): Promise<PlaylistFolder | undefined>;
  searchPlaylists(
    term: string,
    cursor?: string | LibraryPageOptions,
  ): Promise<Page<Playlist>>;
  createPlaylist(input: CreatePlaylistInput): Promise<Playlist>;
  createPlaylistFolder(
    input: CreatePlaylistFolderInput,
  ): Promise<PlaylistFolder>;
  addTracksToPlaylist(
    playlistId: string,
    refs: readonly (MusicResourceRef | string)[],
  ): Promise<void>;
}

export function createAppleMusicLibraryClient(
  instance: MusicKit.MusicKitInstance,
): AppleMusicLibraryClient {
  const request = resolveMusicKitMusicRequest(instance) as MusicRequest;
  const { getPage } = createPageReaders(request);

  return {
    ...createHomeMethods(request),
    ...createDetailMethods(request, instance),
    ...createFolderMethods(request),
    getSongs: (cursor) =>
      getPage(
        "/v1/me/library/songs",
        cursor,
        undefined,
        normalizeTrackResource,
      ),
    getAlbums: (cursor) =>
      getPage(
        "/v1/me/library/albums",
        cursor,
        undefined,
        normalizeAlbumResource,
      ),
    getArtists: (cursor) =>
      getPage(
        "/v1/me/library/artists",
        cursor,
        undefined,
        normalizeArtistResource,
      ),
    getPlaylists: (cursor) =>
      getPage(
        "/v1/me/library/playlists",
        cursor,
        undefined,
        normalizePlaylistResource,
      ),
    getRecentlyAdded: (cursor) =>
      getPage(
        "/v1/me/library/recently-added",
        cursor,
        undefined,
        normalizeLibraryItemResource,
      ),
    getRecentlyPlayedTracks: (cursor) =>
      getPage(
        "/v1/me/recent/played/tracks",
        cursor,
        {
          types: "library-music-videos,library-songs,music-videos,songs",
        },
        normalizeTrackResource,
      ),

    searchPlaylists: (term, cursor) => {
      const normalizedTerm = term.trim();
      if (!normalizedTerm) return Promise.resolve({ items: [] });
      return getPage(
        "/v1/me/library/search",
        cursor,
        { term: normalizedTerm, types: "library-playlists" },
        normalizePlaylistResource,
      );
    },

    addTracksToPlaylist: (playlistId, refs) =>
      addTracksToPlaylist(request, playlistId, refs),
  };
}
