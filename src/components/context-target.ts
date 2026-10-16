import type { RatingTarget } from "../app/ratings.ts";
import type { MusicEntityRef, MusicSource, Track } from "../domain/music.ts";
import type { Route } from "../routing/router.ts";

export type ContextKind = "track" | "album" | "artist" | "playlist" | "folder";

export interface ContextTarget {
  kind?: ContextKind;
  id?: string;
  title?: string;
  artistName?: string;
  albumTitle?: string;
  artworkUrl?: string;
  resourceType?: string;
  catalogId?: string;
  /** Validated Apple Music web link; see catalogLinkOf. */
  catalogUrl?: string;
  source?: "library" | "catalog";
  route?: Route;
  albumRef?: MusicEntityRef;
  artistRefs?: MusicEntityRef[];
  parentKind?: "album" | "playlist";
  parentId?: string;
  parentSource?: MusicSource;
  parentIndex?: number;
  queueIndex?: number;
}

const APPLE_MUSIC_HOST = "music.apple.com";

export function closestContextTarget(
  node: EventTarget | null,
): HTMLElement | null {
  return node instanceof HTMLElement
    ? node.closest<HTMLElement>("[data-context-kind], [data-context-track-id]")
    : null;
}

/**
 * Accepts only an https link on music.apple.com. Anything else, including
 * other Apple hosts and links with credentials, yields undefined.
 */
export function catalogLinkOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== APPLE_MUSIC_HOST ||
    url.username ||
    url.password ||
    url.port
  ) {
    return undefined;
  }
  return url.href;
}

function parseEntityRef(value: unknown): MusicEntityRef | undefined {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) return undefined;
  const type = typeof record.type === "string" ? record.type : "";
  const source =
    record.source === "catalog" || type.startsWith("catalog")
      ? "catalog"
      : "library";
  const name =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : undefined;
  return { id: record.id, source, ...(name ? { name } : {}) };
}

function parseEntityRefs(value: unknown): MusicEntityRef[] {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(candidate)) return [];
  return candidate
    .map(parseEntityRef)
    .filter((ref): ref is MusicEntityRef => ref !== undefined);
}

export function parseTarget(node: HTMLElement | null): ContextTarget {
  if (!node) return {};
  const kind = node.dataset.contextKind as ContextKind | undefined;
  const routeKind = node.dataset.contextRouteKind as Route["kind"] | undefined;
  const source =
    node.dataset.contextSource === "catalog"
      ? "catalog"
      : node.dataset.contextSource === "library"
        ? "library"
        : undefined;
  const parentKind =
    node.dataset.contextParentKind === "album" ||
    node.dataset.contextParentKind === "playlist"
      ? node.dataset.contextParentKind
      : undefined;
  const parentIndex = Number(node.dataset.contextParentIndex);
  const queueIndex = Number(node.dataset.contextQueueIndex);
  let route: Route | undefined;
  if (
    routeKind === "album" ||
    routeKind === "artist" ||
    routeKind === "playlist"
  ) {
    const id = node.dataset.contextId;
    if (id) {
      route =
        source === "catalog"
          ? { kind: routeKind, id, source }
          : { kind: routeKind, id };
    }
  }
  const rawAlbumRef = parseEntityRef(node.dataset.contextAlbumRef);
  const albumRef =
    rawAlbumRef ??
    (node.dataset.contextAlbumId
      ? parseEntityRef({
          id: node.dataset.contextAlbumId,
          name: node.dataset.contextAlbum,
          source: node.dataset.contextAlbumSource,
        })
      : undefined);
  return {
    kind,
    id: node.dataset.contextId ?? node.dataset.contextTrackId,
    title: node.dataset.contextTitle,
    artistName: node.dataset.contextArtist,
    albumTitle: node.dataset.contextAlbum,
    artworkUrl: node.dataset.contextArtwork,
    resourceType: node.dataset.contextResourceType,
    catalogId: node.dataset.contextCatalogId,
    catalogUrl: catalogLinkOf(node.dataset.contextCatalogUrl),
    source,
    route,
    albumRef,
    artistRefs: parseEntityRefs(node.dataset.contextArtistRefs),
    parentKind,
    parentId: node.dataset.contextParentId,
    parentSource:
      node.dataset.contextParentSource === "catalog" ? "catalog" : "library",
    parentIndex:
      Number.isInteger(parentIndex) && parentIndex >= 0
        ? parentIndex
        : undefined,
    queueIndex:
      Number.isInteger(queueIndex) && queueIndex >= 0 ? queueIndex : undefined,
  };
}

const RATING_DEFAULT_TYPE: Partial<Record<ContextKind, string>> = {
  track: "songs",
  album: "albums",
  playlist: "playlists",
};

export function ratingTargetOf(
  target: ContextTarget,
): RatingTarget | undefined {
  const fallback = target.kind ? RATING_DEFAULT_TYPE[target.kind] : undefined;
  if (!target.id || !fallback) return undefined;
  return { type: target.resourceType ?? fallback, id: target.id };
}

export function targetTrack(target: ContextTarget): Track | undefined {
  if (!target.id || target.kind !== "track") return undefined;
  return {
    id: target.id,
    title: target.title ?? "Unknown song",
    artistName: target.artistName ?? "Unknown artist",
    albumTitle: target.albumTitle,
    artwork: target.artworkUrl
      ? { url: target.artworkUrl, width: 300, height: 300 }
      : undefined,
    resourceType: target.resourceType,
    catalogId: target.catalogId,
    albumRef: target.albumRef,
    artistRefs: target.artistRefs,
  };
}
