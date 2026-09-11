import type { PlayerError } from "./errors.ts";

export type MusicId = string;

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
}

export interface Album {
  id: MusicId;
  title: string;
  artistName: string;
  artwork?: Artwork;
  trackCount?: number;
}

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
