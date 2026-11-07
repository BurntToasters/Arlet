import type { Track } from "../domain/music.ts";
import { normalizeTrackNavigation } from "../musickit/normalize.ts";

export interface ResourceLike {
  id: string;
  type?: string;
  kind?: string;
  title: string;
  artistName?: string;
  artistId?: string;
  albumTitle?: string;
  albumId?: string;
  albumRef?: Track["albumRef"];
  artistRefs?: Track["artistRefs"];
  artwork?: Track["artwork"];
  durationMs?: number;
  explicit?: boolean;
  catalogUrl?: string;
  /** Track's position on its disc, from Apple. */
  trackNumber?: number;
  catalogId?: string;
  /** Albums: `YYYY-MM-DD` (or `YYYY`) from Apple. */
  releaseDate?: string;
  /** When the item joined the library, as an ISO time. */
  dateAdded?: string;
  playable?: boolean;
  addable?: boolean;
  parentId?: string;
  isFolder?: boolean;
  tracks?: unknown[];
  albums?: unknown[];
  children?: unknown[];
  raw: Record<string, unknown>;
}

export interface CollectionLike {
  items: unknown[];
  status: string;
  next?: string | null;
  error?: string;
  source?: string;
  lastUpdatedAt?: number | string;
  stale?: boolean;
  isStale?: boolean;
}

export function objectValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringValue(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
}

function numberValue(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
}

/** A 1-based track position from Apple; anything else is unknown. */
function positionValue(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number =>
      typeof value === "number" && Number.isInteger(value) && value > 0,
  );
}

function artworkValue(value: unknown): Track["artwork"] | undefined {
  const artwork = objectValue(value);
  if (!artwork) return undefined;
  const url = stringValue(artwork.url, artwork.href);
  if (!url) return undefined;
  const widths = Array.isArray(artwork.widths) ? artwork.widths[0] : undefined;
  const heights = Array.isArray(artwork.heights)
    ? artwork.heights[0]
    : undefined;
  return {
    url,
    width: numberValue(artwork.width, widths) ?? 300,
    height: numberValue(artwork.height, heights) ?? 300,
  };
}

/**
 * Converted items, keyed on the stored object. The store keeps earlier items
 * by identity, so a page append converts only its own items. `null` marks an
 * item that does not convert.
 */
const resourceCache = new WeakMap<object, ResourceLike | null>();
const trackCache = new WeakMap<object, Track | null>();

export function toResource(value: unknown): ResourceLike | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cached = resourceCache.get(value);
  if (cached !== undefined) return cached ?? undefined;
  const resource = convertResource(value);
  resourceCache.set(value, resource ?? null);
  return resource;
}

function convertResource(value: unknown): ResourceLike | undefined {
  const raw = objectValue(value);
  if (!raw) return undefined;
  const attributes = objectValue(raw.attributes) ?? raw;
  const id = stringValue(raw.id, attributes.id);
  if (!id) return undefined;
  const type = stringValue(
    raw.type,
    raw.resourceType,
    attributes.type,
    attributes.resourceType,
  );
  const kind = stringValue(raw.kind, attributes.kind, type);
  const title = stringValue(
    raw.title,
    raw.name,
    attributes.title,
    attributes.name,
    "Untitled",
  ) as string;
  const artist = objectValue(raw.artist) ?? objectValue(attributes.artist);
  const album = objectValue(raw.album) ?? objectValue(attributes.album);
  const artwork =
    artworkValue(raw.artwork) ??
    artworkValue(attributes.artwork) ??
    artworkValue(raw.artworkUrl) ??
    artworkValue(attributes.artworkUrl);
  const trackCollection =
    raw.tracks ?? attributes.tracks ?? objectValue(raw.relationships)?.tracks;
  const albumCollection = raw.albums ?? attributes.albums;
  const children = raw.children ?? attributes.children;
  const folder =
    raw.isFolder === true ||
    attributes.isFolder === true ||
    type?.toLowerCase().includes("folder") === true ||
    kind?.toLowerCase().includes("folder") === true;
  return {
    id,
    type,
    kind,
    title,
    ...normalizeTrackNavigation(raw),
    artistName: stringValue(
      raw.artistName,
      attributes.artistName,
      artist?.name,
      artist?.title,
    ),
    artistId: stringValue(raw.artistId, attributes.artistId, artist?.id),
    albumTitle: stringValue(
      raw.albumTitle,
      attributes.albumTitle,
      album?.name,
      album?.title,
    ),
    albumId: stringValue(raw.albumId, attributes.albumId, album?.id),
    artwork,
    durationMs: numberValue(
      raw.durationMs,
      attributes.durationInMillis,
      attributes.durationMs,
    ),
    explicit:
      typeof raw.explicit === "boolean"
        ? raw.explicit
        : typeof attributes.contentRating === "string"
          ? attributes.contentRating.toLowerCase() === "explicit"
          : undefined,
    // `href` is an API path (/v1/...), not a page link.
    catalogUrl: stringValue(raw.catalogUrl, attributes.url),
    trackNumber: positionValue(raw.trackNumber, attributes.trackNumber),
    catalogId: stringValue(raw.catalogId, attributes.catalogId),
    releaseDate: stringValue(raw.releaseDate, attributes.releaseDate),
    dateAdded: stringValue(raw.dateAdded, attributes.dateAdded),
    playable: typeof raw.playable === "boolean" ? raw.playable : undefined,
    addable: typeof raw.addable === "boolean" ? raw.addable : undefined,
    parentId: stringValue(
      raw.parentId,
      attributes.parentId,
      raw.folderId,
      attributes.folderId,
    ),
    isFolder: folder,
    tracks: Array.isArray(trackCollection) ? trackCollection : undefined,
    albums: Array.isArray(albumCollection) ? albumCollection : undefined,
    children: Array.isArray(children) ? children : undefined,
    raw,
  };
}

/** One Track per item, so rows that memoize on it keep their identity. */
export function toTrack(value: unknown): Track | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cached = trackCache.get(value);
  if (cached !== undefined) return cached ?? undefined;
  const track = trackFromResource(toResource(value));
  trackCache.set(value, track ?? null);
  return track;
}

function trackFromResource(
  resource: ResourceLike | undefined,
): Track | undefined {
  if (!resource) return undefined;
  return {
    id: resource.id,
    title: resource.title,
    artistName: resource.artistName ?? "Unknown artist",
    albumTitle: resource.albumTitle,
    albumRef: resource.albumRef,
    artistRefs: resource.artistRefs,
    artwork: resource.artwork,
    durationMs: resource.durationMs,
    explicit: resource.explicit,
    catalogUrl: resource.catalogUrl,
    trackNumber: resource.trackNumber,
    resourceType: resource.type,
    catalogId: resource.catalogId,
    playable: resource.playable,
    addable: resource.addable,
  };
}
