import type { JSX } from "preact";
import { useAppController, useAppRouter } from "../app/context.tsx";
import { reportActionError } from "../components/action-errors.ts";
import { Artwork } from "../components/Artwork.tsx";
import { CardActions, CardShell } from "../components/CardActions.tsx";
import type { AlbumShelves, MusicSource } from "../domain/music.ts";
import { detailContext, resourceSource } from "./detail-context.ts";
import { releaseYear } from "./detail-meta.ts";
import { toResource, toTrack, type ResourceLike } from "./LibraryView.tsx";

/** Runs a card's action; a failure becomes a toast, as on the detail page. */
export function runCardAction(
  action: () => Promise<unknown> | undefined,
): void {
  void Promise.resolve(action()).catch(reportActionError);
}

/** Domain shelf entries as card resources; entries that do not convert are dropped. */
export function shelfResources(
  items: readonly unknown[] | undefined,
): ResourceLike[] {
  return (items ?? [])
    .map((item) => toResource(item))
    .filter((item): item is ResourceLike => Boolean(item));
}

/** One album card: opens the album, with Play and "..." beside the button. */
export function AlbumCard({
  album,
  fallbackSource,
  featured = false,
}: {
  album: ResourceLike;
  /** Origin for albums whose type does not say (catalog shelves pass "catalog"). */
  fallbackSource: MusicSource;
  /** The larger card that leads a page, such as the latest release. */
  featured?: boolean;
}): JSX.Element {
  const router = useAppRouter();
  const controller = useAppController();
  const source = resourceSource(album) ?? fallbackSource;
  return (
    <CardShell
      contextData={detailContext(album, "album")}
      catalogUrl={album.catalogUrl}
    >
      <button
        className={`library-card${featured ? " artist-featured-card" : ""}`}
        type="button"
        onClick={() => router.navigate({ kind: "album", id: album.id, source })}
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
            {releaseYear(album.releaseDate) ?? album.artistName ?? "Album"}
          </small>
        </span>
      </button>
      <CardActions
        title={album.title}
        onPlay={
          album.playable === false
            ? undefined
            : () =>
                runCardAction(() =>
                  controller.playCollection?.("album", album.id, source, 0),
                )
        }
      />
    </CardShell>
  );
}

/** A grid of album cards; the label names the grid for assistive tech. */
export function AlbumCardGrid({
  albums,
  label,
  fallbackSource,
}: {
  albums: readonly ResourceLike[];
  label: string;
  fallbackSource: MusicSource;
}): JSX.Element {
  return (
    <div className="library-card-grid" aria-label={label}>
      {albums.map((album) => (
        <AlbumCard
          key={album.id}
          album={album}
          fallbackSource={fallbackSource}
        />
      ))}
    </div>
  );
}

/**
 * The album page's shelves under its track list. Apple's "more by", other
 * versions and related albums; a shelf Apple left empty is not shown.
 */
export function AlbumPageShelves({
  shelves,
  artistName,
}: {
  shelves?: AlbumShelves;
  artistName?: string;
}): JSX.Element | null {
  const sections = [
    {
      id: "album-more-by",
      title: artistName ? `More by ${artistName}` : "More by this artist",
      albums: shelfResources(shelves?.moreByArtist),
    },
    {
      id: "album-other-versions",
      title: "Other Versions",
      albums: shelfResources(shelves?.otherVersions),
    },
    {
      id: "album-related",
      title: "Related Albums",
      albums: shelfResources(shelves?.relatedAlbums),
    },
  ].filter((section) => section.albums.length > 0);
  if (sections.length === 0) return null;
  return (
    <>
      {sections.map((section) => (
        <section
          key={section.id}
          id={section.id}
          className="album-shelf"
          aria-labelledby={`${section.id}-heading`}
        >
          <h2 id={`${section.id}-heading`}>{section.title}</h2>
          <AlbumCardGrid
            albums={section.albums}
            label={section.title}
            fallbackSource="catalog"
          />
        </section>
      ))}
    </>
  );
}
