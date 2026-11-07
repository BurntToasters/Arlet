import { LIBRARY_CACHE_SCOPE } from "../library/cache.ts";
import {
  setLibraryDetailState,
  type LibraryEntity,
  type LibrarySection,
} from "../state.ts";
import {
  detailFromResponse,
  flattenFolderChildren,
  libraryMethod,
  safeErrorMessage,
} from "./controller-support.ts";
import type {
  DetailRequests,
  LibraryLoaderDeps,
} from "./library-loader-helpers.ts";
import type { DetailLoader } from "./library-loader-detail.ts";
import type { SectionLoader } from "./library-loader-sections.ts";

export interface PlaylistFolderDeps extends LibraryLoaderDeps {
  detailRequests: DetailRequests;
  loadOfflineDetail: DetailLoader["loadOfflineDetail"];
  refreshLibrarySection: SectionLoader["refreshLibrarySection"];
  refreshedSections: Set<LibrarySection>;
}

export function createPlaylistFolderLoader(deps: PlaylistFolderDeps) {
  const {
    context,
    cache,
    requireLibrary,
    isOffline,
    detailRequests,
    loadOfflineDetail,
    refreshLibrarySection,
    refreshedSections,
  } = deps;
  const { now, log } = context;
  const {
    libraryCache,
    isAccountGenerationCurrent,
    enqueueCacheMutation,
    ensureLibraryCache,
  } = cache;

  const loadPlaylistFolder = async (id?: string): Promise<void> => {
    const section = `playlist-folder:${id ?? "root"}`;
    const generation = cache.currentGeneration();
    const requestKey = `playlist-folder:${id ?? "root"}`;
    const requestId = detailRequests.begin(requestKey);
    const isCurrent = (): boolean =>
      isAccountGenerationCurrent(generation) &&
      detailRequests.isLatest(requestKey, requestId);
    if (isOffline()) {
      await loadOfflineDetail(
        "playlistFolder",
        section,
        undefined,
        undefined,
        isCurrent,
      );
      return;
    }
    const client = requireLibrary();
    setLibraryDetailState("playlistFolder", {
      status: "loading",
      error: undefined,
    });
    try {
      const raw = id
        ? await libraryMethod(client, "getPlaylistFolder")(id)
        : await libraryMethod(client, "getRootPlaylistFolder")();
      if (!isCurrent()) return;
      const detail = detailFromResponse(raw);
      const items = flattenFolderChildren(raw);
      const updatedAt = now();
      await ensureLibraryCache(generation);
      if (!isCurrent()) return;
      try {
        await enqueueCacheMutation(isCurrent, async () => {
          await libraryCache.clearSection(LIBRARY_CACHE_SCOPE, section);
          await libraryCache.writePage(LIBRARY_CACHE_SCOPE, section, {
            items: detail.item ? [detail.item, ...items] : items,
            updatedAt,
          });
        });
      } catch (cacheError) {
        log(
          `Playlist folder cache write failed: ${safeErrorMessage(cacheError)}`,
        );
      }
      if (!isCurrent()) return;
      setLibraryDetailState("playlistFolder", {
        status: "success",
        source: "network",
        item: detail.item,
        items,
        next: detail.next,
        lastUpdatedAt: updatedAt,
        stale: false,
      });
    } catch (error) {
      if (!isCurrent()) return;
      try {
        await ensureLibraryCache(generation);
        if (!isCurrent()) return;
        const cached = await libraryCache.readSection<LibraryEntity>(
          LIBRARY_CACHE_SCOPE,
          section,
        );
        if (!isCurrent()) return;
        if (cached?.items.length) {
          setLibraryDetailState("playlistFolder", {
            status: "success",
            source: "cache",
            item: cached.items[0],
            items: cached.items.slice(1),
            lastUpdatedAt: cached.updatedAt,
            stale: true,
            error: safeErrorMessage(error),
          });
          return;
        }
      } catch (cacheError) {
        log(
          `Playlist folder cache read failed: ${safeErrorMessage(cacheError)}`,
        );
      }
      const message = safeErrorMessage(error);
      setLibraryDetailState("playlistFolder", {
        status: "error",
        source: "none",
        error: message,
        stale: false,
      });
      log(`Playlist folder load failed: ${message}`);
      throw error;
    }
  };

  /** Re-fetches the playlist list and root folder after a library mutation. */
  const refreshPlaylistsAfterMutation = async (
    failureLabel: string,
  ): Promise<void> => {
    const generation = cache.currentGeneration();
    refreshedSections.delete("playlists");
    try {
      await refreshLibrarySection("playlists", generation);
      if (!isAccountGenerationCurrent(generation)) return;
      await loadPlaylistFolder();
      if (!isAccountGenerationCurrent(generation)) return;
      refreshedSections.add("playlists");
    } catch (error) {
      log(`${failureLabel}: ${safeErrorMessage(error)}`);
    }
  };
  return { loadPlaylistFolder, refreshPlaylistsAfterMutation };
}
