import {
  AlertCircle,
  Disc3,
  LoaderCircle,
  Play,
  Radio,
  RefreshCw,
  Shuffle,
} from "lucide-preact";
import { useEffect, useMemo } from "preact/hooks";
import type { JSX } from "preact";
import {
  useAppController,
  useAppSelector,
  useAppSlices,
} from "../app/context.tsx";
import { Artwork } from "../components/Artwork.tsx";
import {
  canEditOf,
  editInAppleMusicAttribute,
} from "../components/context-target.ts";
import { EmptyState } from "./EmptyState.tsx";
import { readCollection, readDetail, toTrack } from "./LibraryView.tsx";
import type { AlbumShelves, Track } from "../domain/music.ts";
import {
  ARTWORK_BACKDROP_BUCKET,
  normalizeArtworkUrl,
} from "../musickit/normalize.ts";
import { OfflineBanner } from "../components/OfflineBanner.tsx";
import { detailContext, resourceSource } from "./detail-context.ts";
import { AlbumPageShelves } from "./AlbumShelves.tsx";
import {
  ARTIST_TOP_SONGS_SHOWN,
  ArtistBio,
  ArtistShelves,
  ArtistShelvesSkeleton,
  artistBannerOf,
  artistBioOf,
  artistHasShelves,
  artistShelvesOf,
} from "./ArtistShelves.tsx";
import {
  act,
  callLoader,
  detailCopy,
  detailItems,
  detailResource,
  findResource,
  type DetailKind,
  type DetailSource,
} from "./library-detail-helpers.ts";
import { DetailHeroActions } from "./library-detail-hero-actions.tsx";
import { DetailMore } from "./library-detail-more.tsx";
import {
  DetailSummary,
  usePlaylistCurator,
} from "./library-detail-summary.tsx";
import { TrackList } from "./library-detail-track-list.tsx";
import { useArtistTopSongs } from "./library-detail-artist.ts";

export function LibraryDetailView({
  kind,
  id,
  source,
}: {
  kind: DetailKind;
  id: string;
  source?: DetailSource;
}): JSX.Element {
  const state = useAppSlices("auth", "initialization", "library");
  const controller = useAppController();
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
        ? controller.loadAlbum
        : kind === "artist"
          ? controller.loadArtist
          : controller.loadPlaylist;
    callLoader(loader, id, source);
  }, [
    authorized,
    offline,
    controller.loadAlbum,
    controller.loadArtist,
    controller.loadPlaylist,
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
    if ((kind === "playlist" || kind === "album") && shown) {
      return controller.playCollection(kind, id, playbackSource, startIndex, {
        trackId,
        shown,
      });
    }
    if (kind === "playlist") {
      return controller.playPlaylist(id, playbackSource, startIndex, trackId);
    }
    if (kind === "album") {
      return controller.playAlbum(id, playbackSource, startIndex, trackId);
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
    if (kind === "artist") return;
    act(() =>
      controller.playCollection(kind, id, playbackSource, 0, {
        shuffle: true,
        shown: shownTracks(),
      }),
    );
  };
  // The artist's shelves come with its one request. Top songs are read on
  // their own only when that request lacked them, and only once it settled.
  const artistShelves =
    kind === "artist" ? artistShelvesOf(resource) : undefined;
  const viewTopSongs = artistShelves?.topSongs;
  // Only a settled detail counts: before the first read lands the status is
  // still idle, and the fallback would fire ahead of the artist request.
  const topSongsFallback =
    kind === "artist" &&
    authorized &&
    detail.status === "success" &&
    viewTopSongs === undefined;
  const fallbackTopSongs = useArtistTopSongs(
    controller,
    topSongsFallback,
    id,
    playbackSource,
    resource?.catalogId,
  );
  // Only a catalog playlist's "Curated by" needs its curator's id.
  const playlistCurator = usePlaylistCurator(
    controller,
    authorized &&
      kind === "playlist" &&
      source === "catalog" &&
      Boolean(resource?.raw.curatorName),
    id,
  );
  const topSongs = (viewTopSongs ?? fallbackTopSongs ?? []).slice(
    0,
    ARTIST_TOP_SONGS_SHOWN,
  );
  const topSongsPending = topSongsFallback && fallbackTopSongs === undefined;
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
  const pending = useAppSelector((store) => store.ui.pendingCollection);
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
    if (kind === "artist") return <ArtistShelvesSkeleton />;
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
                  ? controller.loadAlbum
                  : kind === "artist"
                    ? controller.loadArtist
                    : controller.loadPlaylist;
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
  // Album and playlist headers glow behind their cover; artist pages keep
  // their own banner/backdrop selectors (e2e-discovery checks those).
  const detailBackdrop =
    !isArtist && artworkTrack?.artwork?.url
      ? artworkTrack.artwork.url
      : undefined;
  // Totals only count songs that are all loaded; a partial list would under-state them.
  const complete = !detail.next && detail.status !== "loading";
  // Apple's editorial banner when it has one; otherwise the blurred portrait.
  const artistBanner = isArtist ? artistBannerOf(resource) : undefined;
  const artistBackdrop =
    isArtist && !artistBanner ? artworkTrack?.artwork?.url : undefined;
  const artistBio = isArtist ? artistBioOf(resource) : undefined;
  const albumShelves =
    kind === "album" && resource
      ? (resource.raw.shelves as AlbumShelves | undefined)
      : undefined;
  // Nothing but the header: no albums, top songs or other shelves came back.
  const artistEmpty =
    isArtist &&
    artistAlbums.length === 0 &&
    topSongs.length === 0 &&
    !topSongsPending &&
    !artistHasShelves(artistShelves);
  return (
    <>
      {offline ? <OfflineBanner /> : null}
      <section
        className={`library-detail-hero${isArtist ? " artist-hero" : ""}${
          detailBackdrop ? " has-hero-backdrop" : ""
        }`}
        {...(resource ? detailContext(resource, kind) : {})}
        {...(resource && kind === "playlist"
          ? editInAppleMusicAttribute(
              resourceSource(resource),
              canEditOf(resource.raw),
            )
          : {})}
      >
        {/* Images, not CSS url(): the artwork URL never enters CSS. */}
        {artistBanner ? (
          <img
            className="artist-hero-banner"
            src={artistBanner}
            alt=""
            aria-hidden="true"
            decoding="async"
          />
        ) : null}
        {artistBackdrop ? (
          <img
            className="artist-hero-backdrop"
            src={normalizeArtworkUrl(artistBackdrop, ARTWORK_BACKDROP_BUCKET)}
            alt=""
            aria-hidden="true"
            decoding="async"
          />
        ) : null}
        {detailBackdrop ? (
          <img
            className="detail-hero-backdrop"
            src={normalizeArtworkUrl(detailBackdrop, ARTWORK_BACKDROP_BUCKET)}
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
              curator={playlistCurator}
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
            {!isArtist && resources.length ? (
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
                    ? controller.loadAlbum
                    : kind === "artist"
                      ? controller.loadArtist
                      : controller.loadPlaylist;
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
      {artistBio ? <ArtistBio key={id} notes={artistBio} /> : null}
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
        artistEmpty ? (
          <EmptyState
            icon={Disc3}
            title="No albums found"
            description="Apple Music did not return albums for this artist."
            compact
          />
        ) : (
          <ArtistShelves
            shelves={artistShelves}
            albums={artistAlbums}
            topSongs={topSongs}
            topSongsPending={topSongsPending}
            authorized={authorized}
            playbackSource={playbackSource}
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
      {kind === "album" && resource ? (
        <AlbumPageShelves
          shelves={albumShelves}
          artistName={resource.artistName}
        />
      ) : null}
    </>
  );
}
