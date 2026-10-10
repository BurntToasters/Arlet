import {
  loadBrowseCharts,
  loadRadioStations,
  searchCatalogSongs,
  searchMusicResources,
} from "../musickit/catalog.ts";
import type { Track } from "../domain/music.ts";
import {
  getState,
  resetDiscoveryState,
  setBrowseState,
  setRadioState,
  setSearchState,
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
  let searchRequestId = 0;
  let lastSearchTracks: Track[] = [];
  let lastSearchSource: SearchSource = "catalog";

  const loadBrowse = async (
    options: { refresh?: boolean } = {},
  ): Promise<void> => {
    const current = getState().browse;
    if (!options.refresh && current.status === "success") return;
    const requestId = ++browseRequestId;
    setBrowseState({
      status:
        current.songs.length ||
        current.albums.length ||
        current.playlists.length
          ? "refreshing"
          : "loading",
      error: undefined,
    });
    try {
      const result = await browseCharts(requireMusic(), { limit: 20 });
      if (requestId !== browseRequestId) return;
      setBrowseState({
        status: "success",
        songs: result.songs,
        albums: result.albums,
        playlists: result.playlists,
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
    const results = await Promise.allSettled(
      kinds.map((kind) =>
        Promise.resolve().then(() => radioStations(requireMusic(), kind)),
      ),
    );
    if (requestId !== radioRequestId) return;
    let successCount = 0;
    const next = {
      personal: { ...current.personal },
      live: { ...current.live },
      recent: { ...current.recent },
    };
    results.forEach((result, index) => {
      const kind = kinds[index];
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
      status: successCount > 0 ? "success" : "error",
      error: errors.length ? errors.join("; ") : undefined,
      lastUpdatedAt: successCount > 0 ? now() : current.lastUpdatedAt,
    });
    if (successCount === 0)
      throw new Error(errors.join("; ") || "Radio unavailable.");
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
          }
        : {
            songs: [],
            albums: [],
            artists: [],
            playlists: [],
            status: "idle",
          },
      library: trimmed
        ? {
            ...getState().search.library,
            status: "loading",
            error: undefined,
          }
        : {
            songs: [],
            albums: [],
            artists: [],
            playlists: [],
            status: "idle",
          },
      error: undefined,
      requestId,
    });
    if (!trimmed) {
      lastSearchTracks = [];
      return [];
    }
    try {
      const instance = requireMusic();
      const catalogSearch = searchCatalogOverride
        ? searchCatalogOverride(instance, trimmed, { limit: 10 }).then(
            (songs) => ({
              songs,
              albums: [],
              artists: [],
              playlists: [],
            }),
          )
        : searchResources(instance, trimmed, "catalog", { limit: 10 });
      const results = await Promise.allSettled([
        catalogSearch,
        searchResources(instance, trimmed, "library", { limit: 10 }),
      ]);
      if (requestId !== searchRequestId) return [];
      const currentSearch = getState().search;
      // A user can switch source tabs while both requests are in flight.
      // Preserve that selection when the response settles instead of
      // restoring the tab that started the request.
      const selectedSource = currentSearch.activeSource;
      const catalog =
        results[0].status === "fulfilled"
          ? { ...results[0].value, status: "success" as const }
          : {
              ...currentSearch.catalog,
              status: "error" as const,
              error: safeErrorMessage(results[0].reason),
            };
      const library =
        results[1].status === "fulfilled"
          ? { ...results[1].value, status: "success" as const }
          : {
              ...currentSearch.library,
              status: "error" as const,
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

  /** Tracks the play actions use for the current search source. */
  const searchTracks = (): Track[] =>
    lastSearchTracks.length
      ? lastSearchTracks
      : lastSearchSource === "catalog"
        ? getState().search.catalog.songs
        : getState().search.library.songs;

  return {
    loadBrowse,
    loadRadio,
    search,
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
      searchRequestId += 1;
      lastSearchTracks = [];
      resetDiscoveryState();
    },
  };
}
