import type { Track } from "../domain/music.ts";
import { getState, type LibraryEntity } from "../state.ts";
import {
  asLibraryEntities,
  asRecord,
  libraryMethod,
  safeErrorMessage,
  trackIds,
  trackRefs,
  type ControllerContext,
} from "./controller-support.ts";
import type { LibraryLoader } from "./library-loader.ts";

export interface CreatePlaylistRequest {
  name: string;
  description?: string;
  tracks?: readonly Track[] | readonly string[];
  /** Library folder to create the playlist in; omitted means the root. */
  parentFolderId?: string;
}

/**
 * Apple's library API caps batched IDs and paged reads at 100. The playlist
 * mutation endpoints publish no larger bound, so one request carries at most
 * this many tracks; a longer save creates with the first batch and appends the
 * rest one batch at a time.
 */
export const PLAYLIST_TRACK_CHUNK_SIZE = 100;

/** A save that created its playlist but stopped partway through its tracks. */
export class PlaylistPartialSaveError extends Error {
  readonly savedCount: number;
  readonly totalCount: number;
  readonly playlistId: string | undefined;

  constructor(savedCount: number, totalCount: number, playlistId?: string) {
    const missing = totalCount - savedCount;
    super(
      `Saved ${savedCount} of ${totalCount} songs. ${missing} could not be added.`,
    );
    this.name = "PlaylistPartialSaveError";
    this.savedCount = savedCount;
    this.totalCount = totalCount;
    this.playlistId = playlistId;
  }
}

/**
 * Searching, creating, and adding to library playlists. Each change refreshes
 * the playlist list or the edited playlist so the library shows it.
 */
export function createPlaylistEditing(
  context: Pick<ControllerContext, "log">,
  library: Pick<
    LibraryLoader,
    "requireLibrary" | "refreshPlaylistsAfterMutation" | "loadPlaylist"
  >,
) {
  const { log } = context;
  const { requireLibrary } = library;

  return {
    async searchPlaylists(query: string): Promise<LibraryEntity[]> {
      const trimmed = query.trim();
      if (!trimmed) return [];
      const raw = await libraryMethod(
        requireLibrary(),
        "searchPlaylists",
      )(trimmed);
      return asLibraryEntities(raw);
    },

    async createPlaylist(
      requestOrName: CreatePlaylistRequest | string,
      legacyDescription?: string,
      legacyTracks?: readonly Track[] | readonly string[],
    ): Promise<LibraryEntity | undefined> {
      const request: CreatePlaylistRequest =
        typeof requestOrName === "string"
          ? {
              name: requestOrName,
              description: legacyDescription,
              tracks: legacyTracks,
            }
          : requestOrName;
      const trimmed = request.name.trim();
      if (!trimmed) throw new Error("Playlist name is required.");
      const refs =
        request.tracks && request.tracks.length > 0
          ? trackRefs(request.tracks)
          : [];
      // Small saves stay one request, exactly as before. Larger saves put the
      // first batch in the create and append the rest sequentially, so a
      // failed batch never leaves a half-written request in flight.
      const firstChunk = refs.slice(0, PLAYLIST_TRACK_CHUNK_SIZE);
      const raw = await libraryMethod(
        requireLibrary(),
        "createPlaylist",
      )({
        name: trimmed,
        description:
          request.description && request.description.trim().length > 0
            ? request.description.trim()
            : undefined,
        parentFolderId: request.parentFolderId,
        ...(firstChunk.length > 0 ? { tracks: firstChunk } : {}),
      });
      const items = asLibraryEntities(raw);
      const playlist = items[0];
      if (!playlist || refs.length <= PLAYLIST_TRACK_CHUNK_SIZE) {
        await library.refreshPlaylistsAfterMutation(
          "Playlist list refresh failed after create",
        );
        return playlist;
      }
      let saved = firstChunk.length;
      try {
        for (
          let start = PLAYLIST_TRACK_CHUNK_SIZE;
          start < refs.length;
          start += PLAYLIST_TRACK_CHUNK_SIZE
        ) {
          const chunk = refs.slice(start, start + PLAYLIST_TRACK_CHUNK_SIZE);
          await libraryMethod(requireLibrary(), "addTracksToPlaylist")(
            playlist.id,
            chunk,
          );
          saved += chunk.length;
        }
      } catch {
        // The playlist stays with the batches that did arrive. No retry:
        // retrying the save would create a second playlist.
        await library.refreshPlaylistsAfterMutation(
          "Playlist list refresh failed after partial create",
        );
        throw new PlaylistPartialSaveError(saved, refs.length, playlist.id);
      }
      await library.refreshPlaylistsAfterMutation(
        "Playlist list refresh failed after create",
      );
      return playlist;
    },

    async createPlaylistFolder(
      name: string,
      parentFolderId?: string,
    ): Promise<LibraryEntity | undefined> {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Folder name is required.");
      const raw = await libraryMethod(
        requireLibrary(),
        "createPlaylistFolder",
      )({ name: trimmed, parentFolderId });
      const items = asLibraryEntities(raw);
      await library.refreshPlaylistsAfterMutation(
        "Playlist list refresh failed after folder create",
      );
      return items[0];
    },

    async addTracksToPlaylist(
      playlistId: string,
      tracks: readonly Track[] | readonly string[],
    ): Promise<void> {
      const ids = trackIds(tracks);
      if (!playlistId.trim()) throw new Error("Playlist id is required.");
      if (ids.length === 0) throw new Error("At least one track is required.");
      const detail = getState().library.details.playlist[playlistId];
      const listed = getState().library.collections.playlists.items.find(
        (item) => item.id === playlistId,
      );
      const playlist = asRecord(detail)?.item ?? listed;
      if (asRecord(playlist)?.canEdit === false) {
        throw new Error("This playlist cannot be edited.");
      }
      for (const track of tracks) {
        if (typeof track !== "string" && track.addable === false) {
          throw new Error(`Track cannot be added to playlist: ${track.title}`);
        }
      }
      await libraryMethod(requireLibrary(), "addTracksToPlaylist")(
        playlistId,
        trackRefs(tracks),
      );
      try {
        await library.loadPlaylist(playlistId, "library", { refresh: true });
      } catch (error) {
        log(
          `Playlist refresh failed after adding tracks: ${safeErrorMessage(error)}`,
        );
      }
    },
  };
}
