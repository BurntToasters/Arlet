import {
  AlertCircle,
  ArrowLeft,
  Disc3,
  ListMusic,
  LoaderCircle,
  RefreshCw,
  Sparkles,
} from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  useAppController,
  useAppRouter,
  useAppSlices,
} from "../app/context.tsx";
import { Artwork } from "../components/Artwork.tsx";
import { CardActions, CardShell } from "../components/CardActions.tsx";
import {
  SkeletonCardGrid,
  SkeletonRows,
  SkeletonStatus,
} from "../components/Skeleton.tsx";
import { SongRow } from "../components/SongRow.tsx";
import { EmptyState } from "./EmptyState.tsx";
import type { Album, Playlist, Track } from "../domain/music.ts";
import type { BrowseGenre, BrowseShelfKind } from "../musickit/browse.ts";
import { reportActionError } from "../components/action-errors.ts";

/** Items a shelf shows before "See all" opens the whole loaded list. */
const SHELF_PREVIEW_LIMIT = 10;

const SHELF_TITLES: Record<BrowseShelfKind, string> = {
  songs: "Top Songs",
  albums: "Top Albums",
  playlists: "Top Playlists",
  cityCharts: "City Charts",
  dailyCharts: "Daily Top 100",
};

function cardTrack(item: Album | Playlist): Track {
  return {
    id: item.id,
    title: "title" in item ? item.title : item.name,
    artistName: "artistName" in item ? item.artistName : "Apple Music",
    artwork: item.artwork,
    resourceType: item.resourceType,
  };
}

function Card({
  item,
  kind,
}: {
  item: Album | Playlist;
  kind: "album" | "playlist";
}): JSX.Element {
  const router = useAppRouter();
  const controller = useAppController();
  const track = cardTrack(item);
  const title = track.title;
  return (
    <CardShell
      contextData={{
        "data-context-kind": kind,
        "data-context-id": item.id,
        "data-context-title": title,
        "data-context-route-kind": kind,
        "data-context-source": "catalog",
      }}
      catalogUrl={item.catalogUrl}
    >
      <button
        className="home-discovery-card"
        type="button"
        onClick={() =>
          router.navigate({ kind, id: item.id, source: "catalog" })
        }
      >
        <Artwork
          track={track}
          size="lg"
          alt={`${title} artwork`}
          className="home-discovery-art"
        />
        <span className="home-discovery-copy">
          <strong title={title}>{title}</strong>
          <small>{track.artistName}</small>
        </span>
        <span className="home-discovery-source">Apple Music</span>
      </button>
      <CardActions
        title={title}
        onPlay={
          "playable" in item && item.playable === false
            ? undefined
            : () =>
                void Promise.resolve(
                  controller.playCollection?.(kind, item.id, "catalog", 0),
                ).catch(reportActionError)
        }
      />
    </CardShell>
  );
}

function CardGrid({
  items,
  kind,
}: {
  items: readonly (Album | Playlist)[];
  kind: "album" | "playlist";
}): JSX.Element {
  return (
    <div className="home-discovery-grid">
      {items.map((item) => (
        <Card key={item.id} item={item} kind={kind} />
      ))}
    </div>
  );
}

/** Genre choice for Browse. "" is All genres, the default. */
function GenrePicker({
  genreId,
  genres,
  loading,
  onChange,
}: {
  genreId: string;
  genres: readonly BrowseGenre[];
  loading: boolean;
  onChange: (genreId: string) => void;
}): JSX.Element {
  return (
    <div className="browse-genre-bar">
      <label className="browse-genre-label" htmlFor="browse-genre">
        Genre
      </label>
      <select
        id="browse-genre"
        className="browse-genre-select"
        value={genreId}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <option value="">All genres</option>
        {genres.map((genre) => (
          <option key={genre.id} value={genre.id}>
            {genre.name}
          </option>
        ))}
      </select>
      {loading && genres.length === 0 ? (
        <span className="browse-genre-status" role="status">
          Loading genres…
        </span>
      ) : null}
    </div>
  );
}

function ShelfHeading({
  id,
  eyebrow,
  title,
  busy,
  onSeeAll,
}: {
  id: string;
  eyebrow: string;
  title: string;
  busy: boolean;
  onSeeAll?: () => void;
}): JSX.Element {
  return (
    <div className="section-heading browse-shelf-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2 id={id}>{title}</h2>
      </div>
      <div className="browse-shelf-actions">
        {busy ? <LoaderCircle className="spin" size={16} /> : null}
        {onSeeAll ? (
          <button
            className="browse-see-all"
            type="button"
            aria-label={`See all ${title.toLowerCase()}`}
            onClick={onSeeAll}
          >
            See all
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function BrowseView(): JSX.Element {
  const state = useAppSlices("auth", "browse", "initialization");
  const controller = useAppController();
  const browse = state.browse;
  const authorized = state.auth.status === "authorized";
  const loading = browse.status === "loading" || browse.status === "refreshing";
  const hasData =
    browse.songs.length > 0 ||
    browse.albums.length > 0 ||
    browse.playlists.length > 0;
  const initialLoad = loading && !hasData;
  // Also reloads once a sign-in finishes, which resets Browse to idle. The
  // in-flight state is read from a ref: as an effect trigger it would retry a
  // failing load forever.
  const idle = browse.status === "idle";
  const pending = state.auth.pending;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  // The shelf open under "See all", if any.
  const [expanded, setExpanded] = useState<BrowseShelfKind | undefined>();
  const expandedHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (authorized && !pending && !loadingRef.current)
      void Promise.resolve(controller.loadBrowse?.()).catch(() => undefined);
  }, [authorized, pending, idle, controller]);
  useEffect(() => {
    if (expanded) expandedHeading.current?.focus();
  }, [expanded]);
  useEffect(() => {
    // A shelf that empties while open (after a genre change) closes itself.
    if (expanded && browse[expanded].length === 0 && !loading) {
      setExpanded(undefined);
    }
  }, [browse, expanded, loading]);

  if (!authorized) {
    return (
      <EmptyState
        icon={Sparkles}
        title="Sign in to browse Apple Music"
        description="Connect your Apple Music account to explore charts."
        action={
          <button
            className="primary-button"
            type="button"
            onClick={() => void controller.authorize().catch(reportActionError)}
          >
            Sign in
          </button>
        }
      />
    );
  }
  if (
    browse.status === "error" &&
    !browse.songs.length &&
    !browse.albums.length &&
    !browse.playlists.length
  ) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Browse could not be loaded"
        description={browse.error ?? "Try again in a moment."}
        action={
          <button
            className="secondary-button"
            type="button"
            onClick={() =>
              void Promise.resolve(
                controller.loadBrowse?.({ refresh: true }),
              ).catch(() => undefined)
            }
          >
            Try again
          </button>
        }
      />
    );
  }

  const chooseGenre = (genreId: string): void => {
    setExpanded(undefined);
    void Promise.resolve(controller.loadBrowse?.({ genreId })).catch(
      () => undefined,
    );
  };
  const scope = browse.genreId ? "this genre" : "this storefront";
  const seeAll = (kind: BrowseShelfKind) => () => setExpanded(kind);

  const songRows = (tracks: readonly Track[]): JSX.Element => (
    <ol className="library-track-list">
      {tracks.map((track, index) => (
        <SongRow
          key={track.id}
          track={track}
          index={index}
          disabled={state.initialization.status !== "ready"}
          onPlay={() =>
            void controller
              .playTracks(browse.songs, index)
              .catch(reportActionError)
          }
          onPlayNext={() =>
            void controller.playNextTracks([track]).catch(reportActionError)
          }
          rowClassName="library-track-row"
          numberClassName="library-row-number"
          copyClassName="library-row-copy"
          durationClassName="library-row-duration"
          contextData={{
            "data-context-kind": "track",
            "data-context-id": track.id,
            "data-context-title": track.title,
            "data-context-artist": track.artistName,
          }}
        />
      ))}
    </ol>
  );

  const seeAllView = (kind: BrowseShelfKind): JSX.Element => {
    const title = SHELF_TITLES[kind];
    const paging = browse.paging[kind];
    const count = browse[kind].length;
    let items: JSX.Element;
    switch (kind) {
      case "songs":
        items = songRows(browse.songs);
        break;
      case "albums":
        items = <CardGrid items={browse.albums} kind="album" />;
        break;
      default:
        items = <CardGrid items={browse[kind]} kind="playlist" />;
    }
    return (
      <section
        className="browse-see-all-view"
        aria-labelledby="browse-see-all-heading"
      >
        <div className="section-heading browse-see-all-heading">
          <button
            className="secondary-button"
            type="button"
            onClick={() => setExpanded(undefined)}
          >
            <ArrowLeft aria-hidden="true" size={16} /> Back to Browse
          </button>
          <h2 id="browse-see-all-heading" ref={expandedHeading} tabIndex={-1}>
            {title}
          </h2>
        </div>
        {items}
        {paging?.status === "loading" ? (
          <div className="browse-feedback" role="status">
            <LoaderCircle className="spin" size={22} /> Loading more…
          </div>
        ) : null}
        {paging?.status === "error" ? (
          <p className="library-stale-note" role="alert">
            More {title.toLowerCase()} could not be loaded:{" "}
            {paging.error ?? "Try again in a moment."}
          </p>
        ) : null}
        {paging?.next && paging.status !== "loading" ? (
          <div className="browse-see-all-more">
            <button
              className="secondary-button"
              type="button"
              onClick={() =>
                void Promise.resolve(
                  controller.loadMoreBrowseShelf?.(kind),
                ).catch(() => undefined)
              }
            >
              Load more
            </button>
          </div>
        ) : null}
        {count && !paging?.next && paging?.status !== "loading" ? (
          <p className="browse-see-all-end">
            All {count} {title.toLowerCase()} are shown.
          </p>
        ) : null}
      </section>
    );
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Apple Music</span>
          <h1 tabIndex={-1}>Browse</h1>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Refresh Browse"
          disabled={loading}
          onClick={() =>
            void Promise.resolve(
              controller.loadBrowse?.({ refresh: true }),
            ).catch(() => undefined)
          }
        >
          <RefreshCw size={16} className={loading ? "spin" : ""} />
        </button>
      </div>
      <GenrePicker
        genreId={browse.genreId}
        genres={browse.genres}
        loading={loading}
        onChange={chooseGenre}
      />
      {browse.error ? (
        <p className="library-stale-note" role="status">
          Some charts could not be refreshed: {browse.error}
        </p>
      ) : null}
      {expanded ? (
        seeAllView(expanded)
      ) : (
        <>
          <section
            className="home-feed-section"
            aria-labelledby="browse-songs-heading"
          >
            <ShelfHeading
              id="browse-songs-heading"
              eyebrow="Most played"
              title="Top Songs"
              busy={loading}
              onSeeAll={browse.songs.length ? seeAll("songs") : undefined}
            />
            {browse.songs.length ? (
              songRows(browse.songs.slice(0, SHELF_PREVIEW_LIMIT))
            ) : initialLoad ? (
              <SkeletonStatus label="Loading Browse…">
                <SkeletonRows count={6} />
              </SkeletonStatus>
            ) : loading ? null : (
              <EmptyState
                icon={ListMusic}
                title="No top songs"
                description={`Apple Music returned no songs for ${scope}.`}
                compact
              />
            )}
          </section>
          <section
            className="home-feed-section"
            aria-labelledby="browse-albums-heading"
          >
            <ShelfHeading
              id="browse-albums-heading"
              eyebrow="Most played"
              title="Top Albums"
              busy={false}
              onSeeAll={browse.albums.length ? seeAll("albums") : undefined}
            />
            {browse.albums.length ? (
              <CardGrid
                items={browse.albums.slice(0, SHELF_PREVIEW_LIMIT)}
                kind="album"
              />
            ) : initialLoad ? (
              <SkeletonCardGrid count={6} />
            ) : loading ? null : (
              <EmptyState
                icon={Disc3}
                title="No top albums"
                description={`Apple Music returned no albums for ${scope}.`}
                compact
              />
            )}
          </section>
          <section
            className="home-feed-section"
            aria-labelledby="browse-playlists-heading"
          >
            <ShelfHeading
              id="browse-playlists-heading"
              eyebrow="Most played"
              title="Top Playlists"
              busy={false}
              onSeeAll={
                browse.playlists.length ? seeAll("playlists") : undefined
              }
            />
            {browse.playlists.length ? (
              <CardGrid
                items={browse.playlists.slice(0, SHELF_PREVIEW_LIMIT)}
                kind="playlist"
              />
            ) : initialLoad ? (
              <SkeletonCardGrid count={6} />
            ) : loading ? null : (
              <EmptyState
                icon={ListMusic}
                title="No top playlists"
                description={`Apple Music returned no playlists for ${scope}.`}
                compact
              />
            )}
          </section>
          {/* City and daily charts exist only for some genres, so an absent
              shelf is hidden rather than shown empty. */}
          {browse.cityCharts.length ? (
            <section
              className="home-feed-section"
              aria-labelledby="browse-city-heading"
            >
              <ShelfHeading
                id="browse-city-heading"
                eyebrow="Charts"
                title="City Charts"
                busy={false}
                onSeeAll={seeAll("cityCharts")}
              />
              <CardGrid
                items={browse.cityCharts.slice(0, SHELF_PREVIEW_LIMIT)}
                kind="playlist"
              />
            </section>
          ) : null}
          {browse.dailyCharts.length ? (
            <section
              className="home-feed-section"
              aria-labelledby="browse-daily-heading"
            >
              <ShelfHeading
                id="browse-daily-heading"
                eyebrow="Charts"
                title="Daily Top 100"
                busy={false}
                onSeeAll={seeAll("dailyCharts")}
              />
              <CardGrid
                items={browse.dailyCharts.slice(0, SHELF_PREVIEW_LIMIT)}
                kind="playlist"
              />
            </section>
          ) : null}
        </>
      )}
    </>
  );
}
