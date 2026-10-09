import { isSameTrack, type Track } from "../domain/music.ts";
import { normalizeTrack } from "./normalize.ts";
import { getState, setCurrentTrack, setQueue } from "../state.ts";

export const CONSECUTIVE_TRACK_TARGET = 20;

export interface QueueSnapshot {
  items: MusicKit.MediaItem[];
  index: number;
}

export type NormalizedRepeatMode = "off" | "all" | "one";

export interface PlaybackModeCapabilities {
  shuffle: boolean;
  repeat: boolean;
  autoplay: boolean;
}

function playerRecord(
  instance: MusicKit.MusicKitInstance,
): Record<string, unknown> {
  return (instance.player ?? instance) as unknown as Record<string, unknown>;
}

/**
 * Move within the provider-owned queue without rebuilding it. MusicKit JS
 * exposes this on Player in current runtimes and on the instance in some
 * compatible builds, so keep both shapes behind feature detection.
 */
export async function changeToMediaAtIndex(
  instance: MusicKit.MusicKitInstance,
  index: number,
): Promise<boolean> {
  const player = playerRecord(instance);
  const method = player.changeToMediaAtIndex;
  if (typeof method === "function") {
    await (method as (index: number) => Promise<unknown>).call(player, index);
    return true;
  }

  const instanceRecord = instance as unknown as Record<string, unknown>;
  const instanceMethod = instanceRecord.changeToMediaAtIndex;
  if (typeof instanceMethod === "function") {
    await (instanceMethod as (index: number) => Promise<unknown>).call(
      instance,
      index,
    );
    return true;
  }
  return false;
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

/**
 * MusicKit v3 exposes shuffle as `shuffleMode` (0 off, 1 songs); `shuffle`
 * is write-only there. Older shapes expose a readable `shuffle` boolean.
 */
function readShuffle(record: Record<string, unknown>): boolean {
  const mode = record.shuffleMode;
  if (typeof mode === "number") return mode === 1;
  if (typeof mode === "string") return mode === "songs";
  return record.shuffle === true;
}

function shuffleWritable(record: Record<string, unknown>): boolean {
  return (
    writableProperty(record, "shuffleMode") ||
    writableProperty(record, "shuffle")
  );
}

export function readPlaybackModes(instance: MusicKit.MusicKitInstance): {
  shuffleMode: "off" | "songs";
  repeatMode: NormalizedRepeatMode;
  capabilities: PlaybackModeCapabilities;
} {
  const record = playerRecord(instance);
  const repeat = record.repeatMode;
  const shuffleMode = readShuffle(record) ? "songs" : "off";
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
      shuffle: shuffleWritable(record),
      repeat: writableProperty(record, "repeatMode"),
      autoplay: writableProperty(
        instance as unknown as Record<string, unknown>,
        "autoplayEnabled",
      ),
    },
  };
}

/** Writes `autoplayEnabled` on the instance; false when the runtime rejects it. */
export function setAutoplayEnabled(
  instance: MusicKit.MusicKitInstance,
  enabled: boolean,
): boolean {
  const record = instance as unknown as Record<string, unknown>;
  if (!writableProperty(record, "autoplayEnabled")) return false;
  try {
    record.autoplayEnabled = enabled;
    return record.autoplayEnabled === enabled;
  } catch {
    return false;
  }
}

export function setShuffleMode(
  instance: MusicKit.MusicKitInstance,
  enabled: boolean,
): boolean {
  const record = playerRecord(instance);
  try {
    if (writableProperty(record, "shuffleMode")) {
      record.shuffleMode = enabled ? 1 : 0;
    } else if (writableProperty(record, "shuffle")) {
      record.shuffle = enabled;
    } else {
      return false;
    }
    return readShuffle(record) === enabled;
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
  const clamped = Math.min(index, Math.max(0, items.length - 1));
  return {
    items,
    index: alignWithNowPlaying(
      items,
      clamped,
      instanceRecord.nowPlayingItem ?? playerRecord?.nowPlayingItem,
    ),
  };
}

/**
 * MusicKit publishes reordered items (e.g. turning shuffle on) before it
 * moves the queue position, so a reported position can name another song.
 * The playing item wins: its occurrence nearest the reported position.
 */
function alignWithNowPlaying(
  items: readonly MusicKit.MediaItem[],
  index: number,
  nowPlaying: unknown,
): number {
  const id = asRecord(nowPlaying)?.id;
  if (typeof id !== "string" || !id) return index;
  if (items[index]?.id === id) return index;
  let nearest: number | undefined;
  items.forEach((item, position) => {
    if (item.id !== id) return;
    if (
      nearest === undefined ||
      Math.abs(position - index) < Math.abs(nearest - index)
    ) {
      nearest = position;
    }
  });
  return nearest ?? index;
}

/** Sync app queue from provider queue. Returns false when runtime hides queue. */
export function syncMusicKitQueue(
  instance: MusicKit.MusicKitInstance,
  event?: Record<string, unknown>,
): boolean {
  const snapshot = readMusicKitQueue(instance, event);
  if (!snapshot) return false;
  const previous = getState().playback.queue;
  const claimedPrevious = new Set<number>();
  const previousByTrackId = new Map<string, number[]>();
  previous.forEach((candidate, candidateIndex) => {
    for (const id of new Set([candidate.id, candidate.catalogId])) {
      if (!id) continue;
      const bucket = previousByTrackId.get(id);
      if (bucket) bucket.push(candidateIndex);
      else previousByTrackId.set(id, [candidateIndex]);
    }
  });
  const tracks = snapshot.items.map((item, index) => {
    const normalized = normalizeTrack(item);
    const samePosition = previous[index];
    let previousIndex =
      samePosition &&
      !claimedPrevious.has(index) &&
      isSameTrack(normalized, samePosition)
        ? index
        : -1;
    if (previousIndex < 0) {
      for (const id of new Set([normalized.id, normalized.catalogId])) {
        const match = id
          ? previousByTrackId
              .get(id)
              ?.find((candidateIndex) => !claimedPrevious.has(candidateIndex))
          : undefined;
        if (match !== undefined && (previousIndex < 0 || match < previousIndex))
          previousIndex = match;
      }
    }

    if (previousIndex < 0) return normalized;
    claimedPrevious.add(previousIndex);
    const existing = previous[previousIndex];
    return {
      ...normalized,
      ...(normalized.albumRef || !existing.albumRef
        ? {}
        : { albumRef: existing.albumRef }),
      ...(normalized.artistRefs?.length || !existing.artistRefs?.length
        ? {}
        : { artistRefs: existing.artistRefs }),
    };
  });
  setQueue(tracks, snapshot.index);
  const current = tracks[snapshot.index];
  setCurrentTrack(current, snapshot.index);
  return true;
}

/**
 * Queue option shape matching track origin. MusicKit JS resolves queue
 * descriptors through catalog endpoints, so always prefer the catalog id:
 * the dedicated library descriptor keys build library URLs MusicKit cannot
 * resolve and fail playback. Library-only songs (no catalog id) keep their
 * `i.` id under `songs`: MusicKit's item loader routes library-type ids to
 * `/v1/me/library/songs`. Plain `items` objects carry no `kind` and fail.
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
