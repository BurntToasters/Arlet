import {
  AlertCircle,
  Disc3,
  ListMusic,
  LoaderCircle,
  RefreshCw,
  Sparkles,
} from "lucide-preact";
import { useEffect } from "preact/hooks";
import type { JSX } from "preact";
import {
  useAppController,
  useAppRouter,
  useAppState,
} from "../app/context.tsx";
import { Artwork } from "../components/Artwork.tsx";
import { SongRow } from "../components/SongRow.tsx";
import { EmptyState } from "./EmptyState.tsx";
import type { Album, Playlist, Track } from "../domain/music.ts";

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
  const track = cardTrack(item);
  const title = track.title;
  return (
    <button
      className="home-discovery-card"
      type="button"
      onClick={() => router.navigate({ kind, id: item.id, source: "catalog" })}
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
  );
}

export function BrowseView(): JSX.Element {
  const state = useAppState();
  const controller = useAppController();
  const browse = state.browse;
  const authorized = state.auth.status === "authorized";
  const loading = browse.status === "loading" || browse.status === "refreshing";
  const hasData =
    browse.songs.length > 0 ||
    browse.albums.length > 0 ||
    browse.playlists.length > 0;
  useEffect(() => {
    if (authorized)
      void Promise.resolve(controller.loadBrowse?.()).catch(() => undefined);
  }, [authorized, controller]);

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
            onClick={() => void controller.authorize().catch(() => undefined)}
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
      {browse.error ? (
        <p className="library-stale-note" role="status">
          Some charts could not be refreshed: {browse.error}
        </p>
      ) : null}
      {loading && !hasData ? (
        <div className="search-feedback" role="status">
          <LoaderCircle className="spin" size={22} /> Loading Browse…
        </div>
      ) : null}
      <section
        className="home-feed-section"
        aria-labelledby="browse-songs-heading"
      >
        <div className="section-heading">
          <div>
            <span className="eyebrow">Most played</span>
            <h2 id="browse-songs-heading">Top Songs</h2>
          </div>
          {loading ? <LoaderCircle className="spin" size={16} /> : null}
        </div>
        {browse.songs.length ? (
          <ol className="library-track-list">
            {browse.songs.map((track, index) => (
              <SongRow
                key={track.id}
                track={track}
                index={index}
                disabled={state.initialization.status !== "ready"}
                onPlay={() =>
                  void controller
                    .playTracks(browse.songs, index)
                    .catch(() => undefined)
                }
                onPlayNext={() =>
                  void controller.playNextTracks([track]).catch(() => undefined)
                }
                rowClassName="library-track-row"
                numberClassName="library-track-number"
                copyClassName="library-track-copy"
                durationClassName="library-track-duration"
                contextData={{
                  "data-context-kind": "track",
                  "data-context-id": track.id,
                  "data-context-title": track.title,
                  "data-context-artist": track.artistName,
                }}
              />
            ))}
          </ol>
        ) : loading ? null : (
          <EmptyState
            icon={ListMusic}
            title="No top songs"
            description="Apple Music returned no songs for this storefront."
            compact
          />
        )}
      </section>
      <section
        className="home-feed-section"
        aria-labelledby="browse-albums-heading"
      >
        <div className="section-heading">
          <div>
            <span className="eyebrow">Most played</span>
            <h2 id="browse-albums-heading">Top Albums</h2>
          </div>
        </div>
        {browse.albums.length ? (
          <div className="home-discovery-grid">
            {browse.albums.map((item) => (
              <Card key={item.id} item={item} kind="album" />
            ))}
          </div>
        ) : loading ? null : (
          <EmptyState
            icon={Disc3}
            title="No top albums"
            description="Apple Music returned no albums."
            compact
          />
        )}
      </section>
      <section
        className="home-feed-section"
        aria-labelledby="browse-playlists-heading"
      >
        <div className="section-heading">
          <div>
            <span className="eyebrow">Most played</span>
            <h2 id="browse-playlists-heading">Top Playlists</h2>
          </div>
        </div>
        {browse.playlists.length ? (
          <div className="home-discovery-grid">
            {browse.playlists.map((item) => (
              <Card key={item.id} item={item} kind="playlist" />
            ))}
          </div>
        ) : loading ? null : (
          <EmptyState
            icon={ListMusic}
            title="No top playlists"
            description="Apple Music returned no playlists."
            compact
          />
        )}
      </section>
    </>
  );
}
