import {
  loadRadioStations,
  searchCatalogSongs,
  searchMusicResources,
} from "../musickit/catalog.ts";
import {
  BROWSE_PAGE_LIMIT,
  loadBrowseCharts,
  loadBrowseGenres,
  loadBrowseShelfPage,
  loadStationGenreStations,
  loadStationGenres,
  type BrowseCharts,
  type BrowseGenre,
  type BrowseShelfKind,
  type BrowseShelfResult,
} from "../musickit/browse.ts";
import {
  SEARCH_GROUP_KINDS,
  SEARCH_OVERVIEW_LIMIT,
  SEARCH_PAGE_LIMIT,
  loadSearchSuggestions,
  searchCatalog,
  searchCatalogPage,
  type CatalogSearchResult,
  type SearchGroupKind,
  type SearchPage,
} from "../musickit/search.ts";
import type { Track } from "../domain/music.ts";
import { safeNextPath } from "../musickit/response.ts";
import {
  getState,
  resetDiscoveryState,
  setBrowseState,
  setRadioState,
  setSearchState,
  type BrowseShelfPaging,
  type BrowseState,
  type SearchPagingState,
  type SearchResourceGroups,
} from "../state.ts";
import {
  safeErrorMessage,
  type ControllerContext,
} from "./controller-support.ts";

export interface DiscoveryDependencies {
  searchCatalogSongs?: typeof searchCatalogSongs;
  searchMusicResources?: typeof searchMusicResources;
  loadBrowseCharts?: typeof loadBrowseCharts;
  loadRadioStations?: typeof loadRadioStations;
}

type SearchSource = "catalog" | "library";

function emptySearchGroups(): SearchResourceGroups {
  return {
    songs: [],
    albums: [],
    artists: [],
    playlists: [],
    stations: [],
    curators: [],
    paging: {},
    status: "idle",
  };
}

/** Each group's next offset; a short first page means nothing more to load. */
function pagingFromCounts(
  counts: CatalogSearchResult["counts"],
): SearchResourceGroups["paging"] {
  const paging: SearchResourceGroups["paging"] = {};
  for (const kind of SEARCH_GROUP_KINDS) {
    paging[kind] = {
      status: counts[kind] < SEARCH_OVERVIEW_LIMIT ? "done" : "idle",
      offset: counts[kind],
    };
  }
  return paging;
}

function catalogGroups(result: CatalogSearchResult): SearchResourceGroups {
  return {
    songs: result.songs,
    albums: result.albums,
    artists: result.artists,
    playlists: result.playlists,
    stations: result.stations,
    curators: result.curators,
    top: result.top,
    paging: pagingFromCounts(result.counts),
    status: "success",
  };
}

/** Keeps the first copy of each id, so a page that overlaps is harmless. */
function mergeById<T extends { id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
): T[] {
  const seen = new Set(existing.map((item) => item.id));
  return [
    ...existing,
    ...incoming.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }),
  ];
}

function appendPage(
  groups: SearchResourceGroups,
  page: SearchPage,
): SearchResourceGroups {
  switch (page.kind) {
    case "songs":
      return { ...groups, songs: mergeById(groups.songs, page.items) };
    case "albums":
      return { ...groups, albums: mergeById(groups.albums, page.items) };
    case "artists":
      return { ...groups, artists: mergeById(groups.artists, page.items) };
    case "playlists":
      return { ...groups, playlists: mergeById(groups.playlists, page.items) };
    case "stations":
      return { ...groups, stations: mergeById(groups.stations, page.items) };
    case "curators":
      return { ...groups, curators: mergeById(groups.curators, page.items) };
  }
}

/** Apple cursors this app may follow; anything else ends the paging. */
const CATALOG_NEXT_PREFIXES = ["/v1/catalog/"] as const;

/**
 * Paging for a freshly loaded shelf: idle, with Apple's cursor if one came and
 * it points inside the catalog. An invalid cursor leaves the shelf with no more pages.
 */
function shelfPaging(page: { next?: string }): BrowseShelfPaging {
  const next = safeNextPath(page.next, CATALOG_NEXT_PREFIXES);
  return { status: "idle", ...(next ? { next } : {}) };
}

function pagingFromCharts(charts: BrowseCharts): BrowseState["paging"] {
  return {
    songs: shelfPaging(charts.songs),
    albums: shelfPaging(charts.albums),
    playlists: shelfPaging(charts.playlists),
    cityCharts: shelfPaging(charts.cityCharts),
    dailyCharts: shelfPaging(charts.dailyCharts),
  };
}

/** The shelf that a further page belongs to, with its first copies kept. */
function appendShelfPage(
  browse: BrowseState,
  page: BrowseShelfResult,
): Partial<BrowseState> {
  switch (page.kind) {
    case "songs":
      return { songs: mergeById(browse.songs, page.items) };
    case "albums":
      return { albums: mergeById(browse.albums, page.items) };
    case "playlists":
      return { playlists: mergeById(browse.playlists, page.items) };
    case "cityCharts":
      return { cityCharts: mergeById(browse.cityCharts, page.items) };
    case "dailyCharts":
      return { dailyCharts: mergeById(browse.dailyCharts, page.items) };
  }
}

/** Browse charts, radio shelves, and catalog/library search. */
export function createDiscovery(
  context: ControllerContext,
  dependencies: DiscoveryDependencies,
) {
  const { requireMusic, now, log } = context;
  const searchCatalogOverride = dependencies.searchCatalogSongs;
  const searchResources =
    dependencies.searchMusicResources ?? searchMusicResources;
  const browseCharts = dependencies.loadBrowseCharts ?? loadBrowseCharts;
  const radioStations = dependencies.loadRadioStations ?? loadRadioStations;
  let browseRequestId = 0;
  let radioRequestId = 0;
  let radioGenreRequestId = 0;
  let searchRequestId = 0;
  let suggestRequestId = 0;
  let lastSearchTracks: Track[] = [];
  let lastSearchSource: SearchSource = "catalog";

  /** Genre names are optional: without them the picker keeps "All genres". */
  const loadBrowseGenreList = async (
    instance: MusicKit.MusicKitInstance,
  ): Promise<BrowseGenre[] | undefined> => {
    try {
      return await loadBrowseGenres(instance);
    } catch (error) {
      log(`Browse genres failed: ${safeErrorMessage(error)}`);
      return undefined;
    }
  };

  const loadBrowse = async (
    options: { refresh?: boolean; genreId?: string } = {},
  ): Promise<void> => {
    const current = getState().browse;
    // "" is the All genres choice, so only an absent option keeps the genre.
    const genreId = options.genreId ?? current.genreId;
    const genreChanged = genreId !== current.genreId;
    if (!options.refresh && !genreChanged && current.status === "success") {
      return;
    }
    const requestId = ++browseRequestId;
    const hadCharts =
      current.songs.length > 0 ||
      current.albums.length > 0 ||
      current.playlists.length > 0;
    // A different genre starts with empty shelves, so its first load shows
    // skeletons rather than the previous genre's charts.
    setBrowseState({
      genreId,
      status: hadCharts && !genreChanged ? "refreshing" : "loading",
      ...(genreChanged
        ? {
            songs: [],
            albums: [],
            playlists: [],
            cityCharts: [],
            dailyCharts: [],
            paging: {},
          }
        : {}),
      error: undefined,
    });
    try {
      const instance = requireMusic();
      const [charts, genres] = await Promise.all([
        browseCharts(instance, { genreId, limit: BROWSE_PAGE_LIMIT }),
        current.genres.length
          ? Promise.resolve(undefined)
          : loadBrowseGenreList(instance),
      ]);
      // A response for an older genre, refresh, or account is dropped.
      if (requestId !== browseRequestId) return;
      setBrowseState({
        status: "success",
        genres: genres ?? getState().browse.genres,
        songs: charts.songs.items,
        albums: charts.albums.items,
        playlists: charts.playlists.items,
        cityCharts: charts.cityCharts.items,
        dailyCharts: charts.dailyCharts.items,
        paging: pagingFromCharts(charts),
        lastUpdatedAt: now(),
        error: undefined,
      });
    } catch (error) {
      if (requestId !== browseRequestId) return;
      const message = safeErrorMessage(error);
      setBrowseState({
        status: "error",
        error: message,
      });
      log(`Browse load failed: ${message}`);
      throw error;
    }
  };

  const loadRadio = async (
    options: { refresh?: boolean } = {},
  ): Promise<void> => {
    const current = getState().radio;
    if (!options.refresh && current.status === "success") return;
    const requestId = ++radioRequestId;
    const hadData =
      current.personal.items.length > 0 ||
      current.live.items.length > 0 ||
      current.recent.items.length > 0;
    setRadioState({
      status: hadData ? "refreshing" : "loading",
      personal: { ...current.personal, status: "loading", error: undefined },
      live: { ...current.live, status: "loading", error: undefined },
      recent: { ...current.recent, status: "loading", error: undefined },
      error: undefined,
    });
    const kinds = ["personal", "live", "recent"] as const;
    // Station genres are a separate, optional list: a failure keeps the shelf
    // hidden and does not count against the three station shelves.
    const genreLoad = current.genres.length
      ? Promise.resolve(undefined)
      : Promise.resolve()
          .then(() => loadStationGenres(requireMusic()))
          .catch((error: unknown) => {
            log(`Radio genres failed: ${safeErrorMessage(error)}`);
            return undefined;
          });
    const [results, genres] = await Promise.all([
      Promise.allSettled(
        kinds.map((kind) =>
          Promise.resolve().then(() => radioStations(requireMusic(), kind)),
        ),
      ),
      genreLoad,
    ]);
    if (requestId !== radioRequestId) return;
    let successCount = 0;
    const next = {
      personal: { ...current.personal },
      live: { ...current.live },
      recent: { ...current.recent },
    };
    results.forEach((result, index) => {
      const kind = kinds[index];
      if (!kind) return;
      if (result.status === "fulfilled") {
        successCount += 1;
        next[kind] = { status: "success", items: result.value };
      } else {
        next[kind] = {
          status: "error",
          items: current[kind].items,
          error: safeErrorMessage(result.reason),
        };
      }
    });
    const errors = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => safeErrorMessage(result.reason));
    setRadioState({
      ...next,
      genres: genres ?? current.genres,
      status: successCount > 0 ? "success" : "error",
      error: errors.length ? errors.join("; ") : undefined,
      lastUpdatedAt: successCount > 0 ? now() : current.lastUpdatedAt,
    });
    if (successCount === 0)
      throw new Error(errors.join("; ") || "Radio unavailable.");
    // A refresh also refreshes the station genre that is open.
    const openGenre = getState().radio.genreId;
    if (openGenre) void loadRadioGenre(openGenre);
  };

  /**
   * Stations of one station genre for the open Radio shelf. An empty id closes
   * it. Failures show inside the shelf, so this does not throw.
   */
  const loadRadioGenre = async (genreId: string): Promise<void> => {
    const requestId = ++radioGenreRequestId;
    const id = genreId.trim();
    if (!id) {
      setRadioState({
        genreId: "",
        genreStations: { status: "idle", items: [] },
      });
      return;
    }
    setRadioState({
      genreId: id,
      genreStations: { status: "loading", items: [] },
    });
    try {
      const items = await loadStationGenreStations(requireMusic(), id);
      if (requestId !== radioGenreRequestId) return;
      setRadioState({ genreStations: { status: "success", items } });
    } catch (error) {
      if (requestId !== radioGenreRequestId) return;
      const message = safeErrorMessage(error);
      setRadioState({
        genreStations: { status: "error", items: [], error: message },
      });
      log(`Radio genre load failed: ${message}`);
    }
  };

  /**
   * Appends the next page of one Browse shelf. The shelf's cursor is kept
   * until a page comes back without one; a shelf reload drops the response.
   */
  const loadMoreBrowseShelf = async (kind: BrowseShelfKind): Promise<void> => {
    const paging = getState().browse.paging[kind];
    if (!paging?.next || paging.status === "loading") return;
    const requestId = browseRequestId;
    // Re-checked where the cursor is followed; an invalid one ends the shelf.
    const next = safeNextPath(paging.next, CATALOG_NEXT_PREFIXES);
    if (!next) {
      setBrowseState({
        paging: {
          ...getState().browse.paging,
          [kind]: { status: "idle" },
        },
      });
      return;
    }
    const setPaging = (patch: BrowseShelfPaging): void => {
      setBrowseState({
        paging: { ...getState().browse.paging, [kind]: patch },
      });
    };
    setPaging({ ...paging, status: "loading", error: undefined });
    try {
      const page = await loadBrowseShelfPage(requireMusic(), kind, next);
      if (requestId !== browseRequestId) return;
      const browse = getState().browse;
      setBrowseState({
        ...appendShelfPage(browse, page),
        paging: { ...browse.paging, [kind]: shelfPaging(page) },
      });
    } catch (error) {
      if (requestId !== browseRequestId) return;
      const message = safeErrorMessage(error);
      setPaging({ ...paging, status: "error", error: message });
      log(`Browse ${kind} page failed: ${message}`);
    }
  };

  const setSearchSource = (source: SearchSource): void => {
    const search = getState().search;
    const groups = source === "catalog" ? search.catalog : search.library;
    lastSearchSource = source;
    lastSearchTracks = groups.songs;
    setSearchState({
      activeSource: source,
      results: groups.songs,
    });
  };

  const search = async (term: string): Promise<Track[]> => {
    const trimmed = term.trim();
    const requestId = ++searchRequestId;
    setSearchState({
      query: trimmed,
      status: trimmed ? "loading" : "idle",
      results: [],
      catalog: trimmed
        ? {
            ...getState().search.catalog,
            status: "loading",
            error: undefined,
            top: undefined,
            paging: {},
          }
        : emptySearchGroups(),
      library: trimmed
        ? {
            ...getState().search.library,
            status: "loading",
            error: undefined,
          }
        : emptySearchGroups(),
      error: undefined,
      requestId,
    });
    if (!trimmed) {
      lastSearchTracks = [];
      return [];
    }
    try {
      const instance = requireMusic();
      const catalogSearch: Promise<CatalogSearchResult> = searchCatalogOverride
        ? searchCatalogOverride(instance, trimmed, {
            limit: SEARCH_OVERVIEW_LIMIT,
          }).then((songs) => ({
            songs,
            albums: [],
            artists: [],
            playlists: [],
            stations: [],
            curators: [],
            counts: {
              songs: songs.length,
              albums: 0,
              artists: 0,
              playlists: 0,
              stations: 0,
              curators: 0,
            },
          }))
        : searchCatalog(instance, trimmed, { limit: SEARCH_OVERVIEW_LIMIT });
      const results = await Promise.allSettled([
        catalogSearch,
        searchResources(instance, trimmed, "library", {
          limit: SEARCH_OVERVIEW_LIMIT,
        }),
      ]);
      if (requestId !== searchRequestId) return [];
      const currentSearch = getState().search;
      // A user can switch source tabs while both requests are in flight.
      // Preserve that selection when the response settles instead of
      // restoring the tab that started the request.
      const selectedSource = currentSearch.activeSource;
      const catalog: SearchResourceGroups =
        results[0].status === "fulfilled"
          ? catalogGroups(results[0].value)
          : {
              ...currentSearch.catalog,
              status: "error",
              error: safeErrorMessage(results[0].reason),
              top: undefined,
              paging: {},
            };
      // The library source has no stations, curators, top result, or paging.
      const library: SearchResourceGroups =
        results[1].status === "fulfilled"
          ? {
              ...results[1].value,
              stations: [],
              curators: [],
              paging: {},
              status: "success",
            }
          : {
              ...currentSearch.library,
              stations: [],
              curators: [],
              paging: {},
              status: "error",
              error: safeErrorMessage(results[1].reason),
            };
      const groups = selectedSource === "catalog" ? catalog : library;
      const tracks = groups.songs;
      const successful = results.some(
        (result) => result.status === "fulfilled",
      );
      const providerErrors = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => safeErrorMessage(result.reason));
      lastSearchSource = selectedSource;
      lastSearchTracks = tracks;
      setSearchState({
        query: trimmed,
        status: successful ? "success" : "error",
        results: tracks,
        catalog,
        library,
        activeSource: selectedSource,
        error: successful ? undefined : providerErrors.join("; "),
        requestId,
      });
      log(`Found ${tracks.length} song${tracks.length === 1 ? "" : "s"}.`);
      return tracks;
    } catch (error) {
      if (requestId !== searchRequestId) return [];
      const message = safeErrorMessage(error);
      const currentSearch = getState().search;
      setSearchState({
        query: trimmed,
        status: "error",
        results: [],
        catalog: {
          ...currentSearch.catalog,
          status: "error",
          error: message,
        },
        library: {
          ...currentSearch.library,
          status: "error",
          error: message,
        },
        error: message,
        requestId,
      });
      log(`Search failed: ${message}`);
      return [];
    }
  };

  /**
   * Typeahead for the Search field. Only the newest response is kept, and
   * terms under two characters clear the list without a request.
   */
  const suggestSearch = async (term: string): Promise<void> => {
    const trimmed = term.trim();
    const requestId = ++suggestRequestId;
    const current = getState().search;
    if (trimmed.length < 2 || current.activeSource !== "catalog") {
      setSearchState({
        suggestions: { term: trimmed, status: "idle", items: [] },
      });
      return;
    }
    // Rows from the previous term stay up as stale while this one loads; the
    // loading status is what marks them stale in the view.
    setSearchState({
      suggestions: {
        term: trimmed,
        status: "loading",
        items: current.suggestions.items,
      },
    });
    try {
      const items = await loadSearchSuggestions(requireMusic(), trimmed);
      if (requestId !== suggestRequestId) return;
      setSearchState({
        suggestions: { term: trimmed, status: "success", items },
      });
    } catch {
      if (requestId !== suggestRequestId) return;
      setSearchState({
        suggestions: { term: trimmed, status: "error", items: [] },
      });
    }
  };

  /**
   * Appends the next "See all" page of one catalog group. Each group pages
   * from its own offset; a search that starts meanwhile drops the response.
   */
  const loadMoreSearch = async (kind: SearchGroupKind): Promise<void> => {
    const search = getState().search;
    const paging = search.catalog.paging[kind];
    if (
      search.activeSource !== "catalog" ||
      !paging ||
      paging.status === "loading" ||
      paging.status === "done"
    ) {
      return;
    }
    const requestId = searchRequestId;
    const term = search.query;
    const setPaging = (next: SearchPagingState): void => {
      const catalog = getState().search.catalog;
      setSearchState({
        catalog: { ...catalog, paging: { ...catalog.paging, [kind]: next } },
      });
    };
    setPaging({ ...paging, status: "loading", error: undefined });
    try {
      const page = await searchCatalogPage(
        requireMusic(),
        term,
        kind,
        paging.offset,
      );
      if (requestId !== searchRequestId) return;
      const next = appendPage(getState().search.catalog, page);
      const nextPaging: SearchPagingState = {
        status: page.count < SEARCH_PAGE_LIMIT ? "done" : "idle",
        offset: paging.offset + page.count,
      };
      setSearchState({
        catalog: {
          ...next,
          paging: { ...next.paging, [kind]: nextPaging },
        },
        ...(kind === "songs" ? { results: next.songs } : {}),
      });
      if (kind === "songs") lastSearchTracks = next.songs;
    } catch (error) {
      if (requestId !== searchRequestId) return;
      const message = safeErrorMessage(error);
      setPaging({ ...paging, status: "error", error: message });
      log(`Search ${kind} page failed: ${message}`);
    }
  };

  /** Tracks the play actions use for the current search source. */
  const searchTracks = (): Track[] =>
    lastSearchTracks.length
      ? lastSearchTracks
      : lastSearchSource === "catalog"
        ? getState().search.catalog.songs
        : getState().search.library.songs;

  return {
    loadBrowse,
    loadMoreBrowseShelf,
    loadRadio,
    loadRadioGenre,
    search,
    suggestSearch,
    loadMoreSearch,
    setSearchSource,
    searchTracks,
    lastSearchTracks: (): Track[] => lastSearchTracks,
    /**
     * Invalidates in-flight browse, radio, and search responses and forgets
     * search results. Runs on sign-out and authorization so a late response
     * cannot land in the next account's state.
     */
    resetAccount(): void {
      browseRequestId += 1;
      radioRequestId += 1;
      radioGenreRequestId += 1;
      searchRequestId += 1;
      suggestRequestId += 1;
      lastSearchTracks = [];
      resetDiscoveryState();
    },
  };
}
