import {
  AlertCircle,
  Disc3,
  ListMusic,
  LoaderCircle,
  Play,
  Radio,
  RefreshCw,
  Shuffle,
  UserRound,
} from "lucide-preact";
import type { LucideIcon } from "lucide-preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  useAppController,
  useAppRouter,
  useAppState,
} from "../app/context.tsx";
import type { AppController } from "../app/controller.ts";
import type { CollectionPlayOptions } from "../app/collection-playback.ts";
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
import { reportActionError } from "../components/action-errors.ts";
import { SongRow } from "../components/SongRow.tsx";
import { OfflineBanner } from "../components/OfflineBanner.tsx";
import { VirtualList } from "../components/VirtualList.tsx";

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
  playAlbum?: (
    id: string,
    source?: DetailSource,
    startIndex?: number,
  ) => Promise<void>;
  playPlaylist?: (
    id: string,
    source?: DetailSource,
    startIndex?: number,
  ) => Promise<void>;
  playCollection?: (
    kind: "playlist" | "album",
    id: string,
    source?: DetailSource,
    startIndex?: number,
    options?: CollectionPlayOptions,
  ) => Promise<void>;
  refreshCurrentData?: () => Promise<unknown>;
}

/** Background loads; their views render the error state. */
function run(action: () => Promise<unknown> | undefined): void {
  void Promise.resolve(action()).catch(() => undefined);
}

/** User actions; failures surface as a toast. */
function act(action: () => Promise<unknown> | undefined): void {
  void Promise.resolve(action()).catch(reportActionError);
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
  parentKind,
  parentId,
  parentSource,
}: {
  resources: ResourceLike[];
  canPlay: boolean;
  onPlay: (track: Track, index: number) => void;
  parentKind: "album" | "playlist";
  parentId: string;
  parentSource: DetailSource;
}): JSX.Element {
  return (
    <section className="library-list-panel" aria-label="Tracks">
      <VirtualList
        className="library-track-list"
        items={resources}
        getKey={(resource, index) =>
          `${resource.type ?? "track"}:${resource.id}:${index}`
        }
        renderRow={(resource, index) => (
          <LibraryTrackRow
            resource={resource}
            index={index}
            onPlay={onPlay}
            disabled={!canPlay}
            contextData={{
              "data-context-parent-kind": parentKind,
              "data-context-parent-id": parentId,
              "data-context-parent-source": parentSource,
              "data-context-parent-index": String(index),
            }}
          />
        )}
      />
    </section>
  );
}

/** Top songs for the open artist; results from a previous artist are ignored. */
function useArtistTopSongs(
  controller: AppController,
  enabled: boolean,
  id: string,
  source: DetailSource,
  catalogId: string | undefined,
): Track[] {
  const key = `${source}:${id}`;
  const [loaded, setLoaded] = useState<{ key: string; tracks: Track[] }>();
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    controller
      .loadArtistTopSongs(id, source, catalogId)
      .then((tracks) => {
        if (current) setLoaded({ key, tracks });
      })
      .catch((error: unknown) => {
        controller.log(
          `Top songs unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (current) setLoaded({ key, tracks: [] });
      });
    return () => {
      current = false;
    };
  }, [controller, enabled, id, source, catalogId, key]);
  return loaded?.key === key ? loaded.tracks : [];
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
  const offline = state.library.offline;
  const loading =
    detail.status === "loading" && !resource && resources.length === 0;

  useEffect(() => {
    if (!authorized && !offline) return;
    const loader =
      kind === "album"
        ? extendedController.loadAlbum
        : kind === "artist"
          ? extendedController.loadArtist
          : extendedController.loadPlaylist;
    callLoader(loader, id, source);
  }, [
    authorized,
    offline,
    extendedController.loadAlbum,
    extendedController.loadArtist,
    extendedController.loadPlaylist,
    id,
    kind,
    source,
  ]);

  const playbackSource: DetailSource =
    source ?? (resource ? resourceSource(resource) : undefined) ?? "library";
  const playCollection = (startIndex: number): Promise<void> | undefined => {
    if (kind === "playlist" && extendedController.playPlaylist) {
      return extendedController.playPlaylist(id, playbackSource, startIndex);
    }
    if (kind === "album" && extendedController.playAlbum) {
      return extendedController.playAlbum(id, playbackSource, startIndex);
    }
    const tracks = resources
      .map(toTrack)
      .filter((track): track is Track => Boolean(track));
    return tracks.length
      ? controller.playTracks(tracks, startIndex)
      : undefined;
  };
  const playTrack = (_track: Track, index: number): void =>
    act(() => playCollection(index));
  const playAll = (): void => {
    if (resources.length) act(() => playCollection(0));
  };
  const shuffleAll = (): void => {
    if (kind === "artist" || !extendedController.playCollection) return;
    act(() =>
      extendedController.playCollection?.(kind, id, playbackSource, 0, {
        shuffle: true,
      }),
    );
  };
  const topSongs = useArtistTopSongs(
    controller,
    kind === "artist" && authorized,
    id,
    playbackSource,
    resource?.catalogId,
  );
  const playTopSongs = (): void => {
    if (topSongs.length) act(() => controller.playTracks(topSongs, 0));
  };
  const shuffleTopSongs = (): void => {
    if (topSongs.length) act(() => controller.playTracksShuffled(topSongs));
  };
  const startArtistStation = (): void =>
    act(() =>
      controller.startStation({
        kind: "artist",
        id,
        catalogId: resource?.catalogId,
        source: playbackSource,
      }),
    );
  const pending = state.ui.pendingCollection;
  const collectionBusy =
    kind !== "artist" && pending?.kind === kind && pending.id === id;

  if (!authorized && !offline) {
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
            onClick={() => act(controller.authorize)}
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
      {offline ? <OfflineBanner /> : null}
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
                aria-busy={collectionBusy || undefined}
                disabled={collectionBusy}
                onClick={playAll}
              >
                {collectionBusy ? (
                  <LoaderCircle className="spin" aria-hidden="true" size={16} />
                ) : (
                  <Play aria-hidden="true" size={16} fill="currentColor" />
                )}{" "}
                Play all
              </button>
            ) : null}
            {!isArtist &&
            resources.length &&
            extendedController.playCollection ? (
              <button
                className="secondary-button"
                type="button"
                aria-busy={collectionBusy || undefined}
                disabled={collectionBusy}
                onClick={shuffleAll}
              >
                <Shuffle aria-hidden="true" size={16} /> Shuffle
              </button>
            ) : null}
            {isArtist ? (
              <>
                {topSongs.length ? (
                  <>
                    <button
                      className="primary-button"
                      type="button"
                      onClick={playTopSongs}
                    >
                      <Play aria-hidden="true" size={16} fill="currentColor" />{" "}
                      Play
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={shuffleTopSongs}
                    >
                      <Shuffle aria-hidden="true" size={16} /> Shuffle
                    </button>
                  </>
                ) : null}
                <button
                  className="secondary-button"
                  type="button"
                  onClick={startArtistStation}
                >
                  <Radio aria-hidden="true" size={16} /> Station
                </button>
              </>
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
      {isArtist && topSongs.length ? (
        <section
          className="artist-top-songs"
          aria-labelledby="top-songs-heading"
        >
          <h2 id="top-songs-heading">Top Songs</h2>
          <div className="library-list-panel">
            <ol className="library-track-list">
              {topSongs.map((track, index) => (
                <SongRow
                  key={`${track.id}:${index}`}
                  track={track}
                  index={index}
                  onPlay={() =>
                    act(() => controller.playTracks(topSongs, index))
                  }
                  onPlayNext={() =>
                    act(() => controller.playNextTracks([track]))
                  }
                  disabled={!authorized}
                  rowClassName="library-track-row"
                  numberClassName="library-row-number"
                  copyClassName="library-row-copy"
                  durationClassName="library-row-duration"
                  contextData={{
                    "data-context-kind": "track",
                    "data-context-id": track.id,
                    "data-context-title": track.title,
                    "data-context-artist": track.artistName,
                    ...(track.albumTitle
                      ? { "data-context-album": track.albumTitle }
                      : {}),
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
              ))}
            </ol>
          </div>
        </section>
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
          parentKind={kind === "playlist" ? "playlist" : "album"}
          parentId={id}
          parentSource={playbackSource}
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
