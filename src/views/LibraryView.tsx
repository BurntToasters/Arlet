import { Music2, RefreshCw, SearchX } from "lucide-preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  useAppController,
  useAppRouter,
  useAppSelector,
  useAppSlices,
} from "../app/context.tsx";
import { nearestTrackIndex } from "../app/queue-window.ts";
import { ratingKeyOf, requestRatings } from "../app/ratings.ts";
import { LibraryToolbar } from "../components/LibraryToolbar.tsx";
import { OfflineBanner } from "../components/OfflineBanner.tsx";
import { SelectionBar } from "../components/SelectionBar.tsx";
import { useTrackSelection } from "../components/track-selection.ts";
import { VirtualGrid } from "../components/VirtualGrid.tsx";
import { VirtualList } from "../components/VirtualList.tsx";
import type { Track } from "../domain/music.ts";
import {
  isActive,
  libraryViewCapabilities,
  loadViewOptions,
  saveViewOptions,
  type LibraryViewOptions,
} from "../library/view-options.ts";
import type { LibrarySection } from "../routing/router.ts";
import {
  arrangeResources,
  ratingKeyFor,
  ratingTargetOf,
} from "./library-view-arrange.ts";
import { LibraryTrackRow, ResourceCard } from "./library-view-cards.tsx";
import {
  toResource,
  toTrack,
  type ResourceLike,
} from "./library-view-convert.ts";
import { CollectionFeedback } from "./library-view-feedback.tsx";
import {
  NO_ITEMS,
  readCollection,
  readPlaylistFolderItems,
} from "./library-view-read.ts";
import { PlaylistTree } from "./library-view-playlists.tsx";
import {
  act,
  formatUpdated,
  run,
  SECTION_COPY,
} from "./library-view-shared.ts";
import { EmptyState } from "./EmptyState.tsx";

export type { CollectionLike, ResourceLike } from "./library-view-convert.ts";
export { toResource, toTrack } from "./library-view-convert.ts";
export { readCollection, readDetail } from "./library-view-read.ts";
export { LibraryTrackRow } from "./library-view-cards.tsx";

interface LibraryViewState {
  options: LibraryViewOptions;
  text: string;
}

function initialViewState(section: LibrarySection): LibraryViewState {
  return { options: loadViewOptions(section), text: "" };
}

export function LibraryView({
  section,
}: {
  section: LibrarySection;
}): JSX.Element {
  const state = useAppSlices("auth", "initialization", "library");
  const controller = useAppController();
  const router = useAppRouter();
  const loadMoreTrigger = useRef<HTMLButtonElement>(null);
  // Toolbar state per section, for this session. Sections that have no
  // toolbar read the defaults.
  const [viewStates, setViewStates] = useState<
    Partial<Record<LibrarySection, LibraryViewState>>
  >({});
  // Keys whose last favorites lookup failed; they stop the filter waiting.
  const [ratingFailures, setRatingFailures] = useState<
    Partial<Record<LibrarySection, ReadonlySet<string>>>
  >({});
  const ratings = useAppSelector((store) => store.ratings);
  const copy = SECTION_COPY[section];
  const capabilities = libraryViewCapabilities(section);
  const view = useMemo(
    () => viewStates[section] ?? initialViewState(section),
    [viewStates, section],
  );
  const { options, text } = view;
  const collection = readCollection(state, section);
  const authorized =
    state.auth.status === "authorized" &&
    state.initialization.status === "ready";
  const offline = state.library.offline;
  const canView = authorized || offline;
  const canAutoLoad = authorized && !offline;
  const folderItems =
    section === "playlists" ? readPlaylistFolderItems(state) : NO_ITEMS;
  // Rebuilt only when the stored items change; converted items are cached,
  // so an appended page converts just its own rows.
  const resources = useMemo(() => {
    const items = [...folderItems, ...collection.items]
      .map(toResource)
      .filter((resource): resource is ResourceLike => Boolean(resource));
    const seen = new Set<string>();
    return items.filter((resource) => {
      if (seen.has(resource.id)) return false;
      seen.add(resource.id);
      return true;
    });
  }, [collection.items, folderItems]);
  const controlsActive = capabilities !== undefined && isActive(options, text);
  const favoritesOn = controlsActive && options.favorites;
  // The list in the order and subset the controls show. With no control
  // active, it is the stored order, as before the toolbar.
  const visibleResources = useMemo(
    () =>
      controlsActive
        ? arrangeResources(resources, section, options, text, ratings)
        : resources,
    [controlsActive, resources, section, options, text, ratings],
  );
  const visibleCount = visibleResources.filter(
    (resource) => !resource.isFolder,
  ).length;
  const totalCount = resources.filter((resource) => !resource.isFolder).length;
  const failedRatings = ratingFailures[section];
  const favoritesPending =
    favoritesOn &&
    canAutoLoad &&
    resources.some((resource) => {
      const key = resource.isFolder
        ? undefined
        : ratingKeyFor(resource, section);
      return (
        key !== undefined &&
        ratings[key] === undefined &&
        !failedRatings?.has(key)
      );
    });
  const favoritesFailed =
    favoritesOn && canAutoLoad && Boolean(failedRatings?.size);
  const loadingAll =
    controlsActive &&
    canAutoLoad &&
    Boolean(collection.next) &&
    collection.status === "loading";
  const noMatches =
    controlsActive &&
    totalCount > 0 &&
    visibleCount === 0 &&
    !loadingAll &&
    !favoritesPending;
  const status = loadingAll
    ? `Loading full library… ${collection.items.length} loaded`
    : favoritesPending
      ? "Checking favorites…"
      : favoritesFailed
        ? "Could not check favorites"
        : undefined;

  const { recentCards, trackResources } = useMemo(() => {
    if (section !== "recent") {
      return {
        recentCards: [] as ResourceLike[],
        trackResources: visibleResources,
      };
    }
    const cards = visibleResources.filter((resource) =>
      ["album", "artist", "playlist"].some((kind) =>
        resource.type?.includes(kind),
      ),
    );
    const cardSet = new Set(cards);
    return {
      recentCards: cards,
      trackResources: visibleResources.filter(
        (resource) => !cardSet.has(resource),
      ),
    };
  }, [visibleResources, section]);
  const loadedTracks = useMemo(
    () =>
      trackResources
        .map(toTrack)
        .filter((item): item is Track => Boolean(item)),
    [trackResources],
  );
  const selection = useTrackSelection(loadedTracks, section);

  useEffect(() => {
    if (!canView) return;
    run(() => controller.loadLibrarySection(section));
    if (section === "playlists") {
      run(() => controller.loadPlaylistFolder());
    }
  }, [canView, controller, section]);

  useEffect(() => {
    // Filters and sorts need every page. After an error the loading stops, and
    // Load more or Refresh retries.
    if (
      !controlsActive ||
      !canAutoLoad ||
      !collection.next ||
      collection.status === "loading" ||
      collection.error
    ) {
      return;
    }
    run(() => controller.loadAllLibrarySection(section));
  }, [
    controlsActive,
    canAutoLoad,
    collection.next,
    collection.status,
    collection.error,
    controller,
    section,
  ]);

  useEffect(() => {
    if (!favoritesOn || !canAutoLoad) return undefined;
    const targets = resources
      .filter((resource) => !resource.isFolder)
      .map((resource) => ratingTargetOf(resource, section));
    if (!targets.length) return undefined;
    const keys = targets
      .map((target) => ratingKeyOf(target))
      .filter((key): key is string => key !== undefined);
    let current = true;
    // A retry shows the pending state again until it resolves or fails.
    setRatingFailures((failures) =>
      failures[section] === undefined
        ? failures
        : { ...failures, [section]: undefined },
    );
    run(async () => {
      let failedKeys: readonly string[];
      try {
        failedKeys = await requestRatings(targets);
      } catch {
        failedKeys = keys;
      }
      if (!current) return;
      const next = new Set(failedKeys);
      setRatingFailures((failures) => ({
        ...failures,
        [section]: next.size ? next : undefined,
      }));
    });
    return () => {
      current = false;
    };
  }, [favoritesOn, canAutoLoad, resources, section]);

  const patchView = (patch: Partial<LibraryViewState>): void => {
    setViewStates((current) => ({
      ...current,
      [section]: {
        ...(current[section] ?? initialViewState(section)),
        ...patch,
      },
    }));
  };
  // Options are saved here; text is session-only.
  const changeOptions = (next: LibraryViewOptions): void => {
    saveViewOptions(section, next);
    patchView({ options: next });
  };
  // Clears text, favorites and content. The sort stays.
  const clearFilters = (): void => {
    changeOptions({ ...options, favorites: false, content: "all" });
    patchView({ text: "" });
  };

  const retry = (): void => {
    run(() => controller.refreshLibrarySection(section));
  };
  const loadMore = (): void => {
    if (collection.next) {
      run(() =>
        controller.loadMoreLibrarySection(
          section,
          collection.next ?? undefined,
        ),
      );
    }
  };
  // The observer is rebuilt only when the list state changes; it calls the
  // latest loadMore, which is recreated on every render.
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  useEffect(() => {
    const target = loadMoreTrigger.current;
    if (
      !target ||
      !authorized ||
      // Load more is hidden while a control is active; every page loads anyway.
      controlsActive ||
      !collection.next ||
      collection.status === "loading" ||
      // After a failed page load the trigger is still visible; observing
      // again would retry in a tight loop. "Load more" stays the retry.
      collection.error ||
      typeof IntersectionObserver === "undefined"
    ) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMoreRef.current();
        }
      },
      { rootMargin: "180px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [
    authorized,
    controlsActive,
    collection.next,
    collection.status,
    collection.error,
    section,
  ]);
  // Like Apple Music: the clicked song plays first and the rest of the list
  // follows (the songs loaded so far; long queues continue as they play).
  const playTrack = (track: Track, index: number): void => {
    const tracks = trackResources
      .map(toTrack)
      .filter((item): item is Track => Boolean(item));
    const start = nearestTrackIndex(tracks, index, track.id);
    act(() =>
      start >= 0
        ? controller.playTracks(tracks, start)
        : controller.playTracks([track]),
    );
  };
  const updatedLabel = formatUpdated(collection.lastUpdatedAt);
  return (
    <>
      <div className="page-heading library-heading">
        <div>
          <span className="eyebrow">{copy.eyebrow}</span>
          <h1 tabIndex={-1}>{copy.title}</h1>
          <p className="library-description">{copy.description}</p>
        </div>
        <div className="library-heading-actions">
          {collection.source === "cache" ||
          collection.stale ||
          collection.isStale ? (
            <span className="library-source-badge">
              {offline ? "Cached" : "Cached · updating"}
            </span>
          ) : null}
          {updatedLabel ? (
            <span className="library-updated">{updatedLabel}</span>
          ) : null}
          <button
            className="icon-button"
            type="button"
            aria-label="Refresh library"
            onClick={retry}
            disabled={!authorized || collection.status === "loading"}
          >
            <RefreshCw
              aria-hidden="true"
              size={16}
              className={collection.status === "loading" ? "spin" : ""}
            />
          </button>
        </div>
      </div>

      {capabilities && canView ? (
        <LibraryToolbar
          key={section}
          title={copy.title}
          nameSort={section === "artists"}
          capabilities={capabilities}
          options={options}
          text={text}
          favoritesDisabled={!canAutoLoad}
          status={status}
          count={
            controlsActive ? `${visibleCount} of ${totalCount}` : undefined
          }
          onOptionsChange={changeOptions}
          onTextChange={(next) => patchView({ text: next })}
        />
      ) : null}

      {offline ? <OfflineBanner /> : null}
      {!canView ? (
        <EmptyState
          icon={Music2}
          title="Sign in to view your library"
          description="Connect your Apple Music account to sync playlists, albums, songs, and recent listening."
          action={
            <button
              className="primary-button"
              type="button"
              disabled={
                state.initialization.status !== "ready" ||
                state.auth.pending === true
              }
              onClick={() => act(controller.authorize)}
            >
              {state.auth.pending === true ? "Signing in…" : "Sign in"}
            </button>
          }
        />
      ) : (
        <>
          <CollectionFeedback
            collection={collection}
            section={section}
            onRetry={retry}
          />
          {noMatches ? (
            <EmptyState
              icon={SearchX}
              title="No matches"
              description="Nothing in this section matches the current filters."
              compact
              action={
                <button
                  className="secondary-button"
                  type="button"
                  data-library-clear
                  onClick={clearFilters}
                >
                  Clear filters
                </button>
              }
            />
          ) : null}
          {trackResources.length &&
          !["artists", "albums", "playlists"].includes(section) ? (
            <>
              <section
                className="library-list-panel"
                aria-label={copy.title}
                ref={selection.setPanel}
                onKeyDown={selection.onKeyDown}
              >
                <VirtualList
                  className="library-track-list"
                  items={trackResources}
                  getKey={(resource) => resource.id}
                  renderRow={(resource, index) => (
                    <LibraryTrackRow
                      resource={resource}
                      index={index}
                      onPlay={playTrack}
                      onPlayNext={(track) =>
                        act(() => controller.playNextTracks([track]))
                      }
                      disabled={!authorized}
                      selected={selection.isSelected(resource.id)}
                      onSelect={selection.handleClick}
                    />
                  )}
                />
              </section>
              <SelectionBar
                tracks={selection.tracks}
                onClear={selection.clear}
              />
            </>
          ) : null}
          {recentCards.length ? (
            <section
              className="library-card-grid"
              aria-label="Recently added collections"
            >
              {recentCards.map((resource) => {
                const kind = resource.type?.includes("artist")
                  ? "artist"
                  : resource.type?.includes("playlist")
                    ? "playlist"
                    : "album";
                return (
                  <ResourceCard
                    key={resource.id}
                    resource={resource}
                    kind={kind}
                    onOpen={() => router.navigate({ kind, id: resource.id })}
                  />
                );
              })}
            </section>
          ) : null}
          {visibleResources.length && section === "albums" ? (
            <section aria-label="Albums">
              <VirtualGrid
                className="library-card-grid"
                items={visibleResources}
                getKey={(resource) => resource.id}
                renderItem={(resource) => (
                  <ResourceCard
                    resource={resource}
                    kind="album"
                    onOpen={() =>
                      router.navigate({ kind: "album", id: resource.id })
                    }
                  />
                )}
              />
            </section>
          ) : null}
          {visibleResources.length && section === "artists" ? (
            <section aria-label="Artists">
              <VirtualGrid
                className="library-card-grid"
                items={visibleResources}
                getKey={(resource) => resource.id}
                renderItem={(resource) => (
                  <ResourceCard
                    resource={resource}
                    kind="artist"
                    onOpen={() =>
                      router.navigate({ kind: "artist", id: resource.id })
                    }
                  />
                )}
              />
            </section>
          ) : null}
          {visibleResources.length && section === "playlists" ? (
            <PlaylistTree
              resources={visibleResources}
              router={router}
              sort={options.sort}
              filtered={favoritesOn || text.trim().length > 0}
            />
          ) : null}
          {collection.error && collection.items.length ? (
            <p className="library-stale-note" role="status">
              Showing saved data. Refresh failed: {collection.error}
            </p>
          ) : null}
          {collection.next && !controlsActive ? (
            <button
              ref={loadMoreTrigger}
              className="secondary-button library-load-more"
              type="button"
              disabled={collection.status === "loading"}
              onClick={loadMore}
            >
              {collection.status === "loading" ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </>
      )}
    </>
  );
}
