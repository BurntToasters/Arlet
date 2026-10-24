import {
  AlertCircle,
  ArrowLeft,
  Disc3,
  ListMusic,
  LoaderCircle,
  Search as SearchIcon,
  UserRound,
} from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX, TargetedEvent } from "preact";
import {
  useAppController,
  useAppRouter,
  useAppSlices,
} from "../app/context.tsx";
import { Artwork } from "../components/Artwork.tsx";
import { SongRow } from "../components/SongRow.tsx";
import { CardActions, CardShell } from "../components/CardActions.tsx";
import { CuratorSearchTile, SearchTile } from "../components/SearchCards.tsx";
import {
  SearchSuggestions,
  type SearchSuggestionOption,
} from "../components/SearchSuggestions.tsx";
import { EmptyState } from "./EmptyState.tsx";
import type {
  Album,
  Artist,
  Artwork as ArtworkData,
  Playlist,
  Track,
} from "../domain/music.ts";
import { reportActionError } from "../components/action-errors.ts";
import {
  SEARCH_GROUP_KINDS,
  SEARCH_OVERVIEW_LIMIT,
  type SearchGroupKind,
  type SearchItem,
} from "../musickit/search.ts";
import {
  addRecentSearch,
  clearRecentSearches,
  removeRecentSearch,
} from "../state.ts";

export function trackContextData(track: Track): Record<string, string> {
  return {
    "data-context-kind": "track",
    "data-context-id": track.id,
    "data-context-title": track.title,
    "data-context-artist": track.artistName,
    ...(track.albumTitle ? { "data-context-album": track.albumTitle } : {}),
    ...(track.artwork?.url
      ? { "data-context-artwork": track.artwork.url }
      : {}),
    ...(track.resourceType
      ? { "data-context-resource-type": track.resourceType }
      : {}),
    ...(track.catalogId ? { "data-context-catalog-id": track.catalogId } : {}),
  };
}

export function TrackRow({
  track,
  index,
  onPlay,
  onPlayNext,
  disabled,
}: {
  track: Track;
  index: number;
  onPlay: () => void;
  onPlayNext?: () => void;
  disabled: boolean;
}): JSX.Element {
  return (
    <SongRow
      track={track}
      index={index}
      onPlay={onPlay}
      onPlayNext={onPlayNext}
      disabled={disabled}
      rowClassName="search-row"
      numberClassName="search-row-number"
      copyClassName="search-row-copy"
      durationClassName="search-row-duration"
      contextData={trackContextData(track)}
    />
  );
}

function itemTrack(item: Album | Artist | Playlist): Track {
  return {
    id: item.id,
    title: "name" in item ? item.name : item.title,
    artistName: "artistName" in item ? item.artistName : "Apple Music",
    artwork: item.artwork,
    resourceType: item.resourceType,
  };
}

/** Search tabs in display order; the panel below follows the active one. */
const SEARCH_SOURCES = [
  { id: "catalog", label: "Apple Music" },
  { id: "library", label: "Your Library" },
] as const;

const GROUP_TITLES: Record<SearchGroupKind, string> = {
  songs: "Songs",
  albums: "Albums",
  artists: "Artists",
  playlists: "Playlists",
  stations: "Stations",
  curators: "Curators",
};

/** Waits this long after a keystroke before asking for suggestions. */
const SUGGESTION_DELAY_MS = 150;
/** Waits this long after a keystroke before the results search runs. */
const SEARCH_DELAY_MS = 250;

interface PopupOption extends SearchSuggestionOption {
  run(): void;
}

function routeContextData(
  kind: "album" | "artist" | "playlist",
  id: string,
  title: string,
): Record<string, string> {
  return {
    "data-context-kind": kind,
    "data-context-id": id,
    "data-context-title": title,
    "data-context-route-kind": kind,
    "data-context-source": "catalog",
  };
}

/** Text, artwork, and context-menu data for a catalog result. */
function displayFor(item: SearchItem): {
  title: string;
  subtitle: string;
  kindLabel: string;
  artwork?: ArtworkData;
  catalogUrl?: string;
  contextData: Record<string, string>;
} {
  switch (item.kind) {
    case "songs":
      return {
        title: item.track.title,
        subtitle: item.track.artistName,
        kindLabel: "Song",
        artwork: item.track.artwork,
        catalogUrl: item.track.catalogUrl,
        contextData: trackContextData(item.track),
      };
    case "albums":
      return {
        title: item.album.title,
        subtitle: item.album.artistName,
        kindLabel: "Album",
        artwork: item.album.artwork,
        catalogUrl: item.album.catalogUrl,
        contextData: routeContextData("album", item.album.id, item.album.title),
      };
    case "artists":
      return {
        title: item.artist.name,
        subtitle: "Artist",
        kindLabel: "Artist",
        artwork: item.artist.artwork,
        catalogUrl: item.artist.catalogUrl,
        contextData: routeContextData(
          "artist",
          item.artist.id,
          item.artist.name,
        ),
      };
    case "playlists":
      return {
        title: item.playlist.name,
        subtitle: item.playlist.curatorName ?? "Playlist",
        kindLabel: "Playlist",
        artwork: item.playlist.artwork,
        catalogUrl: item.playlist.catalogUrl,
        contextData: routeContextData(
          "playlist",
          item.playlist.id,
          item.playlist.name,
        ),
      };
    case "stations":
      return {
        title: item.station.name,
        subtitle: item.station.isLive ? "Live radio" : "Station",
        kindLabel: "Station",
        artwork: item.station.artwork,
        contextData: {},
      };
    case "curators":
      return {
        title: item.curator.name,
        subtitle: "Curator",
        kindLabel: "Curator",
        artwork: item.curator.artwork,
        contextData: {},
      };
  }
}

function ResourceCard({
  item,
  kind,
  source,
  canPlay,
}: {
  item: Album | Artist | Playlist;
  kind: "album" | "artist" | "playlist";
  source: "catalog" | "library";
  canPlay: boolean;
}): JSX.Element {
  const router = useAppRouter();
  const controller = useAppController();
  const track = itemTrack(item);
  const title = track.title;
  const Icon =
    kind === "artist" ? UserRound : kind === "album" ? Disc3 : ListMusic;
  // Artists have no collection playback, so only albums and playlists get Play.
  const collectionKind = kind === "artist" ? undefined : kind;
  const playable = !("playable" in item && item.playable === false);
  return (
    <CardShell
      contextData={{
        "data-context-kind": kind,
        "data-context-id": item.id,
        "data-context-title": title,
        "data-context-route-kind": kind,
        "data-context-source": source,
      }}
      catalogUrl={item.catalogUrl}
    >
      <button
        className="home-discovery-card"
        type="button"
        onClick={() => router.navigate({ kind, id: item.id, source })}
      >
        <Artwork
          track={track}
          size="lg"
          alt={`${title} artwork`}
          className="home-discovery-art"
        />
        {track.artwork ? null : <Icon aria-hidden="true" />}
        <span className="home-discovery-copy">
          <strong title={title}>{title}</strong>
          <small>{track.artistName}</small>
        </span>
        <span className="home-discovery-source">
          {source === "library" ? "Library" : "Apple Music"}
        </span>
      </button>
      <CardActions
        title={title}
        onPlay={
          collectionKind && playable && canPlay
            ? () =>
                void Promise.resolve(
                  controller.playCollection(collectionKind, item.id, source, 0),
                ).catch(reportActionError)
            : undefined
        }
      />
    </CardShell>
  );
}

export function SearchView(): JSX.Element {
  const state = useAppSlices("auth", "initialization", "navigation", "search");
  const controller = useAppController();
  const router = useAppRouter();
  const routeQuery =
    state.navigation.kind === "search" ? state.navigation.query : "";
  const [term, setTerm] = useState(routeQuery);
  const [popupOpen, setPopupOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [expanded, setExpanded] = useState<SearchGroupKind | undefined>();
  const debounceTimer = useRef<number | undefined>(undefined);
  const suggestTimer = useRef<number | undefined>(undefined);
  // The term the last search ran for, so picking a suggestion does not
  // schedule the same search again after the debounce.
  const lastSearched = useRef("");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const source = state.search.activeSource;
  const groups =
    source === "catalog" ? state.search.catalog : state.search.library;
  const canPlay =
    state.initialization.status === "ready" &&
    state.auth.status === "authorized";
  const authorizationPending = state.auth.pending === true;
  const total =
    groups.songs.length +
    groups.albums.length +
    groups.artists.length +
    groups.playlists.length +
    groups.stations.length +
    groups.curators.length;
  const groupError = groups.status === "error";
  const trimmedTerm = term.trim();
  const suggesting = source === "catalog" && canPlay;

  const runSearch = (value: string): void => {
    const trimmed = value.trim();
    lastSearched.current = trimmed;
    setTerm(trimmed);
    setPopupOpen(false);
    setActiveIndex(-1);
    setExpanded(undefined);
    if (trimmed) addRecentSearch(trimmed);
    router.navigate({ kind: "search", query: trimmed });
    if (debounceTimer.current !== undefined) {
      window.clearTimeout(debounceTimer.current);
    }
    void controller.search(trimmed);
  };

  const playItem = (item: SearchItem): (() => void) | undefined => {
    if (!canPlay) return undefined;
    switch (item.kind) {
      case "songs":
        return item.track.playable === false
          ? undefined
          : () =>
              void controller.playTracks([item.track]).catch(reportActionError);
      case "albums":
        return item.album.playable === false
          ? undefined
          : () =>
              void Promise.resolve(
                controller.playCollection("album", item.album.id, "catalog", 0),
              ).catch(reportActionError);
      case "playlists":
        return () =>
          void Promise.resolve(
            controller.playCollection(
              "playlist",
              item.playlist.id,
              "catalog",
              0,
            ),
          ).catch(reportActionError);
      case "stations":
        return item.station.url
          ? () =>
              void Promise.resolve(controller.playStation(item.station)).catch(
                reportActionError,
              )
          : undefined;
      case "artists":
      case "curators":
        return undefined;
    }
  };

  /** Opens a result: albums, artists, and playlists navigate; songs and stations play. */
  const openItem = (item: SearchItem): void => {
    switch (item.kind) {
      case "albums":
        router.navigate({
          kind: "album",
          id: item.album.id,
          source: "catalog",
        });
        return;
      case "artists":
        router.navigate({
          kind: "artist",
          id: item.artist.id,
          source: "catalog",
        });
        return;
      case "playlists":
        router.navigate({
          kind: "playlist",
          id: item.playlist.id,
          source: "catalog",
        });
        return;
      case "songs":
      case "stations":
        playItem(item)?.();
        return;
      case "curators":
        router.navigate({
          kind: "curator",
          id: item.curator.id,
          curatorKind: "apple",
        });
        return;
    }
  };

  const popupOptions: PopupOption[] = [];
  if (suggesting && !trimmedTerm) {
    state.search.recent.forEach((recentTerm, index) => {
      popupOptions.push({
        id: `search-option-${index}`,
        label: recentTerm,
        recentTerm,
        run: () => runSearch(recentTerm),
      });
    });
  } else if (
    suggesting &&
    (state.search.suggestions.status === "success" ||
      state.search.suggestions.status === "loading")
  ) {
    // Rows for an earlier term stay up until the new reply lands; see stale.
    state.search.suggestions.items.forEach((suggestion, index) => {
      const id = `search-option-${index}`;
      if (suggestion.kind === "term") {
        popupOptions.push({
          id,
          label: suggestion.displayTerm,
          run: () => runSearch(suggestion.term),
        });
        return;
      }
      const display = displayFor(suggestion.item);
      popupOptions.push({
        id,
        label: display.title,
        detail:
          display.subtitle === display.kindLabel
            ? display.kindLabel
            : `${display.kindLabel} · ${display.subtitle}`,
        artwork: display.artwork,
        mediaKind: suggestion.item.kind,
        run: () => openItem(suggestion.item),
      });
    });
  }
  // Rows are stale while a reply is pending or the term has moved on.
  const suggestionsStale =
    suggesting &&
    trimmedTerm !== "" &&
    (state.search.suggestions.status === "loading" ||
      state.search.suggestions.term !== trimmedTerm);
  const popupVisible = popupOpen && popupOptions.length > 0;
  const activeOption = popupVisible ? popupOptions[activeIndex] : undefined;

  useEffect(() => {
    setTerm(routeQuery);
    setExpanded(undefined);
  }, [routeQuery]);

  useEffect(() => {
    const value = term.trim();
    if (!value) {
      lastSearched.current = "";
      return undefined;
    }
    if (value === lastSearched.current) return undefined;
    debounceTimer.current = window.setTimeout(() => {
      lastSearched.current = value;
      void controller.search(value);
    }, SEARCH_DELAY_MS);
    return () => {
      if (debounceTimer.current !== undefined) {
        window.clearTimeout(debounceTimer.current);
      }
    };
  }, [term, controller]);

  useEffect(() => {
    if (
      term.trim() ||
      (state.search.status === "idle" && state.search.results.length === 0)
    ) {
      return;
    }
    void controller.search("");
  }, [controller, state.search.results.length, state.search.status, term]);

  // A new suggestion list starts with nothing highlighted.
  useEffect(() => {
    setActiveIndex(-1);
  }, [state.search.suggestions]);

  // Switching source drops the catalog rows and cancels any request in flight.
  useEffect(() => {
    void controller.suggestSearch("");
  }, [source, controller]);

  useEffect(
    () => () => {
      if (suggestTimer.current !== undefined) {
        window.clearTimeout(suggestTimer.current);
      }
    },
    [],
  );

  const onTermInput = (value: string): void => {
    setTerm(value);
    setActiveIndex(-1);
    setPopupOpen(true);
    if (suggestTimer.current !== undefined) {
      window.clearTimeout(suggestTimer.current);
    }
    suggestTimer.current = window.setTimeout(() => {
      void controller.suggestSearch(value.trim());
    }, SUGGESTION_DELAY_MS);
  };

  const submit = (event: TargetedEvent<HTMLFormElement>): void => {
    event.preventDefault();
    runSearch(term);
  };

  const selectSource = (next: "catalog" | "library"): void => {
    controller.setSearchSource(next);
  };

  // Arrow keys, Home and End move and activate a tab, as in the tabs pattern.
  const onSourceTabKeyDown = (event: KeyboardEvent): void => {
    const current = SEARCH_SOURCES.findIndex((tab) => tab.id === source);
    const count = SEARCH_SOURCES.length;
    const next =
      event.key === "ArrowRight"
        ? (current + 1) % count
        : event.key === "ArrowLeft"
          ? (current - 1 + count) % count
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const tab = SEARCH_SOURCES[next];
    if (!tab) return;
    selectSource(tab.id);
    tabRefs.current[next]?.focus();
  };

  // Combobox keys: Up/Down move through the popup, Enter picks, Escape closes,
  // and Delete removes the active recent search. Other keys type as usual.
  const onSearchKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const count = popupOptions.length;
      if (!count) return;
      event.preventDefault();
      setPopupOpen(true);
      setActiveIndex(
        event.key === "ArrowDown"
          ? (activeIndex + 1) % count
          : activeIndex <= 0
            ? count - 1
            : activeIndex - 1,
      );
      return;
    }
    if (!popupVisible) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setPopupOpen(false);
      setActiveIndex(-1);
    } else if (event.key === "Enter" && activeOption) {
      event.preventDefault();
      activeOption.run();
    } else if (
      event.key === "Delete" &&
      activeOption?.recentTerm !== undefined
    ) {
      event.preventDefault();
      removeRecentSearch(activeOption.recentTerm);
      setActiveIndex(-1);
    }
  };

  const openSeeAll = (kind: SearchGroupKind): void => {
    setExpanded(kind);
    if (groups.paging[kind]?.status === "idle") {
      void controller.loadMoreSearch(kind);
    }
  };

  /** Rows or cards for one group; the overview caps it, See all does not. */
  const groupItems = (kind: SearchGroupKind, limit?: number): JSX.Element => {
    const shown = <T,>(items: T[]): T[] =>
      limit === undefined ? items : items.slice(0, limit);
    switch (kind) {
      case "songs":
        return (
          <ol className="search-results-list">
            {shown(groups.songs).map((track, index) => (
              <TrackRow
                key={track.id}
                track={track}
                index={index}
                disabled={!canPlay}
                onPlay={() =>
                  void controller.playFromSearch(index).catch(reportActionError)
                }
                onPlayNext={() =>
                  void controller
                    .playNextTracks([track])
                    .catch(reportActionError)
                }
              />
            ))}
          </ol>
        );
      case "albums":
        return (
          <div className="home-discovery-grid">
            {shown(groups.albums).map((item) => (
              <ResourceCard
                key={item.id}
                item={item}
                kind="album"
                source={source}
                canPlay={canPlay}
              />
            ))}
          </div>
        );
      case "artists":
        return (
          <div className="home-discovery-grid">
            {shown(groups.artists).map((item) => (
              <ResourceCard
                key={item.id}
                item={item}
                kind="artist"
                source={source}
                canPlay={canPlay}
              />
            ))}
          </div>
        );
      case "playlists":
        return (
          <div className="home-discovery-grid">
            {shown(groups.playlists).map((item) => (
              <ResourceCard
                key={item.id}
                item={item}
                kind="playlist"
                source={source}
                canPlay={canPlay}
              />
            ))}
          </div>
        );
      case "stations":
        return (
          <div className="home-discovery-grid">
            {shown(groups.stations).map((station) => {
              const play =
                canPlay && station.url
                  ? () =>
                      void Promise.resolve(
                        controller.playStation(station),
                      ).catch(reportActionError)
                  : undefined;
              return (
                <SearchTile
                  key={station.id}
                  title={station.name}
                  subtitle={
                    station.isLive
                      ? "Live radio"
                      : (station.description ?? "Station")
                  }
                  kindLabel="Station"
                  artwork={station.artwork}
                  onOpen={play}
                  onPlay={play}
                />
              );
            })}
          </div>
        );
      case "curators":
        return (
          <div className="home-discovery-grid">
            {shown(groups.curators).map((curator) => (
              <CuratorSearchTile key={curator.id} curator={curator} />
            ))}
          </div>
        );
    }
  };

  const groupSection = (kind: SearchGroupKind): JSX.Element | null => {
    if (!groups[kind].length) return null;
    const seeAll =
      source === "catalog" ? (
        <button
          className="search-see-all"
          type="button"
          aria-label={`See all ${GROUP_TITLES[kind].toLowerCase()}`}
          onClick={() => openSeeAll(kind)}
        >
          See all
        </button>
      ) : null;
    const heading = <h2 id={`search-${kind}-heading`}>{GROUP_TITLES[kind]}</h2>;
    if (kind === "songs") {
      return (
        <section
          className="search-results-panel"
          aria-labelledby="search-songs-heading"
        >
          <div className="results-toolbar">
            {heading}
            {seeAll}
          </div>
          {groupItems(kind, SEARCH_OVERVIEW_LIMIT)}
        </section>
      );
    }
    return (
      <section
        className="home-feed-section"
        aria-labelledby={`search-${kind}-heading`}
      >
        <div className="section-heading">
          {heading}
          {seeAll}
        </div>
        {groupItems(kind, SEARCH_OVERVIEW_LIMIT)}
      </section>
    );
  };

  const seeAllView = (kind: SearchGroupKind): JSX.Element => {
    const paging = groups.paging[kind];
    const count = groups[kind].length;
    return (
      <section
        className="search-see-all-view"
        aria-labelledby="search-see-all-heading"
      >
        <div className="section-heading search-see-all-heading">
          <button
            className="secondary-button"
            type="button"
            onClick={() => setExpanded(undefined)}
          >
            <ArrowLeft aria-hidden="true" size={16} /> Back to results
          </button>
          <h2 id="search-see-all-heading">{GROUP_TITLES[kind]}</h2>
        </div>
        {count ? groupItems(kind) : null}
        {paging?.status === "loading" ? (
          <div className="search-feedback" role="status">
            <LoaderCircle className="spin" size={22} /> Loading more…
          </div>
        ) : null}
        {paging?.status === "error" ? (
          <p className="library-stale-note" role="alert">
            More {GROUP_TITLES[kind].toLowerCase()} could not be loaded:{" "}
            {paging.error ?? "Try again in a moment."}
          </p>
        ) : null}
        {paging && (paging.status === "idle" || paging.status === "error") ? (
          <div className="search-see-all-more">
            <button
              className="secondary-button"
              type="button"
              onClick={() => void controller.loadMoreSearch(kind)}
            >
              Load more
            </button>
          </div>
        ) : null}
        {paging?.status === "done" ? (
          <p className="search-see-all-end">
            All {count} {GROUP_TITLES[kind].toLowerCase()} are shown.
          </p>
        ) : null}
      </section>
    );
  };

  const top = source === "catalog" ? groups.top : undefined;
  const topDisplay = top ? displayFor(top) : undefined;

  return (
    <>
      <div className="page-heading search-heading">
        <div>
          <span className="eyebrow">
            {source === "library" ? "Your Library" : "Apple Music"}
          </span>
          <h1 tabIndex={-1}>Search</h1>
        </div>
        {total ? <span className="search-count">{total} results</span> : null}
      </div>
      <form className="search-form" role="search" onSubmit={submit}>
        <SearchIcon aria-hidden="true" size={20} />
        <input
          aria-label={`Search ${source === "library" ? "your library" : "Apple Music"}`}
          role="combobox"
          // Preact types a combobox input as needing `list`; no datalist is used.
          list={undefined}
          aria-autocomplete="list"
          aria-controls="search-suggestions-list"
          aria-expanded={popupVisible}
          aria-activedescendant={activeOption?.id}
          type="search"
          value={term}
          placeholder="Artists, albums, songs, and more"
          onInput={(event) => onTermInput(event.currentTarget.value)}
          onFocus={() => setPopupOpen(true)}
          onBlur={() => {
            setPopupOpen(false);
            setActiveIndex(-1);
          }}
          onKeyDown={onSearchKeyDown}
        />
        {term ? (
          <button
            className="clear-search"
            type="button"
            aria-label="Clear search"
            onClick={() => {
              lastSearched.current = "";
              setTerm("");
              setActiveIndex(-1);
              router.navigate({ kind: "search", query: "" });
              void controller.search("");
            }}
          >
            ×
          </button>
        ) : null}
        <button className="search-submit" type="submit">
          Search
        </button>
        <SearchSuggestions
          listId="search-suggestions-list"
          heading={trimmedTerm ? "Suggestions" : "Recent searches"}
          open={popupVisible}
          options={popupOptions}
          activeIndex={activeIndex}
          stale={suggestionsStale}
          onSelect={(index) => popupOptions[index]?.run()}
          onRemoveRecent={(recent) => removeRecentSearch(recent)}
          onClearRecent={
            suggesting && !trimmedTerm
              ? () => {
                  clearRecentSearches();
                  setActiveIndex(-1);
                }
              : undefined
          }
        />
      </form>
      {state.auth.status !== "authorized" ? (
        <EmptyState
          icon={SearchIcon}
          title="Sign in to search Apple Music"
          description="Connect your Apple Music account to search and start playback."
          action={
            <button
              className="primary-button"
              type="button"
              disabled={
                state.initialization.status !== "ready" || authorizationPending
              }
              onClick={() =>
                void controller.authorize().catch(reportActionError)
              }
            >
              {authorizationPending ? "Signing in…" : "Sign in"}
            </button>
          }
        />
      ) : (
        <>
          <div
            className="search-source-tabs"
            role="tablist"
            aria-label="Search source"
            onKeyDown={onSourceTabKeyDown}
          >
            {SEARCH_SOURCES.map((tab, index) => {
              const selected = source === tab.id;
              return (
                <button
                  key={tab.id}
                  ref={(node) => {
                    tabRefs.current[index] = node;
                  }}
                  id={`search-source-tab-${tab.id}`}
                  className={selected ? "is-active" : ""}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls="search-source-panel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => selectSource(tab.id)}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
          <div
            id="search-source-panel"
            className="search-source-panel"
            role="tabpanel"
            tabIndex={0}
            aria-labelledby={`search-source-tab-${source}`}
          >
            {groupError && total === 0 ? (
              <EmptyState
                icon={AlertCircle}
                title="Search could not be completed"
                description={
                  groups.error ?? state.search.error ?? "Try again in a moment."
                }
                action={
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void controller.search(term)}
                  >
                    Try again
                  </button>
                }
              />
            ) : state.search.status === "loading" ? (
              <div className="search-feedback" role="status">
                <LoaderCircle className="spin" size={22} /> Searching Apple
                Music…
              </div>
            ) : total === 0 ? (
              <EmptyState
                icon={SearchIcon}
                title={term ? "No matches" : "Search Apple Music"}
                description={
                  term
                    ? `We couldn't find anything for “${state.search.query}”. Try another search.`
                    : "Find a song, artist, album, or playlist."
                }
                compact
              />
            ) : expanded && source === "catalog" ? (
              seeAllView(expanded)
            ) : (
              <div className="search-groups">
                {groupError ? (
                  <p className="library-stale-note" role="status">
                    Some {source === "library" ? "library" : "Apple Music"}{" "}
                    results could not be refreshed:{" "}
                    {groups.error ?? "Try again in a moment."}
                  </p>
                ) : null}
                {top && topDisplay ? (
                  <section
                    className="search-top-section"
                    aria-labelledby="search-top-heading"
                  >
                    <div className="section-heading">
                      <h2 id="search-top-heading">Top Result</h2>
                    </div>
                    <SearchTile
                      title={topDisplay.title}
                      subtitle={topDisplay.subtitle}
                      kindLabel={topDisplay.kindLabel}
                      artwork={topDisplay.artwork}
                      catalogUrl={topDisplay.catalogUrl}
                      contextData={topDisplay.contextData}
                      featured
                      menu={Object.keys(topDisplay.contextData).length > 0}
                      onOpen={() => openItem(top)}
                      onPlay={playItem(top)}
                    />
                  </section>
                ) : null}
                {SEARCH_GROUP_KINDS.map((kind) => groupSection(kind))}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
