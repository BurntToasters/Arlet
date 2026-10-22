import type { JSX } from "preact";
import { useAppRouter } from "../app/context.tsx";
import type { Artwork } from "../domain/music.ts";
import { Artwork as ArtworkImage } from "./Artwork.tsx";
import { CardActions, CardShell } from "./CardActions.tsx";

export interface SearchTileProps {
  title: string;
  /** Second line, such as the artist or curator name. */
  subtitle: string;
  /** Result type label, such as "Album" or "Station". */
  kindLabel: string;
  artwork?: Artwork;
  /** Context-menu attributes; the "..." button reads them. */
  contextData?: Record<string, string>;
  catalogUrl?: string;
  /** Opens the result. Omit for a result that cannot be opened (curators). */
  onOpen?: () => void;
  /** Starts playback. Omit for results that cannot play. */
  onPlay?: () => void;
  /** Shows the "..." button; needs contextData to have anything to show. */
  menu?: boolean;
  /** Adds the larger top-result layout. */
  featured?: boolean;
}

/**
 * Card for a search result that has no album-style tile: the top result,
 * stations, and curators. Rows stay in the Play/More pattern of CardShell.
 */
export function SearchTile({
  title,
  subtitle,
  kindLabel,
  artwork,
  contextData,
  catalogUrl,
  onOpen,
  onPlay,
  menu = false,
  featured = false,
}: SearchTileProps): JSX.Element {
  const body = (
    <>
      <ArtworkImage
        track={{ title, artistName: subtitle, artwork }}
        size={featured ? "xl" : "lg"}
        alt={`${title} artwork`}
        className="search-tile-art"
      />
      <span className="search-tile-copy">
        <small className="search-tile-kind">{kindLabel}</small>
        <strong title={title}>{title}</strong>
        <small>{subtitle}</small>
      </span>
    </>
  );
  return (
    <CardShell contextData={contextData} catalogUrl={catalogUrl}>
      {onOpen ? (
        <button
          className={`search-tile${featured ? " search-tile-featured" : ""}`}
          type="button"
          onClick={onOpen}
        >
          {body}
        </button>
      ) : (
        <div
          className={`search-tile is-static${featured ? " search-tile-featured" : ""}`}
        >
          {body}
        </div>
      )}
      {onPlay || menu ? (
        <CardActions title={title} onPlay={onPlay} menu={menu} />
      ) : null}
    </CardShell>
  );
}

/**
 * An Apple curator result. The tile is the same keyboard-reachable button as
 * the other search tiles, and opens the curator's page.
 */
export function CuratorSearchTile({
  curator,
  featured = false,
}: {
  curator: { id: string; name: string; artwork?: Artwork };
  featured?: boolean;
}): JSX.Element {
  const router = useAppRouter();
  return (
    <SearchTile
      title={curator.name}
      subtitle="Curator"
      kindLabel="Curator"
      artwork={curator.artwork}
      featured={featured}
      onOpen={() =>
        router.navigate({
          kind: "curator",
          id: curator.id,
          curatorKind: "apple",
        })
      }
    />
  );
}
