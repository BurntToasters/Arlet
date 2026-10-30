import { asRecord } from "./response.ts";
import { idSource, isSameTrack, type Track } from "../domain/music.ts";
import { normalizeTrack } from "./normalize.ts";
import { getState, setCurrentTrack, setQueue } from "../state.ts";

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

interface ShuffleModeOverride {
  generation: number;
  enabled: boolean;
  owners: Set<symbol>;
}

interface ShuffleModeState {
  desired: boolean;
  generation: number;
  override?: ShuffleModeOverride;
}

const shuffleModeStates = new WeakMap<
  MusicKit.MusicKitInstance,
  ShuffleModeState
>();

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

function shuffleModeState(
  instance: MusicKit.MusicKitInstance,
): ShuffleModeState {
  let state = shuffleModeStates.get(instance);
  if (!state) {
    state = {
      desired: readShuffle(playerRecord(instance)),
      generation: 0,
    };
    shuffleModeStates.set(instance, state);
  }
  return state;
}

function writeShuffleMode(
  record: Record<string, unknown>,
  enabled: boolean,
): boolean {
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

export function readPlaybackModes(instance: MusicKit.MusicKitInstance): {
  shuffleMode: "off" | "songs";
  repeatMode: NormalizedRepeatMode;
  capabilities: PlaybackModeCapabilities;
} {
  const record = playerRecord(instance);
  const repeat = record.repeatMode;
  const shuffleState = shuffleModeStates.get(instance);
  const providerShuffle = readShuffle(record);
  const shuffleMode =
    shuffleState?.override !== undefined
      ? shuffleState.desired
        ? "songs"
        : "off"
      : providerShuffle
        ? "songs"
        : "off";
  if (shuffleState && !shuffleState.override) {
    shuffleState.desired = providerShuffle;
  }
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
  if (!shuffleWritable(record)) return false;
  const state = shuffleModeState(instance);
  if (state.override) {
    // Keep a rebuild's provider override until it releases. Its cleanup reads
    // this latest user choice, never the value from before the rebuild.
    state.desired = enabled;
    return true;
  }
  if (!writeShuffleMode(record, enabled)) return false;
  state.desired = enabled;
  return true;
}

/**
 * Temporarily changes the provider mode while preserving the user's desired
 * mode. The returned release only restores a lease it still owns.
 */
export function acquireShuffleModeOverride(
  instance: MusicKit.MusicKitInstance,
  enabled: boolean,
): (() => void) | undefined {
  const state = shuffleModeState(instance);
  const record = playerRecord(instance);
  const owner = Symbol("shuffle mode override");
  let override = state.override;
  if (override) {
    override.owners.add(owner);
    if (!writeShuffleMode(record, override.enabled)) {
      override.owners.delete(owner);
      return undefined;
    }
  } else {
    state.desired = readShuffle(record);
    override = {
      generation: ++state.generation,
      enabled,
      owners: new Set([owner]),
    };
    state.override = override;
    if (!writeShuffleMode(record, enabled)) {
      if (state.override === override) state.override = undefined;
      return undefined;
    }
  }

  const generation = override.generation;
  return (): void => {
    const current = state.override;
    if (current?.generation !== generation || !current.owners.delete(owner)) {
      return;
    }
    if (current.owners.size > 0) return;
    state.override = undefined;
    state.generation += 1;
    writeShuffleMode(playerRecord(instance), state.desired);
  };
}

/** Restores the desired mode before a new play inspects or changes a queue. */
export function preparePlaybackModesForPlay(
  instance: MusicKit.MusicKitInstance,
): boolean {
  const state = shuffleModeStates.get(instance);
  if (!state?.override) return true;
  state.override = undefined;
  state.generation += 1;
  return writeShuffleMode(playerRecord(instance), state.desired);
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

/**
 * Provider queue items carry less than the catalog or library resource the
 * song was queued from, so details the queued track already had are kept.
 */
function mergeQueueTrack(normalized: Track, existing: Track): Track {
  const merged: Track = { ...normalized };
  if (!merged.albumRef && existing.albumRef)
    merged.albumRef = existing.albumRef;
  if (!merged.artistRefs?.length && existing.artistRefs?.length) {
    merged.artistRefs = existing.artistRefs;
  }
  if (!merged.albumTitle && existing.albumTitle) {
    merged.albumTitle = existing.albumTitle;
  }
  if (!merged.artwork && existing.artwork) merged.artwork = existing.artwork;
  if (merged.explicit === undefined && existing.explicit !== undefined) {
    merged.explicit = existing.explicit;
  }
  if (!merged.catalogUrl && existing.catalogUrl) {
    merged.catalogUrl = existing.catalogUrl;
  }
  if (!merged.catalogId && existing.catalogId) {
    merged.catalogId = existing.catalogId;
  }
  if (merged.playable === undefined && existing.playable !== undefined) {
    merged.playable = existing.playable;
  }
  if (merged.addable === undefined && existing.addable !== undefined) {
    merged.addable = existing.addable;
  }
  // Queue items can report a singular type ("song"), which add-to-playlist
  // and navigation do not recognise; the type it was queued with is exact.
  // Only for the same ID: a library type on a catalog ID breaks lookups.
  if (
    existing.resourceType &&
    existing.id === merged.id &&
    !merged.resourceType?.endsWith("s")
  ) {
    merged.resourceType = existing.resourceType;
  }
  return merged;
}

/** Structural equality for queue data, which is plain objects and arrays. */
function sameQueueValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        sameQueueValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function sameQueueTracks(
  left: readonly Track[],
  right: readonly Track[],
): boolean {
  return (
    left.length === right.length &&
    left.every((track, index) => sameQueueValue(track, right[index]))
  );
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
    if (!existing) return normalized;
    return mergeQueueTrack(normalized, existing);
  });
  // An unchanged queue keeps the stored array, so queue lists and the session
  // save see no change. A moved index still updates the current track.
  const queueUnchanged = sameQueueTracks(tracks, previous);
  if (!queueUnchanged) setQueue(tracks, snapshot.index);
  const queue = queueUnchanged ? previous : tracks;
  const current = queue[snapshot.index];
  const { playback } = getState();
  if (
    queueUnchanged &&
    playback.queueIndex === snapshot.index &&
    sameQueueValue(current, playback.current)
  ) {
    return true;
  }
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

/**
 * Queue options carrying each song's details instead of its ID. MusicKit then
 * skips its per-song lookup (one Apple request per 16 songs), measured on
 * live MusicKit: one lookup by IDs, none with details. Undefined when any
 * song lacks an ID Arlet can describe, or is a music video, so the caller
 * queues by ID.
 */
export function queueDescriptorsForTracks(
  tracks: readonly Track[],
): MusicKit.QueueOptions | undefined {
  const items: Record<string, unknown>[] = [];
  for (const track of tracks) {
    // A library-only song (an upload, or one Apple no longer sells) has no
    // catalog ID; it is described as a library song, as MusicKit does.
    const catalogId =
      track.catalogId ??
      (idSource(track.id) === "catalog" ? track.id : undefined);
    const libraryId =
      !catalogId && idSource(track.id) === "library" ? track.id : undefined;
    const id = catalogId ?? libraryId;
    const video =
      track.resourceType === "music-videos" ||
      track.resourceType === "library-music-videos";
    if (!id || video || !track.title.trim()) return undefined;
    items.push({
      id,
      type: libraryId ? "library-songs" : "songs",
      attributes: {
        name: track.title,
        artistName: track.artistName,
        ...(track.albumTitle ? { albumName: track.albumTitle } : {}),
        ...(track.durationMs ? { durationInMillis: track.durationMs } : {}),
        // Without a lookup MusicKit only knows a rating it is given; the
        // explicit badge and any account content limit rely on it.
        ...(track.explicit === true ? { contentRating: "explicit" } : {}),
        ...(track.artwork
          ? {
              artwork: {
                url: track.artwork.url,
                width: track.artwork.width,
                height: track.artwork.height,
              },
            }
          : {}),
        playParams: libraryId
          ? { id, kind: "song", isLibrary: true }
          : { id, kind: "song" },
      },
    });
  }
  return items.length ? { items } : undefined;
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
