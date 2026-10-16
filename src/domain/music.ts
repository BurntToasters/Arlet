import type { PlayerError } from "./errors.ts";

export type MusicId = string;

/** Apple Music API resource origin used by navigation and detail loaders. */
export type MusicSource = "catalog" | "library";

/** Resource types returned by Apple Music API. */
export type MusicResourceType =
  | "songs"
  | "albums"
  | "artists"
  | "playlists"
  | "playlist-folders"
  | "music-videos"
  | "library-songs"
  | "library-albums"
  | "library-artists"
  | "library-playlists"
  | "library-playlist-folders"
  | "library-music-videos"
  | "stations"
  | "radio-stations"
  | "live-radio-stations"
  | (string & {});

/** Track resource types accepted by Apple playlist append requests. */
export type PlaylistTrackResourceType =
  "songs" | "library-songs" | "music-videos" | "library-music-videos";

export interface MusicResourceRef {
  id: MusicId;
  type: PlaylistTrackResourceType;
}

/** A routable album or artist relationship carried by a song. */
/**
 * Library IDs carry an `i.`, `l.` or `p.` prefix; catalog song IDs are all
 * digits. MusicKit can report a library type on a catalog ID (library
 * playlist songs), so an unambiguous ID decides library or catalog; any other
 * ID keeps its type.
 */
export function idSource(id: string): MusicSource | undefined {
  const trimmed = id.trim();
  if (/^[ilp]\./u.test(trimmed)) return "library";
  if (/^\d+$/u.test(trimmed)) return "catalog";
  return undefined;
}

/** Library or catalog type for a song, keeping its kind (songs, music-videos). */
export function resourceTypeForId(
  id: string,
  type: string | undefined,
): string {
  const kind = (type ?? "songs").replace(/^library-/u, "") || "songs";
  const source =
    idSource(id) ?? (type?.startsWith("library-") ? "library" : "catalog");
  return source === "library" ? `library-${kind}` : kind;
}

export interface MusicEntityRef {
  id: MusicId;
  name?: string;
  source: MusicSource;
}

export interface Artwork {
  url: string;
  width: number;
  height: number;
  /** Apple's dominant color: six lowercase hex digits, no '#'. Absent when unknown. */
  bgColor?: string;
}

export interface Track {
  id: MusicId;
  title: string;
  artistName: string;
  albumTitle?: string;
  albumRef?: MusicEntityRef;
  artistRefs?: MusicEntityRef[];
  artwork?: Artwork;
  durationMs?: number;
  explicit?: boolean;
  catalogUrl?: string;
  /** Apple resource type. Optional to keep existing local/catalog callers valid. */
  resourceType?: MusicResourceType;
  /** Catalog ID for a library resource whose playback ID differs. */
  catalogId?: MusicId;
  /** Whether Apple reports this resource as playable. */
  playable?: boolean;
  /** Whether this resource can be appended to an Apple Music playlist. */
  addable?: boolean;
  /** Disc the song sits on in its album, from Apple. */
  discNumber?: number;
  /** Position on its disc, from Apple. */
  trackNumber?: number;
}

export interface Album {
  id: MusicId;
  title: string;
  artistName: string;
  /** `YYYY-MM-DD` (or `YYYY`) from Apple, when known. */
  releaseDate?: string;
  artwork?: Artwork;
  trackCount?: number;
  resourceType?: MusicResourceType;
  source?: MusicSource;
  catalogId?: MusicId;
  playable?: boolean;
  /** Plain-text editorial notes; Apple's HTML tags are removed. */
  editorialNotes?: string;
  recordLabel?: string;
  copyright?: string;
  genreNames?: string[];
  isSingle?: boolean;
  isCompilation?: boolean;
  /** Apple Music web link from Apple; the context menu validates it on use. */
  catalogUrl?: string;
}

export interface Artist {
  id: MusicId;
  name: string;
  artwork?: Artwork;
  albumCount?: number;
  resourceType?: MusicResourceType;
  catalogId?: MusicId;
  /** Apple Music web link from Apple; the context menu validates it on use. */
  catalogUrl?: string;
}

export interface Playlist {
  id: MusicId;
  name: string;
  description?: string;
  artwork?: Artwork;
  trackCount?: number;
  canEdit?: boolean;
  canDelete?: boolean;
  isPublic?: boolean;
  resourceType?: MusicResourceType;
  source?: MusicSource;
  /** Parent folder when the playlist was loaded through a folder relationship. */
  parentId?: MusicId;
  /** Apple's curator for a catalog playlist. */
  curatorName?: string;
  /** Apple Music web link from Apple; the context menu validates it on use. */
  catalogUrl?: string;
}

export interface PlaylistFolder {
  id: MusicId;
  name: string;
  parentId?: MusicId;
  canEdit?: boolean;
  resourceType?: MusicResourceType;
  /** Loaded children preserve the Apple Music folder hierarchy. */
  children?: LibraryItem[];
}

export interface PinnedPlaylist {
  id: MusicId;
  source: MusicSource;
  /** Saved with the pin so the sidebar can name it before the list loads. */
  name?: string;
  /** Artwork URL template saved with the pin, for the same reason. */
  artworkUrl?: string;
}

export interface Station {
  id: MusicId;
  name: string;
  description?: string;
  artwork?: Artwork;
  url?: string;
  isLive: boolean;
  resourceType?: MusicResourceType;
}

/** Catalog resources Apple groups together in personalized recommendations. */
export type DiscoveryResource = Album | Playlist;

export interface RecommendationSection {
  id: string;
  title: string;
  items: DiscoveryResource[];
  kind?: string;
  reason?: string;
}

export type LibraryItem = Track | Album | Artist | Playlist | PlaylistFolder;

export interface PlaybackState {
  status: "idle" | "loading" | "playing" | "paused" | "stopped" | "error";
  current?: Track;
  positionSeconds: number;
  durationSeconds: number;
  volume: number;
  queue: Track[];
  queueIndex: number;
  shuffleMode?: "off" | "songs";
  repeatMode?: "off" | "all" | "one";
  modeCapabilities?: {
    shuffle: boolean;
    repeat: boolean;
    /** True when the runtime exposes a writable `autoplayEnabled`. */
    autoplay?: boolean;
  };
  /** Session-only mute. Never persisted; `volume` keeps the unmuted level. */
  muted?: boolean;
  /** A restored queue waits here until the first play request. */
  pendingRestore?: PendingPlaybackRestore;
  sleepTimer?: SleepTimerState;
  /** Songs from a capped playlist still waiting to be added to the queue. */
  queueRest?: number;
  error?: PlayerError;
}

export interface PendingPlaybackRestore {
  positionSeconds: number;
  savedAt: number;
}

export type SleepTimerState =
  { mode: "minutes"; endsAt: number } | { mode: "endOfTrack" };

/** Apple rating: 1 loved, -1 disliked, 0 none. */
export type RatingValue = 1 | -1 | 0;

/**
 * True when two tracks are the same song. Library rows carry `i.…` IDs while
 * MusicKit's now-playing item may carry the catalog ID, so either ID counts.
 * Empty IDs never match.
 */
export function isSameTrack(
  a: Pick<Track, "id" | "catalogId"> | undefined,
  b: Pick<Track, "id" | "catalogId"> | undefined,
): boolean {
  if (!a || !b) return false;
  const ids = new Set([a.id, a.catalogId].filter(Boolean));
  return [b.id, b.catalogId].some((id) => Boolean(id) && ids.has(id));
}
