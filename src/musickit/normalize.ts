import type {
  Album,
  Artist,
  Artwork,
  LibraryItem,
  MusicResourceRef,
  MusicResourceType,
  Playlist,
  PlaylistFolder,
  PlaylistTrackResourceType,
  Track,
} from "../domain/music.ts";

export interface CatalogSongResource {
  id: string;
  type?: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    durationInMillis?: number;
    artwork?: { url: string; width?: number; height?: number };
    contentRating?: string;
    playParams?: { id?: string; kind?: string; [key: string]: unknown };
    playable?: boolean;
    [key: string]: unknown;
  };
  relationships?: Record<string, unknown>;
  href?: string;
  meta?: Record<string, unknown>;
}

/** Loose descriptor accepted from MusicKit API responses. */
export interface AppleMusicResource {
  id?: unknown;
  type?: unknown;
  href?: unknown;
  attributes?: unknown;
  relationships?: unknown;
  meta?: unknown;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownRecord;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function resourceId(resource: AppleMusicResource): string | undefined {
  return stringValue(asRecord(resource)?.id);
}

function resourceType(
  resource: AppleMusicResource,
): MusicResourceType | undefined {
  return stringValue(asRecord(resource)?.type) as MusicResourceType | undefined;
}

function attributesOf(resource: AppleMusicResource): UnknownRecord {
  return asRecord(asRecord(resource)?.attributes) ?? {};
}

function relationshipsOf(resource: AppleMusicResource): UnknownRecord {
  return asRecord(asRecord(resource)?.relationships) ?? {};
}

function relationshipData(resource: AppleMusicResource, name: string): unknown {
  const relationship = asRecord(relationshipsOf(resource)[name]);
  return relationship?.data;
}

function firstResourceId(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = firstResourceId(item);
      if (id) return id;
    }
    return undefined;
  }
  return stringValue(asRecord(value)?.id);
}

function relationshipTotal(
  resource: AppleMusicResource,
  name: string,
): number | undefined {
  const relationship = asRecord(relationshipsOf(resource)[name]);
  const meta = asRecord(relationship?.meta);
  return positiveNumber(meta?.total);
}

function validArtworkUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function normalizeArtworkUrl(url: string, size: number): string {
  const dimension = Number.isFinite(size) && size > 0 ? Math.round(size) : 300;
  const source = typeof url === "string" ? url : "";
  return source
    .replace(/\{w\}/gu, String(dimension))
    .replace(/\{h\}/gu, String(dimension));
}

function artworkFromUnknown(value: unknown, size = 300): Artwork | undefined {
  const artwork = asRecord(value);
  const rawUrl = stringValue(artwork?.url);
  if (!rawUrl) return undefined;
  const url = normalizeArtworkUrl(rawUrl, size);
  if (!validArtworkUrl(url)) return undefined;
  return {
    url,
    width: Number.isFinite(size) && size > 0 ? Math.round(size) : 300,
    height: Number.isFinite(size) && size > 0 ? Math.round(size) : 300,
  };
}

export function normalizeArtwork(
  item: MusicKit.MediaItem,
  size = 300,
): Artwork | undefined {
  const record = asRecord(item);
  return (
    artworkFromUnknown(record?.artwork, size) ??
    artworkFromUnknown(
      record?.artworkURL ? { url: record.artworkURL } : undefined,
      size,
    )
  );
}

function catalogDurationMs(item: MusicKit.MediaItem): number | undefined {
  const record = asRecord(item);
  const attributes = asRecord(record?.attributes);
  const fromAttributes = positiveNumber(attributes?.durationInMillis);
  if (fromAttributes !== undefined && fromAttributes > 0) {
    return fromAttributes;
  }
  const playbackDuration = positiveNumber(record?.playbackDuration);
  if (playbackDuration !== undefined && playbackDuration > 0) {
    return playbackDuration * 1000;
  }
  return undefined;
}

export function normalizeTrack(item: MusicKit.MediaItem): Track {
  const record = asRecord(item);
  const id = stringValue(record?.id) ?? "";
  const title = stringValue(record?.title) ?? "Unknown Title";
  const artistName = stringValue(record?.artistName) ?? "Unknown Artist";
  const albumName = stringValue(record?.albumName);
  return {
    id,
    title,
    artistName,
    albumTitle: albumName,
    artwork: normalizeArtwork(item),
    durationMs: catalogDurationMs(item),
  };
}

/** Normalize a catalog song while preserving the original search shape. */
export function normalizeCatalogSong(resource: CatalogSongResource): Track {
  const record = asRecord(resource);
  const attributes = (asRecord(record?.attributes) ?? {}) as NonNullable<
    CatalogSongResource["attributes"]
  >;
  const artwork = artworkFromUnknown(attributes.artwork);
  const title = stringValue(attributes.name) ?? "Unknown Title";
  const artistName = stringValue(attributes.artistName) ?? "Unknown Artist";
  return {
    id: stringValue(record?.id) ?? "",
    title,
    artistName,
    albumTitle: stringValue(attributes.albumName),
    artwork,
    durationMs:
      typeof attributes.durationInMillis === "number" &&
      Number.isFinite(attributes.durationInMillis) &&
      attributes.durationInMillis > 0
        ? attributes.durationInMillis
        : undefined,
  };
}

function normalizeResourceTrack(
  resource: AppleMusicResource,
  type: MusicResourceType,
): Track | undefined {
  const id = resourceId(resource);
  if (!id) return undefined;
  const attributes = attributesOf(resource);
  const playParams = asRecord(attributes.playParams);
  const durationInMillis = positiveNumber(attributes.durationInMillis);
  const durationMs =
    durationInMillis !== undefined && durationInMillis > 0
      ? durationInMillis
      : undefined;
  const track: Track = {
    id,
    title: stringValue(attributes.name) ?? "Unknown Title",
    artistName: stringValue(attributes.artistName) ?? "Unknown Artist",
    albumTitle: stringValue(attributes.albumName),
    artwork: artworkFromUnknown(attributes.artwork),
    durationMs,
    resourceType: type,
    playable:
      typeof attributes.playable === "boolean"
        ? attributes.playable
        : Boolean(playParams ?? (type === "songs" || type === "library-songs")),
    addable:
      type === "songs" ||
      type === "library-songs" ||
      type === "music-videos" ||
      type === "library-music-videos",
  };
  const explicit = stringValue(attributes.contentRating);
  if (explicit) track.explicit = explicit.toLowerCase() === "explicit";
  const catalogId =
    stringValue(playParams?.catalogId) ??
    firstResourceId(relationshipData(resource, "catalog"));
  if (catalogId) track.catalogId = catalogId;
  const catalogUrl = stringValue(attributes.url) ?? stringValue(resource.href);
  if (catalogUrl) track.catalogUrl = catalogUrl;
  return track;
}

export function normalizeArtistResource(
  resource: AppleMusicResource,
): Artist | undefined {
  const id = resourceId(resource);
  if (!id) return undefined;
  const attributes = attributesOf(resource);
  const artist: Artist = {
    id,
    name:
      stringValue(attributes.name) ??
      stringValue(attributes.artistName) ??
      "Unknown Artist",
    artwork: artworkFromUnknown(attributes.artwork),
    resourceType: resourceType(resource) ?? "artists",
  };
  const albumCount =
    positiveNumber(attributes.albumCount) ??
    relationshipTotal(resource, "albums");
  if (albumCount !== undefined) artist.albumCount = albumCount;
  const catalogId = firstResourceId(relationshipData(resource, "catalog"));
  if (catalogId) artist.catalogId = catalogId;
  return artist;
}

export function normalizeAlbumResource(
  resource: AppleMusicResource,
): Album | undefined {
  const id = resourceId(resource);
  if (!id) return undefined;
  const attributes = attributesOf(resource);
  const album: Album = {
    id,
    title: stringValue(attributes.name) ?? "Unknown Album",
    artistName: stringValue(attributes.artistName) ?? "Unknown Artist",
    artwork: artworkFromUnknown(attributes.artwork),
    resourceType: resourceType(resource) ?? "albums",
  };
  const trackCount =
    positiveNumber(attributes.trackCount) ??
    relationshipTotal(resource, "tracks");
  if (trackCount !== undefined) album.trackCount = trackCount;
  const playable =
    typeof attributes.playable === "boolean"
      ? attributes.playable
      : Boolean(asRecord(attributes.playParams));
  if (playable) album.playable = true;
  const catalogId = firstResourceId(relationshipData(resource, "catalog"));
  if (catalogId) album.catalogId = catalogId;
  return album;
}

function descriptionValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const record = asRecord(value);
  return stringValue(record?.standard) ?? stringValue(record?.short);
}

export function normalizePlaylistResource(
  resource: AppleMusicResource,
): Playlist | undefined {
  const id = resourceId(resource);
  if (!id) return undefined;
  const attributes = attributesOf(resource);
  const playlist: Playlist = {
    id,
    name: stringValue(attributes.name) ?? "Untitled Playlist",
    artwork: artworkFromUnknown(attributes.artwork),
    resourceType: resourceType(resource) ?? "playlists",
  };
  const description = descriptionValue(attributes.description);
  if (description) playlist.description = description;
  const trackCount =
    positiveNumber(attributes.trackCount) ??
    relationshipTotal(resource, "tracks");
  if (trackCount !== undefined) playlist.trackCount = trackCount;
  if (typeof attributes.canEdit === "boolean")
    playlist.canEdit = attributes.canEdit;
  if (typeof attributes.canDelete === "boolean") {
    playlist.canDelete = attributes.canDelete;
  }
  if (typeof attributes.isPublic === "boolean")
    playlist.isPublic = attributes.isPublic;
  return playlist;
}

export function normalizePlaylistFolderResource(
  resource: AppleMusicResource,
): PlaylistFolder | undefined {
  const id = resourceId(resource);
  if (!id) return undefined;
  const attributes = attributesOf(resource);
  const folder: PlaylistFolder = {
    id,
    name: stringValue(attributes.name) ?? "Untitled Folder",
    resourceType: resourceType(resource) ?? "library-playlist-folders",
  };
  const parentId = firstResourceId(relationshipData(resource, "parent"));
  if (parentId) folder.parentId = parentId;
  if (typeof attributes.canEdit === "boolean")
    folder.canEdit = attributes.canEdit;
  return folder;
}

export function normalizeLibraryItemResource(
  resource: AppleMusicResource,
): LibraryItem | undefined {
  const type = resourceType(resource);
  switch (type) {
    case "songs":
    case "library-songs":
    case "music-videos":
    case "library-music-videos":
      return normalizeResourceTrack(resource, type);
    case "albums":
    case "library-albums":
      return normalizeAlbumResource(resource);
    case "artists":
    case "library-artists":
      return normalizeArtistResource(resource);
    case "playlists":
    case "library-playlists":
      return normalizePlaylistResource(resource);
    case "playlist-folders":
    case "library-playlist-folders":
      return normalizePlaylistFolderResource(resource);
    default:
      return undefined;
  }
}

/** Normalize a mixed Apple resource list and skip malformed/unknown entries. */
export function normalizeLibraryItems(resources: unknown[]): LibraryItem[] {
  const items: LibraryItem[] = [];
  for (const value of resources) {
    const resource = asRecord(value) as AppleMusicResource | undefined;
    if (!resource) continue;
    const item = normalizeLibraryItemResource(resource);
    if (item) items.push(item);
  }
  return items;
}

export function normalizeMusicResourceRef(
  value: unknown,
): MusicResourceRef | undefined {
  const record = asRecord(value);
  const id = stringValue(record?.id);
  const type = stringValue(record?.type);
  if (!id || !type) return undefined;
  if (
    type !== "songs" &&
    type !== "library-songs" &&
    type !== "music-videos" &&
    type !== "library-music-videos"
  ) {
    return undefined;
  }
  return { id, type: type as PlaylistTrackResourceType };
}

export function normalizeMusicResource(
  value: unknown,
): LibraryItem | undefined {
  const resource = asRecord(value) as AppleMusicResource | undefined;
  return resource ? normalizeLibraryItemResource(resource) : undefined;
}

export function normalizeTrackResource(
  resource: AppleMusicResource,
): Track | undefined {
  const type = resourceType(resource);
  if (
    type !== "songs" &&
    type !== "library-songs" &&
    type !== "music-videos" &&
    type !== "library-music-videos"
  ) {
    return undefined;
  }
  return normalizeResourceTrack(resource, type);
}

// Short aliases keep call sites readable while resource-suffixed names remain
// available for callers that want to make the API boundary explicit.
export const normalizeArtist = normalizeArtistResource;
export const normalizeAlbum = normalizeAlbumResource;
export const normalizePlaylist = normalizePlaylistResource;
export const normalizePlaylistFolder = normalizePlaylistFolderResource;
export const normalizeLibraryItem = normalizeLibraryItemResource;
export const normalizeTrackFromResource = normalizeTrackResource;
