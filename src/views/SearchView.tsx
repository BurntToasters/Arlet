import { AlertCircle, LoaderCircle, Search as SearchIcon } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX, TargetedEvent } from "preact";
import {
  useAppController,
  useAppRouter,
  useAppSlices,
} from "../app/context.tsx";
import { SearchSuggestions } from "../components/SearchSuggestions.tsx";
import { SearchTile } from "../components/SearchCards.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { reportActionError } from "../components/action-errors.ts";
import {
  SEARCH_GROUP_KINDS,
  type PagedSearchGroupKind,
  type SearchItem,
} from "../musickit/search.ts";
import {
  addRecentSearch,
  clearRecentSearches,
  removeRecentSearch,
} from "../state.ts";
import {
  SEARCH_DELAY_MS,
  SUGGESTION_DELAY_MS,
  displayFor,
  overviewHref,
  type PopupOption,
} from "./search-view-model.ts";
import type { SearchGroupsContext } from "./search-view-groups.tsx";
import {
  groupSection,
  overviewSection,
  seeAllView,
} from "./search-view-sections.tsx";
import { SearchSourceTabs } from "./search-view-tabs.tsx";

export { trackContextData } from "./search-view-model.ts";
export { TrackRow } from "./search-view-rows.tsx";

export function SearchView(): JSX.Element {
  const state = useAppSlices("auth", "initialization", "navigation", "search");
  const controller = useAppController();
  const router = useAppRouter();
  const routeQuery =
    state.navigation.kind === "search" ? state.navigation.query : "";
  const [term, setTerm] = useState(routeQuery);
  const [popupOpen, setPopupOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [expanded, setExpanded] = useState<PagedSearchGroupKind | undefined>();
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
    groups.curators.length +
    (groups.recordLabels?.length ?? 0) +
    (groups.activities?.length ?? 0);
  const groupError = groups.status === "error";
  const trimmedTerm = term.trim();
  const suggesting = source === "catalog" && canPlay;
  const groupsContext: SearchGroupsContext = {
    groups,
    source,
    canPlay,
    controller,
  };

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
      case "record-labels":
      case "activities":
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
      case "record-labels":
      case "activities": {
        // Hash routes, so the router's hashchange listener opens the page.
        const href = overviewHref(item);
        if (href) window.location.hash = href.slice(1);
        return;
      }
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

  const openSeeAll = (kind: PagedSearchGroupKind): void => {
    setExpanded(kind);
    if (groups.paging[kind]?.status === "idle") {
      void controller.loadMoreSearch(kind);
    }
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
          <SearchSourceTabs
            source={source}
            tabRefs={tabRefs}
            onSelect={selectSource}
          />
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
              seeAllView(groupsContext, expanded, () => setExpanded(undefined))
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
                      href={overviewHref(top)}
                      onOpen={() => openItem(top)}
                      onPlay={playItem(top)}
                    />
                  </section>
                ) : null}
                {SEARCH_GROUP_KINDS.map((kind) =>
                  groupSection(groupsContext, kind, openSeeAll),
                )}
                {overviewSection(groupsContext, "record-labels")}
                {overviewSection(groupsContext, "activities")}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
