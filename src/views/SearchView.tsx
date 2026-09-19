import {
  AlertCircle,
  Disc3,
  ListMusic,
  LoaderCircle,
  Search as SearchIcon,
  UserRound,
} from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  useAppController,
  useAppRouter,
  useAppState,
} from "../app/context.tsx";
import { Artwork } from "../components/Artwork.tsx";
import { SongRow } from "../components/SongRow.tsx";
import { EmptyState } from "./EmptyState.tsx";
import type { Album, Artist, Playlist, Track } from "../domain/music.ts";

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
      contextData={{
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
        ...(track.catalogId
          ? { "data-context-catalog-id": track.catalogId }
          : {}),
      }}
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

function ResourceCard({
  item,
  kind,
  source,
}: {
  item: Album | Artist | Playlist;
  kind: "album" | "artist" | "playlist";
  source: "catalog" | "library";
}): JSX.Element {
  const router = useAppRouter();
  const track = itemTrack(item);
  const title = track.title;
  const Icon =
    kind === "artist" ? UserRound : kind === "album" ? Disc3 : ListMusic;
  return (
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
  );
}

export function SearchView(): JSX.Element {
  const state = useAppState();
  const controller = useAppController();
  const router = useAppRouter();
  const routeQuery =
    state.navigation.kind === "search" ? state.navigation.query : "";
  const [term, setTerm] = useState(routeQuery);
  const debounceTimer = useRef<number | undefined>(undefined);
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
    groups.playlists.length;
  const groupError = groups.status === "error";

  useEffect(() => {
    setTerm(routeQuery);
  }, [routeQuery]);

  useEffect(() => {
    const value = term.trim();
    if (!value) return undefined;
    debounceTimer.current = window.setTimeout(() => {
      void controller.search(value);
    }, 250);
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

  const submit = (event: JSX.TargetedEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const value = term.trim();
    router.navigate({ kind: "search", query: value });
    if (debounceTimer.current !== undefined) {
      window.clearTimeout(debounceTimer.current);
    }
    void controller.search(value);
  };

  const selectSource = (next: "catalog" | "library"): void => {
    controller.setSearchSource?.(next);
  };

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
          type="search"
          value={term}
          placeholder="Artists, albums, songs, and more"
          onInput={(event) => setTerm(event.currentTarget.value)}
        />
        {term ? (
          <button
            className="clear-search"
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setTerm("");
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
              onClick={() => void controller.authorize().catch(() => undefined)}
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
          >
            <button
              className={source === "catalog" ? "is-active" : ""}
              type="button"
              role="tab"
              aria-selected={source === "catalog"}
              onClick={() => selectSource("catalog")}
            >
              Apple Music
            </button>
            <button
              className={source === "library" ? "is-active" : ""}
              type="button"
              role="tab"
              aria-selected={source === "library"}
              onClick={() => selectSource("library")}
            >
              Your Library
            </button>
          </div>
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
              <LoaderCircle className="spin" size={22} /> Searching Apple Music…
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
          ) : (
            <div className="search-groups">
              {groupError ? (
                <p className="library-stale-note" role="status">
                  Some {source === "library" ? "library" : "Apple Music"}{" "}
                  results could not be refreshed:{" "}
                  {groups.error ?? "Try again in a moment."}
                </p>
              ) : null}
              {groups.songs.length ? (
                <section
                  className="search-results-panel"
                  aria-labelledby="search-songs-heading"
                >
                  <div className="results-toolbar">
                    <h2 id="search-songs-heading">Songs</h2>
                    {groups.songs.length >=
                    controller.consecutiveTrackTarget ? (
                      <button
                        className="quiet-button"
                        type="button"
                        disabled={!canPlay}
                        onClick={() =>
                          void controller
                            .playConsecutive()
                            .catch(() => undefined)
                        }
                      >
                        Queue first {controller.consecutiveTrackTarget}
                      </button>
                    ) : null}
                  </div>
                  <ol className="search-results-list">
                    {groups.songs.map((track, index) => (
                      <TrackRow
                        key={track.id}
                        track={track}
                        index={index}
                        disabled={!canPlay}
                        onPlay={() =>
                          void controller
                            .playFromSearch(index)
                            .catch(() => undefined)
                        }
                        onPlayNext={() =>
                          void controller
                            .playNextTracks([track])
                            .catch(() => undefined)
                        }
                      />
                    ))}
                  </ol>
                </section>
              ) : null}
              {groups.albums.length ? (
                <section
                  className="home-feed-section"
                  aria-labelledby="search-albums-heading"
                >
                  <div className="section-heading">
                    <h2 id="search-albums-heading">Albums</h2>
                  </div>
                  <div className="home-discovery-grid">
                    {groups.albums.map((item) => (
                      <ResourceCard
                        key={item.id}
                        item={item}
                        kind="album"
                        source={source}
                      />
                    ))}
                  </div>
                </section>
              ) : null}
              {groups.artists.length ? (
                <section
                  className="home-feed-section"
                  aria-labelledby="search-artists-heading"
                >
                  <div className="section-heading">
                    <h2 id="search-artists-heading">Artists</h2>
                  </div>
                  <div className="home-discovery-grid">
                    {groups.artists.map((item) => (
                      <ResourceCard
                        key={item.id}
                        item={item}
                        kind="artist"
                        source={source}
                      />
                    ))}
                  </div>
                </section>
              ) : null}
              {groups.playlists.length ? (
                <section
                  className="home-feed-section"
                  aria-labelledby="search-playlists-heading"
                >
                  <div className="section-heading">
                    <h2 id="search-playlists-heading">Playlists</h2>
                  </div>
                  <div className="home-discovery-grid">
                    {groups.playlists.map((item) => (
                      <ResourceCard
                        key={item.id}
                        item={item}
                        kind="playlist"
                        source={source}
                      />
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          )}
        </>
      )}
    </>
  );
}
