import {
  AlertCircle,
  ChevronDown,
  Disc3,
  Heart,
  LibraryBig,
  ListMusic,
  LoaderCircle,
  MoreHorizontal,
  Pin,
  PinOff,
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
  useAppSelector,
  useAppSlices,
} from "../app/context.tsx";
import type { AppController } from "../app/controller.ts";
import type { CollectionPlayOptions } from "../app/collection-playback.ts";
import {
  isLibraryTarget,
  ratingKeyOf,
  type RatingTarget,
} from "../app/ratings.ts";
import { getState } from "../state.ts";
import { Artwork } from "../components/Artwork.tsx";
import { requestContextMenu } from "../components/context-menu-events.ts";
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
import {
  ARTWORK_BACKDROP_BUCKET,
  normalizeArtworkUrl,
} from "../musickit/normalize.ts";
import { reportActionError } from "../components/action-errors.ts";
import { SongRow } from "../components/SongRow.tsx";
import { CardActions, CardShell } from "../components/CardActions.tsx";
import { OfflineBanner } from "../components/OfflineBanner.tsx";
import { VirtualList } from "../components/VirtualList.tsx";
import {
  detailNotes,
  detailSummary,
  discNumberOf,
  groupByDisc,
  type DiscGroup,
} from "./detail-meta.ts";

/** Top Songs rows an artist page shows; Play still uses every top song. */
const ARTIST_TOP_SONGS_SHOWN = 10;

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
    trackId?: string,
  ) => Promise<void>;
  playPlaylist?: (
    id: string,
    source?: DetailSource,
    startIndex?: number,
    trackId?: string,
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
  items: readonly unknown[],
  id: string,
): ResourceLike | undefined {
  // Converts until the match instead of the whole collection.
  for (const item of items) {
    const resource = toResource(item);
    if (resource?.id === id) return resource;
  }
  return undefined;
}

function detailResource(
  detail: Pick<ReturnType<typeof readDetail>, "resource" | "item">,
  fallback: ResourceLike | undefined,
): ResourceLike | undefined {
  return toResource(detail.resource) ?? toResource(detail.item) ?? fallback;
}

function detailItems(
  detail: Pick<ReturnType<typeof readDetail>, "tracks" | "albums" | "items">,
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
    // The menu's "Copy Apple Music link" reads this; it validates the URL.
    ...(resource.catalogUrl
      ? { "data-context-catalog-url": resource.catalogUrl }
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
  // Each disc is its own list, so headings sit outside the virtualized rows
  // and the row-height spacers stay exact. Rows keep their album-wide index,
  // which is what Play starts from.
  const groups = useMemo(
    () =>
      groupByDisc(resources, parentKind === "album" ? discNumberOf : () => 1),
    [resources, parentKind],
  );
  // Several discs show each track's position on its disc; play still uses the
  // album-wide index.
  const multiDisc = groups.length > 1;
  const renderRows = (rows: DiscGroup<ResourceLike>["items"]): JSX.Element => (
    <VirtualList
      className="library-track-list"
      items={rows}
      getKey={({ item, index }) =>
        `${item.type ?? "track"}:${item.id}:${index}`
      }
      renderRow={({ item, index }) => (
        <LibraryTrackRow
          resource={item}
          index={index}
          onPlay={onPlay}
          disabled={!canPlay}
          discTrackNumbers={multiDisc}
          contextData={{
            "data-context-parent-kind": parentKind,
            "data-context-parent-id": parentId,
            "data-context-parent-source": parentSource,
            "data-context-parent-index": String(index),
          }}
        />
      )}
    />
  );
  if (groups.length < 2) {
    return (
      <section className="library-list-panel" aria-label="Tracks">
        {renderRows(groups[0]?.items ?? [])}
      </section>
    );
  }
  return (
    <div className="library-disc-groups">
      {groups.map((group) => (
        <section
          key={group.disc}
          className="library-disc"
          aria-labelledby={`library-disc-${group.disc}`}
        >
          <h2
            id={`library-disc-${group.disc}`}
            className="library-disc-heading"
          >
            Disc {group.disc}
          </h2>
          <div className="library-list-panel">{renderRows(group.items)}</div>
        </section>
      ))}
    </div>
  );
}

/** The rating target the context menu builds for a page of this kind. */
function ratingTargetFor(kind: "album" | "playlist", id: string): RatingTarget {
  return { type: kind === "album" ? "albums" : "playlists", id };
}

/** Love, Add to Library, Pin and "…" for an album or playlist header. */
function DetailHeroActions({
  kind,
  id,
  title,
  resource,
  controller,
  online,
}: {
  kind: "album" | "playlist";
  id: string;
  title: string;
  resource: ResourceLike;
  controller: AppController;
  /** Writes to Apple Music need an authorized session that is not offline. */
  online: boolean;
}): JSX.Element {
  const ratingTarget = ratingTargetFor(kind, id);
  const key = ratingKeyOf(ratingTarget);
  const loved = useAppSelector(
    (state) => key !== undefined && state.ratings[key] === 1,
  );
  const pinned = useAppSelector((state) =>
    state.pins.some((pin) => pin.id === id),
  );
  const canAddToLibrary =
    !isLibraryTarget(ratingTarget) && resourceSource(resource) !== "library";
  useEffect(() => {
    if (online) run(() => controller.loadRating(ratingTargetFor(kind, id)));
  }, [online, controller, kind, id]);
  const toggleLove = (): void => {
    if (key === undefined) return;
    // Toggle against the value at click time, as the context menu does.
    const current = getState().ratings[key];
    run(() => controller.rate(ratingTarget, current === 1 ? 0 : 1));
  };
  const togglePin = (): void =>
    act(() =>
      pinned
        ? controller.unpin(id)
        : controller.togglePin(id, resourceSource(resource) ?? "library"),
    );
  return (
    <>
      <button
        className="secondary-button"
        type="button"
        aria-pressed={loved}
        disabled={!online}
        onClick={toggleLove}
      >
        <Heart
          aria-hidden="true"
          size={16}
          fill={loved ? "currentColor" : "none"}
        />{" "}
        Love
      </button>
      {canAddToLibrary ? (
        <button
          className="secondary-button"
          type="button"
          disabled={!online}
          onClick={() => run(() => controller.addToLibrary(ratingTarget))}
        >
          <LibraryBig aria-hidden="true" size={16} /> Add to Library
        </button>
      ) : null}
      {kind === "playlist" ? (
        <button className="secondary-button" type="button" onClick={togglePin}>
          {pinned ? (
            <PinOff aria-hidden="true" size={16} />
          ) : (
            <Pin aria-hidden="true" size={16} />
          )}{" "}
          {pinned ? "Unpin" : "Pin"}
        </button>
      ) : null}
      <button
        className="icon-button"
        type="button"
        aria-label={`More actions for ${title}`}
        title="More actions"
        aria-haspopup="menu"
        onClick={(event) => {
          const target = event.currentTarget.closest<HTMLElement>(
            "[data-context-kind]",
          );
          if (target) requestContextMenu(target, event.currentTarget);
        }}
      >
        <MoreHorizontal aria-hidden="true" size={16} />
      </button>
    </>
  );
}

/** The metadata line under an album or playlist title. */
function DetailSummary({
  kind,
  resource,
  tracks,
  complete,
}: {
  kind: "album" | "playlist";
  resource: ResourceLike;
  tracks: ResourceLike[];
  complete: boolean;
}): JSX.Element | null {
  const parts = detailSummary(kind, resource, tracks, complete);
  if (parts.length === 0) return null;
  return <p className="library-detail-meta">{parts.join(" · ")}</p>;
}

/** Collapsed notes, label and copyright; renders nothing when there are none. */
function DetailMore({
  kind,
  resource,
}: {
  kind: "album" | "playlist";
  resource: ResourceLike;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const details = detailNotes(kind, resource);
  if (!details) return null;
  return (
    <section className="library-detail-more">
      <button
        className="library-detail-more-toggle"
        type="button"
        aria-expanded={open}
        aria-controls="library-detail-more-panel"
        onClick={() => setOpen((value) => !value)}
      >
        More <ChevronDown aria-hidden="true" size={14} />
      </button>
      <div
        id="library-detail-more-panel"
        className="library-detail-more-body"
        hidden={!open}
      >
        {details.notes ? (
          <p className="library-detail-notes">{details.notes}</p>
        ) : null}
        {details.recordLabel || details.copyright ? (
          <dl className="library-detail-facts">
            {details.recordLabel ? (
              <>
                <dt>Label</dt>
                <dd>{details.recordLabel}</dd>
              </>
            ) : null}
            {details.copyright ? (
              <>
                <dt>Copyright</dt>
                <dd>{details.copyright}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </div>
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
  const state = useAppSlices("auth", "initialization", "library", "ui");
  const controller = useAppController();
  const router = useAppRouter();
  const extendedController = controller as AppController & DetailController;
  const sourceDetail =
    source === "catalog" ? readDetail(state, kind, `catalog:${id}`) : undefined;
  const detail =
    sourceDetail && sourceDetail.status !== "idle"
      ? sourceDetail
      : readDetail(state, kind, id);
  // Keyed on the raw state arrays, which keep their identity between
  // renders; `detail` and `resource` are rebuilt every render.
  const collectionItems = readCollection(
    state,
    kind === "album" ? "albums" : kind === "artist" ? "artists" : "playlists",
  ).items;
  const fallback = useMemo(
    () => findResource(collectionItems, id),
    [collectionItems, id],
  );
  const { resource: rawResource, item: rawItem } = detail;
  const { tracks: rawTracks, albums: rawAlbums, items: rawItems } = detail;
  const resource = useMemo(
    () => detailResource({ resource: rawResource, item: rawItem }, fallback),
    [rawResource, rawItem, fallback],
  );
  const resources = useMemo(
    () =>
      detailItems(
        { tracks: rawTracks, albums: rawAlbums, items: rawItems },
        resource,
      ),
    [rawTracks, rawAlbums, rawItems, resource],
  );
  // Albums newest first, so an artist's latest work leads the shelf.
  const artistAlbums = useMemo(
    () =>
      kind === "artist"
        ? [...resources].sort((left, right) =>
            String(right.releaseDate ?? "").localeCompare(
              String(left.releaseDate ?? ""),
            ),
          )
        : [],
    [kind, resources],
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
  // The page's songs, when it holds every one: Play starts from them
  // instead of fetching the pages again.
  const shownTracks = (): Track[] | undefined => {
    if (detail.next || detail.status === "loading") return undefined;
    const tracks = resources
      .map(toTrack)
      .filter((track): track is Track => Boolean(track));
    return tracks.length ? tracks : undefined;
  };
  const playCollection = (
    startIndex: number,
    trackId?: string,
  ): Promise<void> | undefined => {
    const shown = shownTracks();
    if (
      (kind === "playlist" || kind === "album") &&
      shown &&
      extendedController.playCollection
    ) {
      return extendedController.playCollection(
        kind,
        id,
        playbackSource,
        startIndex,
        { trackId, shown },
      );
    }
    if (kind === "playlist" && extendedController.playPlaylist) {
      return extendedController.playPlaylist(
        id,
        playbackSource,
        startIndex,
        trackId,
      );
    }
    if (kind === "album" && extendedController.playAlbum) {
      return extendedController.playAlbum(
        id,
        playbackSource,
        startIndex,
        trackId,
      );
    }
    const tracks = resources
      .map(toTrack)
      .filter((track): track is Track => Boolean(track));
    return tracks.length
      ? controller.playTracks(tracks, startIndex)
      : undefined;
  };
  const playTrack = (track: Track, index: number): void =>
    act(() => playCollection(index, track.id));
  const playAll = (): void => {
    if (resources.length) act(() => playCollection(0));
  };
  const shuffleAll = (): void => {
    if (kind === "artist" || !extendedController.playCollection) return;
    act(() =>
      extendedController.playCollection?.(kind, id, playbackSource, 0, {
        shuffle: true,
        shown: shownTracks(),
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
  // Totals only count songs that are all loaded; a partial list would under-state them.
  const complete = !detail.next && detail.status !== "loading";
  const artistBackdrop = isArtist ? artworkTrack?.artwork?.url : undefined;
  return (
    <>
      {offline ? <OfflineBanner /> : null}
      <section
        className={`library-detail-hero${isArtist ? " artist-hero" : ""}`}
        {...(resource ? detailContext(resource, kind) : {})}
      >
        {/* An image, not a CSS url(): the artwork URL never enters CSS. */}
        {artistBackdrop ? (
          <img
            className="artist-hero-backdrop"
            src={normalizeArtworkUrl(artistBackdrop, ARTWORK_BACKDROP_BUCKET)}
            alt=""
            aria-hidden="true"
            decoding="async"
          />
        ) : null}
        <div className="library-detail-art">
          {artworkTrack ? (
            <Artwork
              track={artworkTrack}
              size="hero"
              alt={`${title} artwork`}
              priority
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
          {kind !== "artist" && resource ? (
            <DetailSummary
              kind={kind}
              resource={resource}
              tracks={resources}
              complete={complete}
            />
          ) : null}
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
            {kind !== "artist" && resource ? (
              <DetailHeroActions
                kind={kind}
                id={id}
                title={title}
                resource={resource}
                controller={controller}
                online={authorized && !offline}
              />
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
      {kind !== "artist" && resource ? (
        <DetailMore kind={kind} resource={resource} />
      ) : null}
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
            <ol className="library-track-list artist-top-songs-grid">
              {topSongs.slice(0, ARTIST_TOP_SONGS_SHOWN).map((track, index) => (
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
          <section
            className="artist-albums"
            aria-labelledby="artist-albums-heading"
          >
            <h2 id="artist-albums-heading">Albums</h2>
            <div className="library-card-grid" aria-label="Artist albums">
              {artistAlbums.map((album) => (
                <CardShell
                  key={album.id}
                  contextData={detailContext(album, "album")}
                  catalogUrl={album.catalogUrl}
                >
                  <button
                    className="library-card"
                    type="button"
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
                      <small>
                        {/^\d{4}/u.test(String(album.releaseDate ?? ""))
                          ? String(album.releaseDate).slice(0, 4)
                          : (album.artistName ?? "Album")}
                      </small>
                    </span>
                  </button>
                  <CardActions
                    title={album.title}
                    onPlay={
                      album.playable === false
                        ? undefined
                        : () =>
                            act(() =>
                              extendedController.playCollection?.(
                                "album",
                                album.id,
                                resourceSource(album) ?? playbackSource,
                                0,
                              ),
                            )
                    }
                  />
                </CardShell>
              ))}
            </div>
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
