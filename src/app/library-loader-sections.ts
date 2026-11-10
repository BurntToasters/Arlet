import {
  LIBRARY_PAGE_LIMIT,
  type AppleMusicLibraryClient,
} from "../musickit/library.ts";
import { LIBRARY_CACHE_SCOPE, type CachedPage } from "../library/cache.ts";
import { safeNextPath } from "../musickit/response.ts";
import {
  appendLibraryCollectionItems,
  getState,
  setAccountSummary,
  setLibraryCollectionItems,
  setLibraryCollectionState,
  type LibraryEntity,
  type LibrarySection,
} from "../state.ts";
import {
  asPage,
  libraryMethod,
  safeErrorMessage,
} from "./controller-support.ts";
import {
  OFFLINE_MESSAGE,
  type LibraryLoaderDeps,
} from "./library-loader-helpers.ts";

/**
 * Most pages one load-all call fetches. Apple pages are large, so this only
 * stops a cursor that never ends.
 */
const MAX_LOAD_ALL_PAGES = 500;

const libraryMethodForSection: Record<LibrarySection, string> = {
  recent: "getRecentlyAdded",
  history: "getRecentlyPlayedTracks",
  artists: "getArtists",
  albums: "getAlbums",
  songs: "getSongs",
  playlists: "getPlaylists",
};

/**
 * Library lists take the largest page Apple allows. Recent and history keep
 * Apple's default because their endpoints cap the size lower.
 */
const pageLimitForSection: Partial<Record<LibrarySection, number>> = {
  artists: LIBRARY_PAGE_LIMIT,
  albums: LIBRARY_PAGE_LIMIT,
  songs: LIBRARY_PAGE_LIMIT,
  playlists: LIBRARY_PAGE_LIMIT,
};

export function createSectionLoader(deps: LibraryLoaderDeps) {
  const { context, cache, requireLibrary, isOffline } = deps;
  const { requireMusic, now, log } = context;
  const {
    libraryCache,
    isAccountGenerationCurrent,
    enqueueCacheMutation,
    ensureLibraryCache,
  } = cache;
  /** Sections with a refresh in flight; "load more" and load-all wait for it. */
  const refreshingSections = new Map<LibrarySection, Promise<void>>();
  const refreshedSections = new Set<LibrarySection>();
  const libraryRequests = new Map<LibrarySection, number>();
  /** Load-all calls in flight; a new account generation starts its own. */
  const loadingAllSections = new Map<
    LibrarySection,
    { generation: number; load: Promise<void> }
  >();

  const fetchSectionPage = (
    client: AppleMusicLibraryClient,
    section: LibrarySection,
    cursor: string | undefined,
  ): Promise<unknown> => {
    const limit = pageLimitForSection[section];
    return libraryMethod(
      client,
      libraryMethodForSection[section],
    )(limit === undefined ? cursor : { cursor, limit });
  };

  const libraryPage = async (
    section: LibrarySection,
    cursor: string | undefined,
    isCurrent: () => boolean = () => true,
  ): Promise<CachedPage<LibraryEntity>> => {
    const raw = await fetchSectionPage(requireLibrary(), section, cursor);
    const storefront = String(requireMusic().storefrontId ?? "").trim();
    if (
      isCurrent() &&
      storefront &&
      storefront !== getState().library.account.storefront
    ) {
      setAccountSummary({ storefront });
    }
    return asPage(raw, cursor, now());
  };

  const hydrateLibrarySection = async (
    section: LibrarySection,
    generation = cache.currentGeneration(),
  ): Promise<CachedPage<LibraryEntity> | undefined> => {
    const isCurrent = (): boolean => isAccountGenerationCurrent(generation);
    await ensureLibraryCache(generation);
    if (!isCurrent()) return undefined;
    try {
      const cached = await libraryCache.readSection<LibraryEntity>(
        LIBRARY_CACHE_SCOPE,
        section,
      );
      if (isCurrent() && cached && cached.items.length > 0) {
        setLibraryCollectionItems(section, cached.items, {
          source: "cache",
          status: "success",
          next: cached.next,
          lastUpdatedAt: cached.updatedAt,
          stale: true,
        });
        return cached;
      }
    } catch (error) {
      log(`Library cache read failed (${section}): ${safeErrorMessage(error)}`);
    }
    return undefined;
  };

  const refreshLibrarySection = async (
    section: LibrarySection,
    generation = cache.currentGeneration(),
  ): Promise<void> => {
    if (!isAccountGenerationCurrent(generation)) return;
    if (isOffline()) throw new Error(OFFLINE_MESSAGE);
    const requestId = (libraryRequests.get(section) ?? 0) + 1;
    libraryRequests.set(section, requestId);
    const isCurrent = (): boolean =>
      isAccountGenerationCurrent(generation) &&
      libraryRequests.get(section) === requestId;
    const current = getState().library.collections[section];
    setLibraryCollectionState(section, {
      status: current.items.length > 0 ? "refreshing" : "loading",
      error: undefined,
    });
    const refresh = refreshSectionPage(section, generation, isCurrent);
    refreshingSections.set(section, refresh);
    try {
      await refresh;
    } finally {
      if (
        libraryRequests.get(section) === requestId ||
        !isAccountGenerationCurrent(generation)
      ) {
        refreshingSections.delete(section);
      }
    }
  };

  const refreshSectionPage = async (
    section: LibrarySection,
    generation: number,
    isCurrent: () => boolean,
  ): Promise<void> => {
    try {
      const page = await libraryPage(section, undefined, isCurrent);
      if (!isCurrent()) return;
      // Shown before it is saved. The save runs in the cache queue, which
      // skips it once a newer refresh starts, so it never overwrites newer data.
      setLibraryCollectionItems(section, page.items, {
        source: "network",
        status: "success",
        next: page.next,
        lastUpdatedAt: page.updatedAt,
        stale: false,
      });
      const storefront = getState().library.account.storefront;
      setAccountSummary({ lastRefreshAt: page.updatedAt });
      await ensureLibraryCache(generation);
      if (!isCurrent()) return;
      try {
        await enqueueCacheMutation(isCurrent, async () => {
          await libraryCache.clearSection(LIBRARY_CACHE_SCOPE, section);
          await libraryCache.writePage(LIBRARY_CACHE_SCOPE, section, page);
        });
      } catch (error) {
        log(
          `Library cache write failed (${section}): ${safeErrorMessage(error)}`,
        );
      }
      try {
        await enqueueCacheMutation(isCurrent, () =>
          libraryCache.setMeta({
            scope: LIBRARY_CACHE_SCOPE,
            storefront,
            lastRefreshAt: page.updatedAt,
          }),
        );
      } catch (error) {
        log(`Library cache metadata write failed: ${safeErrorMessage(error)}`);
      }
    } catch (error) {
      if (!isCurrent()) return;
      const message = safeErrorMessage(error);
      const latest = getState().library.collections[section];
      setLibraryCollectionState(section, {
        status: latest.items.length > 0 ? "success" : "error",
        source: latest.items.length > 0 ? latest.source : "none",
        error: message,
        stale: latest.items.length > 0,
      });
      log(`Library refresh failed (${section}): ${message}`);
      if (latest.items.length === 0) throw error;
    }
  };

  const loadLibrarySection = async (
    section: LibrarySection,
    options: { refresh?: boolean; cursor?: string } = {},
  ): Promise<void> => {
    const generation = cache.currentGeneration();
    if (isOffline()) {
      await hydrateLibrarySection(section, generation);
      return;
    }
    requireLibrary();
    if (options.cursor) {
      await loadMoreLibrarySection(section, options.cursor, generation);
      return;
    }
    const current = getState().library.collections[section];
    let cached: CachedPage<LibraryEntity> | undefined;
    if (!options.refresh && current.items.length === 0) {
      cached = await hydrateLibrarySection(section, generation);
    }
    if (!isAccountGenerationCurrent(generation)) return;
    if (options.refresh || !refreshedSections.has(section)) {
      refreshedSections.add(section);
      await refreshLibrarySection(section, generation);
    } else if (!cached && current.items.length === 0) {
      await refreshLibrarySection(section, generation);
    }
  };

  const loadMoreLibrarySection = async (
    section: LibrarySection,
    cursorOverride?: string,
    generation = cache.currentGeneration(),
  ): Promise<void> => {
    if (!isAccountGenerationCurrent(generation)) return;
    if (isOffline()) return;
    // A refresh replaces the list from its first page; appending a page now
    // would cancel that refresh, so wait for the refreshed list instead.
    if (refreshingSections.has(section)) return;
    const client = requireLibrary();
    const current = getState().library.collections[section];
    const cursor = safeNextPath(cursorOverride ?? current.next, ["/v1/me/"]);
    if (!cursor) return;
    const requestId = (libraryRequests.get(section) ?? 0) + 1;
    libraryRequests.set(section, requestId);
    const isCurrent = (): boolean =>
      isAccountGenerationCurrent(generation) &&
      libraryRequests.get(section) === requestId;
    setLibraryCollectionState(section, {
      status: "loading",
      error: undefined,
    });
    try {
      const raw = await fetchSectionPage(client, section, cursor);
      const page = asPage(raw, cursor, now());
      if (!isCurrent()) return;
      await ensureLibraryCache(generation);
      if (!isCurrent()) return;
      try {
        await enqueueCacheMutation(isCurrent, () =>
          libraryCache.writePage(LIBRARY_CACHE_SCOPE, section, page),
        );
      } catch (error) {
        log(
          `Library cache write failed (${section}): ${safeErrorMessage(error)}`,
        );
      }
      if (!isCurrent()) return;
      appendLibraryCollectionItems(section, page.items, {
        source: "network",
        next: page.next,
        lastUpdatedAt: page.updatedAt,
      });
    } catch (error) {
      if (!isCurrent()) return;
      const message = safeErrorMessage(error);
      const latest = getState().library.collections[section];
      setLibraryCollectionState(section, {
        status: latest.items.length > 0 ? "success" : "error",
        error: message,
        stale: latest.items.length > 0,
      });
      log(`Library page load failed (${section}): ${message}`);
      throw error;
    }
  };

  /**
   * Fetches every remaining page so client-side sort and filter see the whole
   * list. Pages run one at a time because each cursor comes from the page
   * before it. An unchanged `next` means loadMore skipped the page (a refresh
   * is replacing the list), so stop instead of asking for the same page again.
   */
  const loadAllLibraryPages = async (
    section: LibrarySection,
    generation: number,
  ): Promise<void> => {
    for (let pages = 0; pages < MAX_LOAD_ALL_PAGES; pages += 1) {
      // A refresh shows its first page before it finishes writing the cache.
      // loadMore skips while the refresh runs, so wait for it rather than stop.
      await refreshingSections.get(section)?.catch(() => undefined);
      const next = getState().library.collections[section].next;
      if (!next || !isAccountGenerationCurrent(generation) || isOffline()) {
        return;
      }
      try {
        await loadMoreLibrarySection(section, undefined, generation);
      } catch {
        // loadMoreLibrarySection already recorded the error in the collection.
        return;
      }
      if (getState().library.collections[section].next === next) return;
    }
  };

  const loadAllLibrarySection = (section: LibrarySection): Promise<void> => {
    const generation = cache.currentGeneration();
    const inFlight = loadingAllSections.get(section);
    if (inFlight?.generation === generation) return inFlight.load;
    // `finally` runs after this assignment, so the entry is always stored first.
    const load = loadAllLibraryPages(section, generation).finally(() => {
      if (loadingAllSections.get(section)?.load === load) {
        loadingAllSections.delete(section);
      }
    });
    loadingAllSections.set(section, { generation, load });
    return load;
  };
  return {
    refreshedSections,
    /** Drops in-flight section state when the library cache is cleared. */
    reset(): void {
      refreshedSections.clear();
      refreshingSections.clear();
      libraryRequests.clear();
    },
    refreshLibrarySection,
    loadLibrarySection,
    loadMoreLibrarySection,
    loadAllLibrarySection,
  };
}

export type SectionLoader = ReturnType<typeof createSectionLoader>;
