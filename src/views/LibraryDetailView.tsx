import {
  AlertCircle,
  Disc3,
  ListMusic,
  LoaderCircle,
  Play,
  RefreshCw,
  UserRound,
} from "lucide-preact";
import type { LucideIcon } from "lucide-preact";
import { useEffect, useMemo } from "preact/hooks";
import type { JSX } from "preact";
import {
  useAppController,
  useAppRouter,
  useAppState,
} from "../app/context.tsx";
import type { AppController } from "../app/controller.ts";
import { Artwork } from "../components/Artwork.tsx";
import { EmptyState } from "./EmptyState.tsx";
import {
  LibraryTrackRow,
  readCollection,
  readDetail,
  toResource,
  toTrack,
  type ResourceLike,
} from "./LibraryView.tsx";
import type { Track } from "../domain/music.ts";

type DetailKind = "album" | "artist" | "playlist";
type DetailSource = "library" | "catalog";

interface DetailController {
  loadAlbum?: (
    id: string,
    source?: DetailSource,
    options?: { refresh?: boolean },
  ) => Promise<unknown>;
  loadArtist?: (
    id: string,
    source?: DetailSource,
    options?: { refresh?: boolean },
  ) => Promise<unknown>;
  loadPlaylist?: (
    id: string,
    source?: DetailSource,
    options?: { refresh?: boolean },
  ) => Promise<unknown>;
  refreshCurrentData?: () => Promise<unknown>;
}

function run(action: () => Promise<unknown> | undefined): void {
  void Promise.resolve(action()).catch(() => undefined);
}

function callLoader(
  loader:
    | ((
        id: string,
        source?: DetailSource,
        options?: { refresh?: boolean },
      ) => Promise<unknown>)
    | undefined,
  id: string,
  source?: DetailSource,
  options?: { refresh?: boolean },
): void {
  if (loader) run(() => loader(id, source, options));
}

function resourceSource(resource: ResourceLike): DetailSource | undefined {
  const raw = resource.raw;
  const attributes =
    raw.attributes && typeof raw.attributes === "object"
      ? (raw.attributes as Record<string, unknown>)
      : undefined;
  const value = raw.source ?? attributes?.source;
  if (value === "library" || value === "catalog") return value;
  const type = resource.type?.toLowerCase();
  return type?.startsWith("library-") ? "library" : undefined;
}

function findResource(
  state: ReturnType<typeof useAppState>,
  kind: DetailKind,
  id: string,
): ResourceLike | undefined {
  const section =
    kind === "album" ? "albums" : kind === "artist" ? "artists" : "playlists";
  const collection = readCollection(state, section);
  return collection.items
    .map(toResource)
    .find((resource) => resource?.id === id);
}

function detailResource(
  detail: ReturnType<typeof readDetail>,
  fallback: ResourceLike | undefined,
): ResourceLike | undefined {
  return toResource(detail.resource) ?? toResource(detail.item) ?? fallback;
}

function detailItems(
  detail: ReturnType<typeof readDetail>,
  resource: ResourceLike | undefined,
): ResourceLike[] {
  const source =
    detail.tracks ??
    detail.albums ??
    detail.items ??
    resource?.tracks ??
    resource?.albums ??
    [];
  return source
    .map(toResource)
    .filter((item): item is ResourceLike => Boolean(item));
}

function detailCopy(kind: DetailKind): {
  eyebrow: string;
  fallback: string;
  icon: LucideIcon;
} {
  switch (kind) {
    case "artist":
      return { eyebrow: "Artist", fallback: "Artist", icon: UserRound };
    case "playlist":
      return { eyebrow: "Playlist", fallback: "Playlist", icon: ListMusic };
    case "album":
      return { eyebrow: "Album", fallback: "Album", icon: Disc3 };
  }
}

function detailContext(
  resource: ResourceLike,
  kind: DetailKind,
): Record<string, string> {
  return {
    "data-context-kind": kind,
    "data-context-id": resource.id,
    "data-context-title": resource.title,
    "data-context-route-kind": kind,
    ...(resourceSource(resource)
      ? { "data-context-source": resourceSource(resource) as string }
      : {}),
  };
}

function TrackList({
  resources,
  canPlay,
  onPlay,
}: {
  resources: ResourceLike[];
  canPlay: boolean;
  onPlay: (track: Track) => void;
}): JSX.Element {
  return (
    <section className="library-list-panel" aria-label="Tracks">
      <ol className="library-track-list">
        {resources.map((resource, index) => (
          <LibraryTrackRow
            key={resource.id}
            resource={resource}
            index={index}
            onPlay={onPlay}
            disabled={!canPlay}
          />
        ))}
      </ol>
    </section>
  );
}

export function LibraryDetailView({
  kind,
  id,
  source,
}: {
  kind: DetailKind;
  id: string;
  source?: DetailSource;
}): JSX.Element {
  const state = useAppState();
  const controller = useAppController();
  const router = useAppRouter();
  const extendedController = controller as AppController & DetailController;
  const sourceDetail =
    source === "catalog" ? readDetail(state, kind, `catalog:${id}`) : undefined;
  const detail =
    sourceDetail && sourceDetail.status !== "idle"
      ? sourceDetail
      : readDetail(state, kind, id);
  const fallback = findResource(state, kind, id);
  const resource = detailResource(detail, fallback);
  const resources = useMemo(
    () => detailItems(detail, resource),
    [detail, resource],
  );
  const copy = detailCopy(kind);
  const DetailIcon = copy.icon;
  const authorized =
    state.auth.status === "authorized" &&
    state.initialization.status === "ready";
  const loading =
    detail.status === "loading" && !resource && resources.length === 0;

  useEffect(() => {
    if (!authorized) return;
    const loader =
      kind === "album"
        ? extendedController.loadAlbum
        : kind === "artist"
          ? extendedController.loadArtist
          : extendedController.loadPlaylist;
    callLoader(loader, id, source);
  }, [
    authorized,
    extendedController.loadAlbum,
    extendedController.loadArtist,
    extendedController.loadPlaylist,
    id,
    kind,
    source,
  ]);

  const playTrack = (track: Track): void =>
    run(() => controller.playTracks([track]));
  const playAll = (): void => {
    const tracks = resources
      .map(toTrack)
      .filter((track): track is Track => Boolean(track));
    if (tracks.length) run(() => controller.playTracks(tracks));
  };

  if (!authorized) {
    return (
      <EmptyState
        icon={copy.icon}
        title="Sign in to open this library item"
        description="Connect your Apple Music account to view its details and play it."
        action={
          <button
            className="primary-button"
            type="button"
            disabled={
              state.initialization.status !== "ready" ||
              state.auth.pending === true
            }
            onClick={() => run(controller.authorize)}
          >
            {state.auth.pending === true ? "Signing in…" : "Sign in"}
          </button>
        }
      />
    );
  }

  if (loading) {
    return (
      <div className="library-feedback" role="status">
        <LoaderCircle className="spin" aria-hidden="true" size={22} /> Loading{" "}
        {copy.fallback.toLowerCase()}…
      </div>
    );
  }

  if (detail.error && !resource && resources.length === 0) {
    return (
      <EmptyState
        icon={AlertCircle}
        title={`${copy.fallback} could not be loaded`}
        description={detail.error}
        action={
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              const loader =
                kind === "album"
                  ? extendedController.loadAlbum
                  : kind === "artist"
                    ? extendedController.loadArtist
                    : extendedController.loadPlaylist;
              callLoader(loader, id, source, { refresh: true });
            }}
          >
            Try again
          </button>
        }
      />
    );
  }

  const title = resource?.title ?? id;
  const artist = resource?.artistName;
  const artworkTrack = resource ? toTrack(resource) : undefined;
  const isArtist = kind === "artist";
  return (
    <>
      <section
        className="library-detail-hero"
        {...(resource ? detailContext(resource, kind) : {})}
      >
        <div className="library-detail-art">
          {artworkTrack ? (
            <Artwork
              track={artworkTrack}
              size="hero"
              alt={`${title} artwork`}
            />
          ) : (
            <span className="library-detail-icon">
              <DetailIcon aria-hidden="true" size={42} strokeWidth={1.4} />
            </span>
          )}
        </div>
        <div className="library-detail-copy">
          <span className="eyebrow">{copy.eyebrow}</span>
          <h1 tabIndex={-1}>{title}</h1>
          {artist ? <p>{artist}</p> : null}
          <div className="library-detail-actions">
            {!isArtist && resources.length ? (
              <button
                className="primary-button"
                type="button"
                onClick={playAll}
              >
                <Play aria-hidden="true" size={16} fill="currentColor" /> Play
                all
              </button>
            ) : null}
            <button
              className="icon-button"
              type="button"
              aria-label="Refresh details"
              onClick={() => {
                const loader =
                  kind === "album"
                    ? extendedController.loadAlbum
                    : kind === "artist"
                      ? extendedController.loadArtist
                      : extendedController.loadPlaylist;
                callLoader(loader, id, source, { refresh: true });
              }}
            >
              <RefreshCw aria-hidden="true" size={16} />
            </button>
          </div>
        </div>
      </section>
      {detail.source === "cache" || detail.stale || detail.isStale ? (
        <p className="library-stale-note" role="status">
          Showing saved data while Apple Music refreshes.
        </p>
      ) : null}
      {detail.error && resources.length ? (
        <p className="library-stale-note" role="status">
          Refresh failed; showing saved data. {detail.error}
        </p>
      ) : null}
      {isArtist ? (
        resources.length ? (
          <section className="library-card-grid" aria-label="Artist albums">
            {resources.map((album) => (
              <button
                key={album.id}
                className="library-card"
                type="button"
                {...detailContext(album, "album")}
                onClick={() =>
                  router.navigate({
                    kind: "album",
                    id: album.id,
                    source: resourceSource(album) ?? source,
                  } as Parameters<typeof router.navigate>[0])
                }
              >
                <Artwork
                  track={toTrack(album)}
                  size="lg"
                  alt={`${album.title} artwork`}
                  className="library-card-art"
                />
                <span className="library-card-copy">
                  <strong>{album.title}</strong>
                  <small>{album.artistName ?? "Album"}</small>
                </span>
              </button>
            ))}
          </section>
        ) : (
          <EmptyState
            icon={Disc3}
            title="No albums found"
            description="Apple Music did not return albums for this artist."
            compact
          />
        )
      ) : resources.length ? (
        <TrackList
          resources={resources}
          canPlay={authorized}
          onPlay={playTrack}
        />
      ) : (
        <EmptyState
          icon={DetailIcon}
          title="Nothing here yet"
          description="This item has no playable tracks."
          compact
        />
      )}
    </>
  );
}
