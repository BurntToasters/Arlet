import type { PlayerError } from "./errors.ts";

export type MusicId = string;

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

export type LibraryItem = Track | Album | Artist | Playlist | PlaylistFolder;

export interface PlaybackState {
  status: "idle" | "loading" | "playing" | "paused" | "stopped" | "error";
  current?: Track;
  positionSeconds: number;
  durationSeconds: number;
  volume: number;
  queue: Track[];
  queueIndex: number;
  error?: PlayerError;
}
