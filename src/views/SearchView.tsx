import {
  AlertCircle,
  LoaderCircle,
  Play,
  Search as SearchIcon,
} from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  useAppController,
  useAppRouter,
  useAppState,
} from "../app/context.tsx";
import { Artwork } from "../components/Artwork.tsx";
import { EmptyState } from "./EmptyState.tsx";
import type { Track } from "../domain/music.ts";

function formatDuration(durationMs?: number): string {
  if (!durationMs || durationMs <= 0) return "—";
  const seconds = Math.floor(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function TrackRow({
  track,
  index,
  onPlay,
  disabled,
}: {
  track: Track;
  index: number;
  onPlay: () => void;
  disabled: boolean;
}): JSX.Element {
  return (
    <li>
      <button
        className="search-row"
        type="button"
        aria-label={`Play ${track.title} by ${track.artistName}`}
        disabled={disabled}
        onClick={onPlay}
      >
        <span className="search-row-number" aria-hidden="true">
          {String(index + 1).padStart(2, "0")}
        </span>
        <Artwork track={track} size="sm" alt="" />
        <span className="search-row-copy">
          <strong title={track.title}>{track.title}</strong>
          <span title={track.artistName}>
            {track.artistName}
            {track.albumTitle ? ` · ${track.albumTitle}` : ""}
          </span>
        </span>
        {track.explicit ? <span className="explicit-badge">E</span> : null}
        <span className="search-row-duration">
          {formatDuration(track.durationMs)}
        </span>
        <span className="row-play-button" aria-hidden="true">
          <Play size={15} fill="currentColor" strokeWidth={1.9} />
        </span>
      </button>
    </li>
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
  const canPlay =
    state.initialization.status === "ready" &&
    state.auth.status === "authorized";
  const authorizationPending = state.auth.pending === true;

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
      if (debounceTimer.current !== undefined)
        window.clearTimeout(debounceTimer.current);
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
    if (debounceTimer.current !== undefined)
      window.clearTimeout(debounceTimer.current);
    void controller.search(value);
  };

  const play = (index: number): void => {
    void controller.playFromSearch(index).catch(() => undefined);
  };

  return (
    <>
      <div className="page-heading search-heading">
        <div>
          <span className="eyebrow">Catalog</span>
          <h1 tabIndex={-1}>Search</h1>
        </div>
        {state.auth.status === "authorized" ? (
          <span className="search-count">
            {state.search.results.length
              ? `${state.search.results.length} results`
              : ""}
          </span>
        ) : null}
      </div>

      <form className="search-form" role="search" onSubmit={submit}>
        <SearchIcon aria-hidden="true" size={20} strokeWidth={1.8} />
        <input
          aria-label="Search the Apple Music catalog"
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
          description="Connect your Apple Music account to search the catalog and start playback."
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
      ) : state.search.status === "error" ? (
        <EmptyState
          icon={AlertCircle}
          title="Search could not be completed"
          description={state.search.error ?? "Try again in a moment."}
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
          <LoaderCircle className="spin" aria-hidden="true" size={22} />{" "}
          Searching Apple Music…
        </div>
      ) : state.search.status === "success" &&
        state.search.results.length === 0 ? (
        <EmptyState
          icon={SearchIcon}
          title="No matches"
          description={`We couldn't find anything for “${state.search.query}”. Try another search.`}
          compact
        />
      ) : state.search.results.length > 0 ? (
        <section className="search-results-panel" aria-label="Search results">
          <div className="results-toolbar">
            <span>{state.search.results.length} songs</span>
            {state.search.results.length >=
            controller.consecutiveTrackTarget ? (
              <button
                className="quiet-button"
                type="button"
                disabled={!canPlay}
                onClick={() =>
                  void controller.playConsecutive().catch(() => undefined)
                }
              >
                Queue first {controller.consecutiveTrackTarget}
              </button>
            ) : null}
          </div>
          <ol className="search-results-list">
            {state.search.results.map((track, index) => (
              <TrackRow
                key={track.id}
                track={track}
                index={index}
                disabled={!canPlay}
                onPlay={() => play(index)}
              />
            ))}
          </ol>
          <p className="search-note">
            Selecting a song starts a queue from that result onward.
          </p>
        </section>
      ) : (
        <EmptyState
          icon={SearchIcon}
          title="Search the catalog"
          description="Find a song, artist, or album to begin listening."
          compact
        />
      )}
    </>
  );
}
