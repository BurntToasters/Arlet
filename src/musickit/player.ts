import type { Track } from "../domain/music.ts";
import { normalizeTrack } from "./normalize.ts";
import { setCurrentTrack, setQueue } from "../state.ts";

export const CONSECUTIVE_TRACK_TARGET = 20;

export interface QueueSnapshot {
  items: MusicKit.MediaItem[];
  index: number;
}

export type NormalizedRepeatMode = "off" | "all" | "one";

export interface PlaybackModeCapabilities {
  shuffle: boolean;
  repeat: boolean;
}

function playerRecord(
  instance: MusicKit.MusicKitInstance,
): Record<string, unknown> {
  return (instance.player ?? instance) as unknown as Record<string, unknown>;
}

function writableProperty(
  record: Record<string, unknown>,
  key: string,
): boolean {
  let current: object | null = record;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      return (
        descriptor.writable === true || typeof descriptor.set === "function"
      );
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  // Host objects and proxies can hide descriptors while still supporting a
  // writable property. Assignment plus read-back remains the final guard.
  return key in record;
}

export function readPlaybackModes(instance: MusicKit.MusicKitInstance): {
  shuffleMode: "off" | "songs";
  repeatMode: NormalizedRepeatMode;
  capabilities: PlaybackModeCapabilities;
} {
  const record = playerRecord(instance);
  const shuffle = record.shuffle;
  const repeat = record.repeatMode;
  const shuffleMode = shuffle === true ? "songs" : "off";
  const repeatMode: NormalizedRepeatMode =
    repeat === 2 || repeat === "one"
      ? "one"
      : repeat === 1 || repeat === "all"
        ? "all"
        : "off";
  return {
    shuffleMode,
    repeatMode,
    capabilities: {
      shuffle: writableProperty(record, "shuffle"),
      repeat: writableProperty(record, "repeatMode"),
    },
  };
}

export function setShuffleMode(
  instance: MusicKit.MusicKitInstance,
  enabled: boolean,
): boolean {
  const record = playerRecord(instance);
  if (!writableProperty(record, "shuffle")) return false;
  try {
    record.shuffle = enabled;
    return record.shuffle === enabled;
  } catch {
    return false;
  }
}

export function setRepeatMode(
  instance: MusicKit.MusicKitInstance,
  mode: NormalizedRepeatMode,
): boolean {
  const record = playerRecord(instance);
  if (!writableProperty(record, "repeatMode")) return false;
  const current = record.repeatMode;
  const value =
    typeof current === "number"
      ? mode === "off"
        ? 0
        : mode === "all"
          ? 1
          : 2
      : mode;
  try {
    record.repeatMode = value;
    return readPlaybackModes(instance).repeatMode === mode;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mediaItems(value: unknown): MusicKit.MediaItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is MusicKit.MediaItem => {
    const record = asRecord(item);
    return typeof record?.id === "string";
  });
  return items.length === value.length ? items : undefined;
}

function indexValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function itemIndex(
  items: readonly MusicKit.MediaItem[],
  candidate: unknown,
): number | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const byIdentity = items.indexOf(candidate as MusicKit.MediaItem);
  if (byIdentity >= 0) return byIdentity;
  const id = asRecord(candidate)?.id;
  if (typeof id !== "string") return undefined;
  const byId = items.findIndex((item) => item.id === id);
  return byId >= 0 ? byId : undefined;
}

/** Read queue without assuming one MusicKit JS queue shape. */
export function readMusicKitQueue(
  instance: MusicKit.MusicKitInstance,
  event?: Record<string, unknown>,
): QueueSnapshot | undefined {
  const instanceRecord = instance as unknown as Record<string, unknown>;
  const eventRecord = event ?? {};
  const playerRecord = asRecord(instanceRecord.player);
  const queueCandidates = [
    eventRecord.queue,
    eventRecord.items,
    eventRecord.queueItems,
    instanceRecord.queueItems,
    instanceRecord.queue,
    playerRecord?.queue,
  ];
  let items: MusicKit.MediaItem[] | undefined;
  let queueRecord: Record<string, unknown> | undefined;
  for (const candidate of queueCandidates) {
    const candidateRecord = asRecord(candidate);
    const directItems = mediaItems(candidate);
    if (directItems) {
      items = directItems;
      queueRecord = candidateRecord;
      break;
    }
    if (candidateRecord) {
      for (const key of ["items", "songs", "tracks", "queueItems"]) {
        const nestedItems = mediaItems(candidateRecord[key]);
        if (nestedItems) {
          items = nestedItems;
          queueRecord = candidateRecord;
          break;
        }
      }
      if (items) break;
    }
  }
  if (!items) return undefined;

  const index =
    indexValue(eventRecord.currentItemIndex) ??
    indexValue(eventRecord.queueIndex) ??
    indexValue(eventRecord.position) ??
    indexValue(queueRecord?.currentItemIndex) ??
    indexValue(queueRecord?.index) ??
    indexValue(queueRecord?.position) ??
    indexValue(instanceRecord.currentPlaybackQueueItemIndex) ??
    indexValue(playerRecord?.nowPlayingItemIndex) ??
    indexValue(playerRecord?.currentPlaybackQueueItemIndex) ??
    itemIndex(items, eventRecord.currentItem) ??
    itemIndex(items, eventRecord.item) ??
    itemIndex(items, instanceRecord.currentPlaybackQueueItem) ??
    itemIndex(items, instanceRecord.nowPlayingItem) ??
    itemIndex(items, playerRecord?.nowPlayingItem) ??
    0;
  return { items, index: Math.min(index, Math.max(0, items.length - 1)) };
}

/** Sync app queue from provider queue. Returns false when runtime hides queue. */
export function syncMusicKitQueue(
  instance: MusicKit.MusicKitInstance,
  event?: Record<string, unknown>,
): boolean {
  const snapshot = readMusicKitQueue(instance, event);
  if (!snapshot) return false;
  const tracks = snapshot.items.map((item) => normalizeTrack(item));
  setQueue(tracks, snapshot.index);
  const current = tracks[snapshot.index];
  setCurrentTrack(current, snapshot.index);
  return true;
}

/**
 * Queue option shape matching track origin. MusicKit JS resolves queue
 * descriptors through catalog endpoints, so always prefer the catalog id:
 * the dedicated library descriptor keys build library URLs MusicKit cannot
 * resolve and fail playback.
 */
export function queueOptionsForTracks(
  tracks: readonly Track[],
): MusicKit.QueueOptions {
  const usableId = (track: Track): string => track.catalogId ?? track.id;
  const types = new Set(tracks.map((track) => track.resourceType));
  const allVideos =
    types.size > 0 &&
    [...types].every(
      (type) => type === "music-videos" || type === "library-music-videos",
    );
  if (allVideos) {
    return { musicVideos: tracks.map(usableId) };
  }
  return { songs: tracks.map(usableId) };
}

export async function playQueue(
  instance: MusicKit.MusicKitInstance,
  songIds: readonly string[],
  startIndex = 0,
): Promise<void> {
  if (songIds.length === 0) {
    throw new Error("Queue is empty");
  }
  const start = Math.max(0, Math.min(startIndex, songIds.length - 1));
  await instance.setQueue({ songs: [...songIds.slice(start)] });
  await instance.play();
}

export async function playSong(
  instance: MusicKit.MusicKitInstance,
  songId: string,
): Promise<void> {
  await playQueue(instance, [songId]);
}

export async function pause(
  instance: MusicKit.MusicKitInstance,
): Promise<void> {
  instance.pause();
}

export async function resume(
  instance: MusicKit.MusicKitInstance,
): Promise<void> {
  await instance.play();
}

export async function toggle(
  instance: MusicKit.MusicKitInstance,
): Promise<void> {
  if (instance.playbackState === MusicKit.PlaybackStates.playing) {
    instance.pause();
  } else {
    await instance.play();
  }
}

export async function seekToTime(
  instance: MusicKit.MusicKitInstance,
  seconds: number,
): Promise<void> {
  await instance.seekToTime(seconds);
}

export async function skipToNext(
  instance: MusicKit.MusicKitInstance,
): Promise<void> {
  await instance.skipToNextItem();
}

export async function skipToPrevious(
  instance: MusicKit.MusicKitInstance,
): Promise<void> {
  await instance.skipToPreviousItem();
}

export function setVolume(
  instance: MusicKit.MusicKitInstance,
  volume: number,
): void {
  instance.volume = Math.max(0, Math.min(1, volume));
}
