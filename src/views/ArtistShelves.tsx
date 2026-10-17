import { ChevronDown } from "lucide-preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { useAppController, useAppRouter } from "../app/context.tsx";
import { Artwork } from "../components/Artwork.tsx";
import { CardActions, CardShell } from "../components/CardActions.tsx";
import { SongRow } from "../components/SongRow.tsx";
import {
  SkeletonCardGrid,
  SkeletonRows,
  SkeletonStatus,
} from "../components/Skeleton.tsx";
import type { ArtistShelves, MusicSource, Track } from "../domain/music.ts";
import {
  AlbumCardGrid,
  runCardAction,
  shelfResources,
  AlbumCard,
} from "./AlbumShelves.tsx";
import { detailContext, resourceSource } from "./detail-context.ts";
import { toResource, toTrack, type ResourceLike } from "./LibraryView.tsx";

/** Top Songs rows an artist page shows; Play still uses those same songs. */
export const ARTIST_TOP_SONGS_SHOWN = 10;

/** The artist's shelves; undefined on detail rows saved before they existed. */
export function artistShelvesOf(
  resource: ResourceLike | undefined,
): ArtistShelves | undefined {
  const shelves = resource?.raw.shelves;
  return shelves && typeof shelves === "object"
    ? (shelves as ArtistShelves)
    : undefined;
}

/** Bio text; Apple's HTML was already turned into plain text when it was read. */
export function artistBioOf(
  resource: ResourceLike | undefined,
): string | undefined {
  const notes = resource?.raw.editorialNotes;
  return typeof notes === "string" && notes.trim() ? notes : undefined;
}

/** URL of the wide editorial banner, when Apple sent one. */
export function artistBannerOf(
  resource: ResourceLike | undefined,
): string | undefined {
  const banner = resource?.raw.editorialBanner as { url?: unknown } | undefined;
  return typeof banner?.url === "string" && banner.url ? banner.url : undefined;
}

/** True when a shelf other than Albums and Top Songs has entries. */
export function artistHasShelves(shelves: ArtistShelves | undefined): boolean {
  return [
    shelves?.latestRelease,
    shelves?.singles,
    shelves?.liveAlbums,
    shelves?.compilations,
    shelves?.appearsOn,
    shelves?.playlists,
    shelves?.similarArtists,
  ].some((items) => (items?.length ?? 0) > 0);
}

/** Labelled region; a heading names it for assistive tech. */
function Shelf({
  id,
  title,
  className = "artist-shelf",
  children,
}: {
  id: string;
  title: string;
  className?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section id={id} className={className} aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>{title}</h2>
      {children}
    </section>
  );
}

/** Album shelf that hides itself when Apple returned no albums for it. */
function AlbumShelf({
  id,
  title,
  albums,
}: {
  id: string;
  title: string;
  albums: ResourceLike[];
}): JSX.Element | null {
  if (albums.length === 0) return null;
  return (
    <Shelf id={id} title={title}>
      <AlbumCardGrid albums={albums} label={title} fallbackSource="catalog" />
    </Shelf>
  );
}

function TopSongs({
  tracks,
  pending,
  authorized,
}: {
  tracks: Track[];
  /** The separate top-songs read is still in flight. */
  pending: boolean;
  authorized: boolean;
}): JSX.Element {
  const controller = useAppController();
  return (
    <Shelf id="top-songs" title="Top Songs" className="artist-top-songs">
      <div className="library-list-panel">
        {pending ? (
          <SkeletonStatus label="Loading top songs">
            <SkeletonRows count={5} />
          </SkeletonStatus>
        ) : (
          <ol className="library-track-list artist-top-songs-grid">
            {tracks.map((track, index) => (
              <SongRow
                key={`${track.id}:${index}`}
                track={track}
                index={index}
                onPlay={() =>
                  runCardAction(() => controller.playTracks(tracks, index))
                }
                onPlayNext={() =>
                  runCardAction(() => controller.playNextTracks([track]))
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
        )}
      </div>
    </Shelf>
  );
}

/** The featured card for the newest release. */
function LatestRelease({
  album,
  fallbackSource,
}: {
  album: ResourceLike;
  fallbackSource: MusicSource;
}): JSX.Element {
  return (
    <Shelf id="artist-latest" title="Latest Release">
      <AlbumCard album={album} fallbackSource={fallbackSource} featured />
    </Shelf>
  );
}

function PlaylistCard({ playlist }: { playlist: ResourceLike }): JSX.Element {
  const router = useAppRouter();
  const controller = useAppController();
  const source = resourceSource(playlist) ?? "catalog";
  const curator =
    typeof playlist.raw.curatorName === "string"
      ? playlist.raw.curatorName
      : undefined;
  return (
    <CardShell
      contextData={detailContext(playlist, "playlist")}
      catalogUrl={playlist.catalogUrl}
    >
      <button
        className="library-card"
        type="button"
        onClick={() =>
          router.navigate({ kind: "playlist", id: playlist.id, source })
        }
      >
        <Artwork
          track={toTrack(playlist)}
          size="lg"
          alt={`${playlist.title} artwork`}
          className="library-card-art"
        />
        <span className="library-card-copy">
          <strong>{playlist.title}</strong>
          <small>{curator ?? "Playlist"}</small>
        </span>
      </button>
      <CardActions
        title={playlist.title}
        onPlay={() =>
          runCardAction(() =>
            controller.playCollection("playlist", playlist.id, source, 0),
          )
        }
      />
    </CardShell>
  );
}

/** A round card for a similar artist; opens that artist's page. */
function SimilarArtistCard({ artist }: { artist: ResourceLike }): JSX.Element {
  const router = useAppRouter();
  const source = resourceSource(artist) ?? "catalog";
  return (
    <CardShell
      contextData={detailContext(artist, "artist")}
      catalogUrl={artist.catalogUrl}
    >
      <button
        className="library-card"
        type="button"
        onClick={() =>
          router.navigate({ kind: "artist", id: artist.id, source })
        }
      >
        <Artwork
          track={toTrack(artist)}
          size="lg"
          alt={`${artist.title} artwork`}
          className="library-card-art artist-card-art"
        />
        <span className="library-card-copy">
          <strong>{artist.title}</strong>
          <small>Artist</small>
        </span>
      </button>
      <CardActions title={artist.title} />
    </CardShell>
  );
}

/**
 * Everything under an artist's banner, in Apple's order. Every shelf hides
 * itself when empty; the caller decides whether the whole page is empty.
 */
export function ArtistShelves({
  shelves,
  albums,
  topSongs,
  topSongsPending,
  authorized,
  playbackSource,
}: {
  shelves?: ArtistShelves;
  /** The artist's albums, newest first. */
  albums: ResourceLike[];
  topSongs: Track[];
  topSongsPending: boolean;
  authorized: boolean;
  playbackSource: MusicSource;
}): JSX.Element {
  const latest = toResource(shelves?.latestRelease?.[0]);
  const playlists = shelfResources(shelves?.playlists);
  const similar = shelfResources(shelves?.similarArtists);
  return (
    <>
      {latest ? (
        <LatestRelease album={latest} fallbackSource={playbackSource} />
      ) : null}
      {topSongs.length || topSongsPending ? (
        <TopSongs
          tracks={topSongs}
          pending={topSongsPending}
          authorized={authorized}
        />
      ) : null}
      {albums.length ? (
        <Shelf id="artist-albums" title="Albums" className="artist-albums">
          <AlbumCardGrid
            albums={albums}
            label="Artist albums"
            fallbackSource={playbackSource}
          />
        </Shelf>
      ) : null}
      <AlbumShelf
        id="artist-singles"
        title="Singles & EPs"
        albums={shelfResources(shelves?.singles)}
      />
      <AlbumShelf
        id="artist-live"
        title="Live Albums"
        albums={shelfResources(shelves?.liveAlbums)}
      />
      <AlbumShelf
        id="artist-compilations"
        title="Compilations"
        albums={shelfResources(shelves?.compilations)}
      />
      <AlbumShelf
        id="artist-appears-on"
        title="Appears On"
        albums={shelfResources(shelves?.appearsOn)}
      />
      {playlists.length ? (
        <Shelf id="artist-essentials" title="Essentials">
          <div className="library-card-grid" aria-label="Essentials">
            {playlists.map((playlist) => (
              <PlaylistCard key={playlist.id} playlist={playlist} />
            ))}
          </div>
        </Shelf>
      ) : null}
      {similar.length ? (
        <Shelf id="artist-similar" title="Similar Artists">
          <div className="library-card-grid" aria-label="Similar artists">
            {similar.map((artist) => (
              <SimilarArtistCard key={artist.id} artist={artist} />
            ))}
          </div>
        </Shelf>
      ) : null}
    </>
  );
}

/** Placeholder shelves while the artist's first request is in flight. */
export function ArtistShelvesSkeleton(): JSX.Element {
  return (
    <SkeletonStatus label="Loading artist">
      <SkeletonRows count={5} />
      <SkeletonCardGrid count={6} />
    </SkeletonStatus>
  );
}

/** Collapsed bio under the header, like an album's "More". */
export function ArtistBio({ notes }: { notes: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <section className="library-detail-more artist-bio">
      <button
        className="library-detail-more-toggle"
        type="button"
        aria-expanded={open}
        aria-controls="artist-bio-panel"
        onClick={() => setOpen((value) => !value)}
      >
        More <ChevronDown aria-hidden="true" size={14} />
      </button>
      <div
        id="artist-bio-panel"
        className="library-detail-more-body"
        hidden={!open}
      >
        {/* Plain text: Apple's line breaks survive, its markup does not. */}
        <p className="library-detail-notes">{notes}</p>
      </div>
    </section>
  );
}
