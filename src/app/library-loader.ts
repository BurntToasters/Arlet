import {
  resolveMusicKitMusicRequest,
  resolveStorefront,
} from "../musickit/catalog.ts";
import type { AppleMusicLibraryClient } from "../musickit/library.ts";
import {
  LIBRARY_CACHE_SCOPE,
  type CachedPage,
  type LibraryCache,
} from "../library/cache.ts";
import type { MusicSource } from "../domain/music.ts";
import {
  appendLibraryCollectionItems,
  clearHomeState,
  clearLibraryState,
  getState,
  setAccountSummary,
  setHomeState,
  setLibraryCollectionItems,
  setLibraryCollectionState,
  setLibraryDetailState,
  setLibraryHydrated,
  type HomeState,
  type LibraryDetailState,
  type LibraryEntity,
  type LibrarySection,
} from "../state.ts";
import {
  asLibraryEntities,
  asNext,
  asPage,
  asRecord,
  detailCacheSection,
  detailFromResponse,
  detailRequestKey,
  flattenFolderChildren,
  libraryMethod,
  normalizedLibraryEntities,
  safeErrorMessage,
  type ControllerContext,
  type LibraryMethod,
} from "./controller-support.ts";

export interface DetailLoadOptions {
  refresh?: boolean;
}

type DetailKind = "album" | "artist" | "playlist";

interface DetailResult {
  item?: LibraryEntity;
  items: LibraryEntity[];
  next?: string;
}

const libraryMethodForSection: Record<LibrarySection, string> = {
  recent: "getRecentlyAdded",
  history: "getRecentlyPlayedTracks",
  artists: "getArtists",
  albums: "getAlbums",
  songs: "getSongs",
  playlists: "getPlaylists",
};

function detailLabels(kind: DetailKind): {
  read: string;
  write: string;
  load: string;
} {
  return kind === "playlist"
    ? {
        read: "Playlist cache read failed",
        write: "Playlist cache write failed",
        load: "Playlist load failed",
      }
    : {
        read: `Library detail cache read failed (${kind})`,
        write: `Library detail cache write failed (${kind})`,
        load: `Library detail load failed (${kind})`,
      };
}

/** Playlists expose `tracks`; albums expose `tracks`; artists expose `albums`. */
function detailChildren(
  kind: DetailKind,
  items: LibraryEntity[],
): Partial<LibraryDetailState> {
  return kind === "playlist"
    ? { tracks: items }
    : {
        tracks: kind === "album" ? items : undefined,
        albums: kind === "artist" ? items : undefined,
      };
}

function cachedDetailPatch(
  kind: DetailKind,
  page: CachedPage<LibraryEntity>,
  error: string | undefined,
): Partial<LibraryDetailState> {
  const items = page.items.slice(1);
  return {
    status: "success",
    source: "cache",
    item: page.items[0],
    resource: page.items[0],
    items,
    ...detailChildren(kind, items),
    next: page.next,
    lastUpdatedAt: page.updatedAt,
    stale: true,
    error,
  };
}

/**
 * Library, Home, and detail loading with stale-while-revalidate caching.
 * Owns the library client, the request generations, and the SQLite cache.
 */
export function createLibraryLoader(
  context: ControllerContext,
  libraryCache: LibraryCache,
) {
  const { requireMusic, getMusic, now, log } = context;
  let libraryClient: AppleMusicLibraryClient | null = null;
  let cacheReady: Promise<void> | undefined;
  const refreshedSections = new Set<LibrarySection>();
  const libraryRequests = new Map<LibrarySection, number>();
  const detailRequests = new Map<string, number>();
  let homeRequestId = 0;

  const ensureLibraryCache = async (): Promise<void> => {
    cacheReady ??= libraryCache.initialize().catch((error: unknown) => {
      log(`Library cache unavailable: ${safeErrorMessage(error)}`);
    });
    await cacheReady;
    setLibraryHydrated(true);
    try {
      const meta = await libraryCache.getMeta(LIBRARY_CACHE_SCOPE);
      if (meta?.storefront || meta?.lastRefreshAt) {
        setAccountSummary({
          storefront: meta.storefront,
          lastRefreshAt: meta.lastRefreshAt,
        });
      }
    } catch (error) {
      log(`Library cache metadata unavailable: ${safeErrorMessage(error)}`);
    }
  };

  const clearLibraryCache = async (): Promise<void> => {
    refreshedSections.clear();
    homeRequestId += 1;
    clearHomeState();
    clearLibraryState();
    try {
      await libraryCache.clear(LIBRARY_CACHE_SCOPE);
    } catch (error) {
      log(`Library cache clear failed: ${safeErrorMessage(error)}`);
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

  const fetchSectionPage = (
    client: AppleMusicLibraryClient,
    section: LibrarySection,
    cursor: string | undefined,
  ): Promise<unknown> =>
    libraryMethod(client, libraryMethodForSection[section])(cursor);

  const libraryPage = async (
    section: LibrarySection,
    cursor: string | undefined,
  ): Promise<CachedPage<LibraryEntity>> => {
    const raw = await fetchSectionPage(requireLibrary(), section, cursor);
    const storefront = String(requireMusic().storefrontId ?? "").trim();
    if (storefront && storefront !== getState().library.account.storefront) {
      setAccountSummary({ storefront });
    }
    return asPage(raw, cursor, now());
  };

  const hydrateLibrarySection = async (
    section: LibrarySection,
  ): Promise<CachedPage<LibraryEntity> | undefined> => {
    await ensureLibraryCache();
    try {
      const cached = await libraryCache.readSection<LibraryEntity>(
        LIBRARY_CACHE_SCOPE,
        section,
      );
      if (cached && cached.items.length > 0) {
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
  ): Promise<void> => {
    const requestId = (libraryRequests.get(section) ?? 0) + 1;
    libraryRequests.set(section, requestId);
    const current = getState().library.collections[section];
    setLibraryCollectionState(section, {
      status: current.items.length > 0 ? "refreshing" : "loading",
      error: undefined,
    });
    try {
      const page = await libraryPage(section, undefined);
      if (libraryRequests.get(section) !== requestId) return;
      await ensureLibraryCache();
      try {
        await libraryCache.clearSection(LIBRARY_CACHE_SCOPE, section);
        await libraryCache.writePage(LIBRARY_CACHE_SCOPE, section, page);
      } catch (error) {
        log(
          `Library cache write failed (${section}): ${safeErrorMessage(error)}`,
        );
      }
      setLibraryCollectionItems(section, page.items, {
        source: "network",
        status: "success",
        next: page.next,
        lastUpdatedAt: page.updatedAt,
        stale: false,
      });
      const storefront = getState().library.account.storefront;
      setAccountSummary({ lastRefreshAt: page.updatedAt });
      try {
        await libraryCache.setMeta({
          scope: LIBRARY_CACHE_SCOPE,
          storefront,
          lastRefreshAt: page.updatedAt,
        });
      } catch (error) {
        log(`Library cache metadata write failed: ${safeErrorMessage(error)}`);
      }
    } catch (error) {
      if (libraryRequests.get(section) !== requestId) return;
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

  const loadHome = async (
    options: { refresh?: boolean } = {},
  ): Promise<void> => {
    requireLibrary();
    const current = getState().home;
    if (!options.refresh && current.status === "success") return;
    const requestId = ++homeRequestId;
    setHomeState({
      status:
        current.recentPlaylists.length ||
        current.heavyRotation.length ||
        current.recommendations.length
          ? "refreshing"
          : "loading",
      errors: {},
    });
    const client = requireLibrary();
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        libraryMethod(client, "getRecentlyPlayedPlaylists")(10),
      ),
      Promise.resolve().then(() =>
        libraryMethod(client, "getHeavyRotation")(10),
      ),
      Promise.resolve().then(() =>
        libraryMethod(client, "getRecommendations")(10),
      ),
    ]);
    if (homeRequestId !== requestId) return;

    const errors: HomeState["errors"] = {};
    let successful = 0;
    let recentPlaylists = current.recentPlaylists;
    let heavyRotation = current.heavyRotation;
    let recommendations = current.recommendations;
    const [recentResult, heavyResult, recommendationResult] = results;
    if (recentResult.status === "fulfilled") {
      successful += 1;
      recentPlaylists = asLibraryEntities(
        asRecord(recentResult.value)?.items ?? recentResult.value,
      ) as HomeState["recentPlaylists"];
    } else {
      errors.recentPlaylists = safeErrorMessage(recentResult.reason);
    }
    if (heavyResult.status === "fulfilled") {
      successful += 1;
      heavyRotation = asLibraryEntities(
        asRecord(heavyResult.value)?.items ?? heavyResult.value,
      ).filter((item) => {
        const type = String(item.type ?? item.resourceType ?? "");
        return type.includes("album") || type.includes("playlist");
      }) as HomeState["heavyRotation"];
    } else {
      errors.heavyRotation = safeErrorMessage(heavyResult.reason);
    }
    if (recommendationResult.status === "fulfilled") {
      successful += 1;
      recommendations = Array.isArray(recommendationResult.value)
        ? recommendationResult.value
        : [];
    } else {
      errors.recommendations = safeErrorMessage(recommendationResult.reason);
    }
    const hasData =
      recentPlaylists.length > 0 ||
      heavyRotation.length > 0 ||
      recommendations.length > 0;
    const updatedAt = now();
    setHomeState({
      status: successful > 0 ? "success" : "error",
      recentPlaylists,
      heavyRotation,
      recommendations,
      errors,
      lastUpdatedAt: successful > 0 ? updatedAt : current.lastUpdatedAt,
      stale: hasData && successful < 3,
    });
    if (successful === 0) {
      throw new Error(
        Object.values(errors).filter(Boolean).join("; ") ||
          "Apple Music Home is unavailable.",
      );
    }
  };

  const loadLibrarySection = async (
    section: LibrarySection,
    options: { refresh?: boolean; cursor?: string } = {},
  ): Promise<void> => {
    requireLibrary();
    if (options.cursor) {
      await loadMoreLibrarySection(section, options.cursor);
      return;
    }
    const current = getState().library.collections[section];
    let cached: CachedPage<LibraryEntity> | undefined;
    if (!options.refresh && current.items.length === 0) {
      cached = await hydrateLibrarySection(section);
    }
    if (options.refresh || !refreshedSections.has(section)) {
      refreshedSections.add(section);
      await refreshLibrarySection(section);
    } else if (!cached && current.items.length === 0) {
      await refreshLibrarySection(section);
    }
  };

  const loadMoreLibrarySection = async (
    section: LibrarySection,
    cursorOverride?: string,
  ): Promise<void> => {
    const client = requireLibrary();
    const current = getState().library.collections[section];
    const cursor = cursorOverride ?? current.next;
    if (!cursor) return;
    const requestId = (libraryRequests.get(section) ?? 0) + 1;
    libraryRequests.set(section, requestId);
    setLibraryCollectionState(section, {
      status: "loading",
      error: undefined,
    });
    try {
      const raw = await fetchSectionPage(client, section, cursor);
      const page = asPage(raw, cursor, now());
      if (libraryRequests.get(section) !== requestId) return;
      await ensureLibraryCache();
      try {
        await libraryCache.writePage(LIBRARY_CACHE_SCOPE, section, page);
      } catch (error) {
        log(
          `Library cache write failed (${section}): ${safeErrorMessage(error)}`,
        );
      }
      appendLibraryCollectionItems(section, page.items, {
        source: "network",
        next: page.next,
        lastUpdatedAt: page.updatedAt,
      });
    } catch (error) {
      if (libraryRequests.get(section) !== requestId) return;
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

  const loadAlbumTracks = async (
    client: AppleMusicLibraryClient,
    id: string,
    source: MusicSource,
  ): Promise<LibraryEntity[]> => {
    const method = (client as unknown as Record<string, unknown>)
      .getAlbumTracks;
    if (typeof method === "function") {
      return asLibraryEntities(
        await (method as LibraryMethod).call(client, id, source),
      );
    }
    // The current public client contract keeps album-track expansion optional.
    // Use the documented relationship path only when MusicKit exposes its
    // request adapter; preview/test instances simply render the album shell.
    const instance = getMusic();
    if (!instance) return [];
    try {
      const storefront = String(instance.storefrontId ?? "").trim();
      const prefix =
        source === "catalog" && storefront
          ? `/v1/catalog/${encodeURIComponent(storefront)}`
          : "/v1/me/library";
      const raw = await resolveMusicKitMusicRequest(instance)(
        `${prefix}/albums/${encodeURIComponent(id)}/tracks`,
      );
      return normalizedLibraryEntities(raw);
    } catch {
      return [];
    }
  };

  const loadArtistAlbums = async (
    id: string,
    source: MusicSource,
    artistName: unknown,
  ): Promise<LibraryEntity[]> => {
    const music = getMusic();
    if (source === "catalog" && music) {
      const storefront = await resolveStorefront(music);
      const rawAlbums = await resolveMusicKitMusicRequest(music)(
        `/v1/catalog/${encodeURIComponent(storefront)}/artists/${encodeURIComponent(id)}/albums`,
      );
      return normalizedLibraryEntities(rawAlbums);
    }
    await loadLibrarySection("albums");
    return getState().library.collections.albums.items.filter((album) => {
      const candidate = album as LibraryEntity;
      return (
        typeof candidate.artistName === "string" &&
        typeof artistName === "string" &&
        candidate.artistName.localeCompare(artistName, undefined, {
          sensitivity: "base",
        }) === 0
      );
    });
  };

  /**
   * Shared stale-while-revalidate flow for album, artist, and playlist
   * details. `fetchDetail` returns `undefined` once its request is stale.
   */
  const loadDetailResource = async (
    kind: DetailKind,
    id: string,
    source: MusicSource,
    options: DetailLoadOptions,
    fetchDetail: (
      client: AppleMusicLibraryClient,
      isCurrent: () => boolean,
    ) => Promise<DetailResult | undefined>,
  ): Promise<void> => {
    const client =
      source === "library" ? requireLibrary() : requireMusicClient();
    const cacheSection = detailCacheSection(kind, id, source);
    const requestKey = detailRequestKey(kind, id, source);
    const requestId = (detailRequests.get(requestKey) ?? 0) + 1;
    detailRequests.set(requestKey, requestId);
    const isCurrent = (): boolean =>
      detailRequests.get(requestKey) === requestId;
    const labels = detailLabels(kind);
    const setLoading = (): void =>
      setLibraryDetailState(
        kind,
        { status: "loading", error: undefined },
        id,
        source,
      );
    const explicit = options.refresh === true;
    let stalePage: CachedPage<LibraryEntity> | undefined;
    if (!explicit) {
      try {
        await ensureLibraryCache();
        const cached = await libraryCache.readSection<LibraryEntity>(
          LIBRARY_CACHE_SCOPE,
          cacheSection,
        );
        if (!isCurrent()) {
          stalePage = undefined;
        } else if (cached?.items.length) {
          stalePage = cached;
          setLibraryDetailState(
            kind,
            cachedDetailPatch(kind, cached, undefined),
            id,
            source,
          );
        } else {
          setLoading();
        }
      } catch (error) {
        log(`${labels.read}: ${safeErrorMessage(error)}`);
        if (isCurrent()) setLoading();
      }
    } else {
      setLoading();
    }
    try {
      const detail = await fetchDetail(client, isCurrent);
      if (!detail || !isCurrent()) return;
      const page: CachedPage<LibraryEntity> = {
        cursor: undefined,
        items: detail.item ? [detail.item, ...detail.items] : detail.items,
        next: detail.next,
        updatedAt: now(),
      };
      await ensureLibraryCache();
      try {
        await libraryCache.clearSection(LIBRARY_CACHE_SCOPE, cacheSection);
        await libraryCache.writePage(LIBRARY_CACHE_SCOPE, cacheSection, page);
      } catch (error) {
        log(`${labels.write}: ${safeErrorMessage(error)}`);
      }
      if (!isCurrent()) return;
      setLibraryDetailState(
        kind,
        {
          status: "success",
          source: "network",
          item: detail.item,
          resource: detail.item,
          items: detail.items,
          ...detailChildren(kind, detail.items),
          next: page.next,
          lastUpdatedAt: page.updatedAt,
          stale: false,
        },
        id,
        source,
      );
    } catch (error) {
      if (!isCurrent()) return;
      if (stalePage?.items.length) {
        setLibraryDetailState(
          kind,
          cachedDetailPatch(kind, stalePage, safeErrorMessage(error)),
          id,
          source,
        );
        log(`${labels.load}: ${safeErrorMessage(error)}`);
        if (explicit) throw error;
        return;
      }
      try {
        await ensureLibraryCache();
        const cached = await libraryCache.readSection<LibraryEntity>(
          LIBRARY_CACHE_SCOPE,
          cacheSection,
        );
        if (!isCurrent()) return;
        if (cached?.items.length) {
          setLibraryDetailState(
            kind,
            cachedDetailPatch(kind, cached, safeErrorMessage(error)),
            id,
            source,
          );
          log(`${labels.load}: ${safeErrorMessage(error)}`);
          if (explicit) throw error;
          return;
        }
      } catch (cacheError) {
        log(`${labels.read}: ${safeErrorMessage(cacheError)}`);
      }
      if (!isCurrent()) return;
      const message = safeErrorMessage(error);
      setLibraryDetailState(
        kind,
        { status: "error", source: "none", error: message, stale: false },
        id,
        source,
      );
      log(`${labels.load}: ${message}`);
      throw error;
    }
  };

  const loadDetail = (
    kind: "album" | "artist",
    id: string,
    source: MusicSource = "library",
    options: DetailLoadOptions = {},
  ): Promise<void> =>
    loadDetailResource(kind, id, source, options, async (client, isCurrent) => {
      const raw = await libraryMethod(
        client,
        `get${kind[0].toUpperCase()}${kind.slice(1)}`,
      )(id, source);
      if (!isCurrent()) return undefined;
      const detail = detailFromResponse(raw);
      if (!detail.item && detail.items.length > 0) {
        detail.item = detail.items[0];
        detail.items = detail.items.slice(1);
      }
      if (kind === "album" && detail.items.length === 0) {
        detail.items = await loadAlbumTracks(client, id, source);
        if (!isCurrent()) return undefined;
      }
      if (kind === "artist" && detail.items.length === 0) {
        try {
          detail.items = await loadArtistAlbums(id, source, detail.item?.name);
        } catch (error) {
          log(`Artist album expansion failed: ${safeErrorMessage(error)}`);
        }
        if (!isCurrent()) return undefined;
      }
      return detail;
    });

  const loadPlaylist = (
    id: string,
    source: MusicSource = "library",
    options: DetailLoadOptions = {},
  ): Promise<void> =>
    loadDetailResource("playlist", id, source, options, async (client) => {
      const [playlistRaw, tracksRaw] = await Promise.all([
        libraryMethod(client, "getPlaylist")(id, source),
        source === "catalog"
          ? libraryMethod(client, "getPlaylistTracks")(id, source)
          : libraryMethod(client, "getPlaylistTracks")(id),
      ]);
      const detail = detailFromResponse(playlistRaw);
      const tracks = asLibraryEntities(tracksRaw);
      if (!detail.item && detail.items.length > 0) {
        detail.item = detail.items[0];
      }
      return {
        item: detail.item,
        items: tracks.length > 0 ? tracks : detail.items.slice(1),
        next: asNext(tracksRaw) ?? detail.next,
      };
    });

  const loadPlaylistFolder = async (id?: string): Promise<void> => {
    const client = requireLibrary();
    const section = `playlist-folder:${id ?? "root"}`;
    setLibraryDetailState("playlistFolder", {
      status: "loading",
      error: undefined,
    });
    try {
      const raw = id
        ? await libraryMethod(client, "getPlaylistFolder")(id)
        : await libraryMethod(client, "getRootPlaylistFolder")();
      const detail = detailFromResponse(raw);
      const items = flattenFolderChildren(raw);
      const updatedAt = now();
      await ensureLibraryCache();
      try {
        await libraryCache.clearSection(LIBRARY_CACHE_SCOPE, section);
        await libraryCache.writePage(LIBRARY_CACHE_SCOPE, section, {
          items: detail.item ? [detail.item, ...items] : items,
          updatedAt,
        });
      } catch (cacheError) {
        log(
          `Playlist folder cache write failed: ${safeErrorMessage(cacheError)}`,
        );
      }
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
      try {
        await ensureLibraryCache();
        const cached = await libraryCache.readSection<LibraryEntity>(
          LIBRARY_CACHE_SCOPE,
          section,
        );
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
    refreshedSections.delete("playlists");
    try {
      await refreshLibrarySection("playlists");
      await loadPlaylistFolder();
      refreshedSections.add("playlists");
    } catch (error) {
      log(`${failureLabel}: ${safeErrorMessage(error)}`);
    }
  };

  return {
    client: (): AppleMusicLibraryClient | null => libraryClient,
    setClient(client: AppleMusicLibraryClient | null): void {
      libraryClient = client;
    },
    requireLibrary,
    ensureLibraryCache,
    clearLibraryCache,
    loadLibrarySection,
    loadMoreLibrarySection,
    refreshLibrarySection,
    loadHome,
    loadDetail,
    loadPlaylist,
    loadPlaylistFolder,
    refreshPlaylistsAfterMutation,
  };
}

export type LibraryLoader = ReturnType<typeof createLibraryLoader>;
