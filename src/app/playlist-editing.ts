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
      const raw = await libraryMethod(
        requireLibrary(),
        "createPlaylist",
      )({
        name: trimmed,
        description:
          request.description && request.description.trim().length > 0
            ? request.description.trim()
            : undefined,
        ...(request.tracks && request.tracks.length > 0
          ? { tracks: trackRefs(request.tracks) }
          : {}),
      });
      const items = asLibraryEntities(raw);
      await library.refreshPlaylistsAfterMutation(
        "Playlist list refresh failed after create",
      );
      return items[0];
    },

    async createPlaylistFolder(
      name: string,
    ): Promise<LibraryEntity | undefined> {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Folder name is required.");
      const raw = await libraryMethod(
        requireLibrary(),
        "createPlaylistFolder",
      )({ name: trimmed });
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
