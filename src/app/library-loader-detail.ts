import {
  LIBRARY_PAGE_LIMIT,
  type AppleMusicLibraryClient,
} from "../musickit/library.ts";
import { LIBRARY_CACHE_SCOPE, type CachedPage } from "../library/cache.ts";
import type { MusicSource } from "../domain/music.ts";
import {
  getState,
  setLibraryDetailState,
  type LibraryEntity,
  type LibrarySection,
} from "../state.ts";
import {
  asLibraryEntities,
  asNext,
  detailCacheSection,
  detailFromResponse,
  detailRequestKey,
  libraryMethod,
  safeErrorMessage,
} from "./controller-support.ts";
import {
  OFFLINE_MESSAGE,
  cachedDetailPatch,
  detailChildren,
  detailLabels,
  followableCursor,
  type DetailKind,
  type DetailLoadOptions,
  type DetailRequests,
  type LibraryLoaderDeps,
} from "./library-loader-helpers.ts";

/**
 * Upper bound for one detail list. The native cache takes at most 10,000
 * entries per page, and the playlist or album record itself takes one.
 */
const MAX_DETAIL_ITEMS = 9_999;

interface DetailResult {
  item?: LibraryEntity;
  items: LibraryEntity[];
  next?: string;
}

export interface DetailLoaderDeps extends LibraryLoaderDeps {
  detailRequests: DetailRequests;
  loadLibrarySection: (section: LibrarySection) => Promise<void>;
}

export function createDetailLoader(deps: DetailLoaderDeps) {
  const {
    context,
    cache,
    requireLibrary,
    requireMusicClient,
    isOffline,
    getLibraryClient,
    detailRequests,
    loadLibrarySection,
  } = deps;
  const { now, log } = context;
  const {
    libraryCache,
    isAccountGenerationCurrent,
    enqueueCacheMutation,
    ensureLibraryCache,
  } = cache;

  /** Cache-only detail read for offline mode; never touches the network. */
  const loadOfflineDetail = async (
    kind: DetailKind | "playlistFolder",
    cacheSection: string,
    id?: string,
    source?: MusicSource,
    isCurrent: () => boolean = () => true,
  ): Promise<void> => {
    await cache.awaitCacheReset();
    if (!isCurrent()) return;
    const cached = await libraryCache.readSection<LibraryEntity>(
      LIBRARY_CACHE_SCOPE,
      cacheSection,
    );
    if (!isCurrent()) return;
    if (!cached?.items.length) {
      setLibraryDetailState(
        kind,
        {
          status: "error",
          source: "none",
          error: OFFLINE_MESSAGE,
          stale: false,
        },
        id,
        source,
      );
      return;
    }
    setLibraryDetailState(
      kind,
      kind === "playlistFolder"
        ? {
            status: "success",
            source: "cache",
            item: cached.items[0],
            items: cached.items.slice(1),
            lastUpdatedAt: cached.updatedAt,
            stale: true,
          }
        : cachedDetailPatch(kind, cached, undefined),
      id,
      source,
    );
  };
  /** The one album-track path: the client builds it, for every caller. */
  const loadAlbumTracks = async (
    client: AppleMusicLibraryClient,
    id: string,
    source: MusicSource,
    cursor?: string,
  ): Promise<{ items: LibraryEntity[]; next?: string }> => {
    const page = await client.getAlbumTracks(id, source, {
      cursor,
      limit: LIBRARY_PAGE_LIMIT,
    });
    return { items: asLibraryEntities(page), next: asNext(page) };
  };

  /**
   * `first` is the artist's views page when the artist request carried it;
   * the rest is requested through the same `next` path.
   */
  const loadArtistAlbums = async (
    id: string,
    source: MusicSource,
    artistName: unknown,
    first?: { items: unknown[]; next?: string },
  ): Promise<LibraryEntity[]> => {
    const client = getLibraryClient();
    // Test and preview clients may not implement the relationship.
    if (client && typeof client.getArtistAlbums === "function") {
      // The artist's own albums relationship lists every album, not just
      // those on the first loaded page of the whole library.
      const albums: LibraryEntity[] = [];
      let cursor: string | undefined;
      try {
        const seen = new Set<string>();
        let loaded = first;
        do {
          // Apple pages an artist's albums (25 at a time in the catalog).
          const page =
            loaded ?? (await client.getArtistAlbums(id, cursor, source));
          loaded = undefined;
          albums.push(...asLibraryEntities(page));
          cursor = followableCursor(asNext(page));
          if (cursor && seen.has(cursor)) break;
          if (cursor) seen.add(cursor);
        } while (cursor && albums.length < MAX_DETAIL_ITEMS);
        return albums;
      } catch (error) {
        const failed = cursor?.split("?", 1)[0] ?? `${source} artist albums`;
        log(
          `Artist albums request failed (${failed}): ${safeErrorMessage(error)}`,
        );
        // A later page failed: keep the albums already loaded.
        if (albums.length > 0) return albums;
        // Fall back to the loaded library so a failed relationship request
        // does not leave the artist with no albums.
      }
    }
    // A catalog artist is not in the library, so the library holds none of
    // its albums to fall back on.
    if (source === "catalog") return [];
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
   * Loads the pages after the first, so long playlists and albums list every
   * song. `onPage` shows each page as it arrives; without it the result is
   * returned in one piece. Resolves undefined once a newer load replaced it.
   */
  const loadRemainingDetailPages = async (
    kind: DetailKind,
    id: string,
    source: MusicSource,
    first: { item?: LibraryEntity; items: LibraryEntity[]; next: string },
    fetchPage: (
      cursor: string,
    ) => Promise<{ items: LibraryEntity[]; next?: string }>,
    isCurrent: () => boolean,
    onPage?: (items: LibraryEntity[], next: string | undefined) => void,
  ): Promise<
    { items: LibraryEntity[]; next?: string; failed?: string } | undefined
  > => {
    const generation = cache.currentGeneration();
    const cacheSection = detailCacheSection(kind, id, source);
    const cursors = new Set<string>();
    let items = first.items;
    let cursor: string | undefined = followableCursor(first.next);
    let failure: string | undefined;
    while (cursor && items.length < MAX_DETAIL_ITEMS) {
      if (cursors.has(cursor)) {
        log(`Detail paging stopped: Apple Music repeated a ${kind} page.`);
        break;
      }
      cursors.add(cursor);
      let page: { items: LibraryEntity[]; next?: string };
      try {
        page = await fetchPage(cursor);
      } catch (error) {
        failure = safeErrorMessage(error);
        log(`Loading more ${kind} songs failed: ${failure}`);
        break;
      }
      if (!isCurrent()) return undefined;
      // One new array per page; the earlier items keep their identity.
      const merged = [...items, ...page.items];
      items =
        merged.length > MAX_DETAIL_ITEMS
          ? merged.slice(0, MAX_DETAIL_ITEMS)
          : merged;
      cursor = followableCursor(page.next);
      onPage?.(items, cursor);
    }
    if (!isCurrent()) return undefined;
    // A partial refresh must not replace the cache or the list already shown.
    if (failure) return { items, next: cursor, failed: failure };
    try {
      await ensureLibraryCache(generation);
      if (!isCurrent()) return undefined;
      await enqueueCacheMutation(isCurrent, async () => {
        await libraryCache.clearSection(LIBRARY_CACHE_SCOPE, cacheSection);
        await libraryCache.writePage(LIBRARY_CACHE_SCOPE, cacheSection, {
          cursor: undefined,
          items: first.item ? [first.item, ...items] : items,
          next: cursor,
          updatedAt: now(),
        });
      });
    } catch (error) {
      log(`${detailLabels(kind).write}: ${safeErrorMessage(error)}`);
    }
    if (!isCurrent()) return undefined;
    return { items, next: cursor };
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
    fetchMore?: (
      client: AppleMusicLibraryClient,
      cursor: string,
    ) => Promise<{ items: LibraryEntity[]; next?: string }>,
  ): Promise<void> => {
    const generation = cache.currentGeneration();
    const isAccountCurrent = (): boolean =>
      isAccountGenerationCurrent(generation);
    if (isOffline()) {
      await loadOfflineDetail(
        kind,
        detailCacheSection(kind, id, source),
        id,
        source,
        isAccountCurrent,
      );
      return;
    }
    const client =
      source === "library" ? requireLibrary() : requireMusicClient();
    const cacheSection = detailCacheSection(kind, id, source);
    const requestKey = detailRequestKey(kind, id, source);
    const requestId = detailRequests.begin(requestKey);
    const isCurrent = (): boolean =>
      isAccountCurrent() && detailRequests.isLatest(requestKey, requestId);
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
        await ensureLibraryCache(generation);
        if (!isAccountCurrent()) return;
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
      // The cache still supplies the previous list while the refresh runs, so
      // a failed later page can keep showing it instead of a partial first page.
      try {
        await ensureLibraryCache(generation);
        if (!isAccountCurrent()) return;
        const cached = await libraryCache.readSection<LibraryEntity>(
          LIBRARY_CACHE_SCOPE,
          cacheSection,
        );
        if (isCurrent() && cached?.items.length) stalePage = cached;
      } catch (error) {
        log(`${labels.read}: ${safeErrorMessage(error)}`);
      }
    }
    if (!isAccountCurrent()) return;
    try {
      const detail = await fetchDetail(client, isCurrent);
      if (!detail || !isCurrent()) return;
      const page: CachedPage<LibraryEntity> = {
        cursor: undefined,
        items: detail.item ? [detail.item, ...detail.items] : detail.items,
        next: followableCursor(detail.next),
        updatedAt: now(),
      };
      const morePages = Boolean(fetchMore && page.next);
      // A cached full list stays on screen while every page reloads, so a
      // revisit never collapses to the first page and jumps the scroll.
      const quiet = morePages && Boolean(stalePage?.items.length);
      if (!morePages) {
        await ensureLibraryCache(generation);
        if (!isCurrent()) return;
        try {
          await enqueueCacheMutation(isCurrent, async () => {
            await libraryCache.clearSection(LIBRARY_CACHE_SCOPE, cacheSection);
            await libraryCache.writePage(
              LIBRARY_CACHE_SCOPE,
              cacheSection,
              page,
            );
          });
        } catch (error) {
          log(`${labels.write}: ${safeErrorMessage(error)}`);
        }
      }
      if (!isCurrent()) return;
      const publish = (
        items: LibraryEntity[],
        next: string | undefined,
      ): void =>
        setLibraryDetailState(
          kind,
          {
            status: "success",
            source: "network",
            item: detail.item,
            resource: detail.item,
            items,
            ...detailChildren(kind, items),
            next,
            lastUpdatedAt: page.updatedAt,
            stale: false,
            error: undefined,
          },
          id,
          source,
        );
      if (!quiet) publish(detail.items, page.next);
      if (fetchMore && page.next) {
        const all = await loadRemainingDetailPages(
          kind,
          id,
          source,
          { item: detail.item, items: detail.items, next: page.next },
          (cursor) => fetchMore(client, cursor),
          isCurrent,
          quiet ? undefined : publish,
        );
        if (!all) return;
        if (all.failed) {
          // The pages already on screen stay; the error note explains why the
          // full refresh stopped and the cache keeps its last complete list.
          setLibraryDetailState(
            kind,
            stalePage?.items.length
              ? cachedDetailPatch(kind, stalePage, all.failed)
              : { error: all.failed },
            id,
            source,
          );
          return;
        }
        publish(all.items, all.next);
      }
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
        await ensureLibraryCache(generation);
        if (!isCurrent()) return;
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
    loadDetailResource(
      kind,
      id,
      source,
      options,
      async (client, isCurrent) => {
        // An album response can carry its first track page; the track
        // request below then runs only when that page is missing or partial.
        const album =
          kind === "album"
            ? await client.getAlbumDetail(id, source)
            : undefined;
        // An artist response can carry the page's shelves and first albums.
        // Test and preview clients may lack the method and use the plain read.
        const artist =
          kind === "artist" && typeof client.getArtistDetail === "function"
            ? await client.getArtistDetail(id, source)
            : undefined;
        const raw =
          album !== undefined
            ? album.item
            : artist !== undefined
              ? artist.item
              : await libraryMethod(
                  client,
                  `get${kind.charAt(0).toUpperCase()}${kind.slice(1)}`,
                )(id, source);
        if (!isCurrent()) return undefined;
        const detail = detailFromResponse(raw);
        if (!detail.item && detail.items.length > 0) {
          detail.item = detail.items[0];
          detail.items = detail.items.slice(1);
        }
        if (kind === "album" && detail.items.length === 0) {
          const tracks = album?.firstTracks
            ? { items: asLibraryEntities(album.firstTracks), next: undefined }
            : await loadAlbumTracks(client, id, source);
          detail.items = tracks.items;
          detail.next = tracks.next;
          if (!isCurrent()) return undefined;
        }
        if (kind === "artist" && detail.items.length === 0) {
          try {
            detail.items = await loadArtistAlbums(
              id,
              source,
              detail.item?.name,
              artist?.albums,
            );
          } catch (error) {
            log(`Artist album expansion failed: ${safeErrorMessage(error)}`);
          }
          if (!isCurrent()) return undefined;
        }
        return detail;
      },
      kind === "album"
        ? (client, cursor) => loadAlbumTracks(client, id, source, cursor)
        : undefined,
    );

  const loadPlaylist = (
    id: string,
    source: MusicSource = "library",
    options: DetailLoadOptions = {},
  ): Promise<void> =>
    loadDetailResource(
      "playlist",
      id,
      source,
      options,
      async (client) => {
        // A catalog playlist response can carry its first track page; only
        // when that page is missing or partial are tracks requested. Library
        // playlists keep the two requests in parallel.
        const catalog =
          source === "catalog"
            ? await client.getPlaylistDetail(id, source)
            : undefined;
        const [playlistRaw, tracksRaw] = await Promise.all([
          catalog
            ? catalog.item
            : libraryMethod(client, "getPlaylist")(id, source),
          catalog?.firstTracks ??
            libraryMethod(client, "getPlaylistTracks")(
              id,
              { limit: LIBRARY_PAGE_LIMIT },
              source,
            ),
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
      },
      async (client, cursor) => {
        const raw = await libraryMethod(client, "getPlaylistTracks")(
          id,
          { cursor, limit: LIBRARY_PAGE_LIMIT },
          source,
        );
        return { items: asLibraryEntities(raw), next: asNext(raw) };
      },
    );
  return { loadOfflineDetail, loadDetail, loadPlaylist };
}

export type DetailLoader = ReturnType<typeof createDetailLoader>;
