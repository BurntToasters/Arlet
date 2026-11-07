import type { AppleMusicLibraryClient } from "../musickit/library.ts";
import { LIBRARY_CACHE_SCOPE, type LibraryCache } from "../library/cache.ts";
import { createLibraryCacheCoordinator } from "./library-cache-coordinator.ts";
import {
  clearHomeState,
  clearLibraryState,
  getState,
  setLibraryOffline,
} from "../state.ts";
import {
  safeErrorMessage,
  type ControllerContext,
} from "./controller-support.ts";
import {
  createDetailRequests,
  type LibraryLoaderDeps,
} from "./library-loader-helpers.ts";
import { createSectionLoader } from "./library-loader-sections.ts";
import { createHomeLoader } from "./library-loader-home.ts";
import { createDetailLoader } from "./library-loader-detail.ts";
import { createPlaylistFolderLoader } from "./library-loader-folders.ts";

export type { DetailLoadOptions } from "./library-loader-helpers.ts";

/**
 * Library, Home, and detail loading with stale-while-revalidate caching.
 * Owns the library client, the request generations, and the SQLite cache.
 */
export function createLibraryLoader(
  context: ControllerContext,
  storedCache: LibraryCache,
) {
  const { requireMusic, log } = context;
  let libraryClient: AppleMusicLibraryClient | null = null;
  const cache = createLibraryCacheCoordinator(context, { storedCache });
  const {
    libraryCache,
    isAccountGenerationCurrent,
    ensureLibraryCache,
    openLibraryCache,
  } = cache;
  const detailRequests = createDetailRequests();

  const isOffline = (): boolean => getState().library.offline;

  /**
   * MusicKit loads from Apple's CDN, so offline it never starts. When the
   * cache holds a signed-in library (sign-out clears it), show that instead.
   */
  const enterOfflineMode = async (): Promise<boolean> => {
    const generation = cache.currentGeneration();
    try {
      await ensureLibraryCache(generation);
      const meta = await libraryCache.getMeta(LIBRARY_CACHE_SCOPE);
      if (!isAccountGenerationCurrent(generation)) return false;
      if (!meta?.storefront && !meta?.lastRefreshAt) return false;
      setLibraryOffline(true);
      return true;
    } catch (error) {
      log(`Offline library unavailable: ${safeErrorMessage(error)}`);
      return false;
    }
  };

  const requireLibrary = (): AppleMusicLibraryClient => {
    requireMusic();
    if (getState().auth.status !== "authorized") {
      throw new Error("Sign in to access your Apple Music library.");
    }
    if (!libraryClient) {
      throw new Error("Apple Music library is still initializing.");
    }
    return libraryClient;
  };

  const requireMusicClient = (): AppleMusicLibraryClient => {
    requireMusic();
    if (!libraryClient) {
      throw new Error("Apple Music catalog is still initializing.");
    }
    return libraryClient;
  };

  const deps: LibraryLoaderDeps = {
    context,
    cache,
    getLibraryClient: () => libraryClient,
    requireLibrary,
    requireMusicClient,
    isOffline,
  };
  const sections = createSectionLoader(deps);
  const home = createHomeLoader(deps);
  const details = createDetailLoader({
    ...deps,
    detailRequests,
    loadLibrarySection: sections.loadLibrarySection,
  });
  const folders = createPlaylistFolderLoader({
    ...deps,
    detailRequests,
    loadOfflineDetail: details.loadOfflineDetail,
    refreshLibrarySection: sections.refreshLibrarySection,
    refreshedSections: sections.refreshedSections,
  });

  const clearLibraryCache = (): Promise<void> =>
    cache.clearLibraryCache(() => {
      sections.reset();
      detailRequests.clear();
      home.invalidate();
      clearHomeState();
      clearLibraryState();
    });

  return {
    client: (): AppleMusicLibraryClient | null => libraryClient,
    setClient(client: AppleMusicLibraryClient | null): void {
      libraryClient = client;
    },
    requireLibrary,
    enterOfflineMode,
    openLibraryCache,
    ensureLibraryCache,
    clearLibraryCache,
    loadLibrarySection: sections.loadLibrarySection,
    loadMoreLibrarySection: sections.loadMoreLibrarySection,
    loadAllLibrarySection: sections.loadAllLibrarySection,
    refreshLibrarySection: sections.refreshLibrarySection,
    loadHome: home.loadHome,
    loadDetail: details.loadDetail,
    loadPlaylist: details.loadPlaylist,
    loadPlaylistFolder: folders.loadPlaylistFolder,
    refreshPlaylistsAfterMutation: folders.refreshPlaylistsAfterMutation,
  };
}

export type LibraryLoader = ReturnType<typeof createLibraryLoader>;
