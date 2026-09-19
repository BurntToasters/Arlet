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

export interface Artwork {
  url: string;
  width: number;
  height: number;
}

export interface Track {
  id: MusicId;
  title: string;
  artistName: string;
  albumTitle?: string;
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
}

export interface Album {
  id: MusicId;
  title: string;
  artistName: string;
  artwork?: Artwork;
  trackCount?: number;
  resourceType?: MusicResourceType;
  source?: MusicSource;
  catalogId?: MusicId;
  playable?: boolean;
}

export interface Artist {
  id: MusicId;
  name: string;
  artwork?: Artwork;
  albumCount?: number;
  resourceType?: MusicResourceType;
  catalogId?: MusicId;
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
  };
  error?: PlayerError;
}
