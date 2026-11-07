import { asRecord } from "./response.ts";
import {
  idSource,
  isSameTrack,
  type PlaybackState,
  type Track,
} from "../domain/music.ts";
import { normalizeTrack } from "./normalize.ts";
import {
  getState,
  setCurrentTrack,
  setPlaybackModes,
  setPlaybackStatus,
  setQueue,
} from "../state.ts";

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
  /** False once an owner asked for MusicKit's order to be kept on release. */
  restoreOnRelease: boolean;
}

interface ShuffleModeState {
  desired: boolean;
  generation: number;
  override?: ShuffleModeOverride;
  /**
   * Keep-order lease: MusicKit's shuffleMode stays off so it never reshuffles
   * the order the user sees, while `desired` keeps reporting shuffle on.
   */
  keepOrder: boolean;
}

const shuffleModeStates = new WeakMap<
  MusicKit.MusicKitInstance,
  ShuffleModeState
>();

export interface TransportIntent {
  /** Moves on every Play or Pause the user presses. */
  generation: number;
  /** True when the latest press was Play. */
  playing: boolean;
}

let transportIntent: TransportIntent = { generation: 0, playing: false };

/**
 * Records a Play (true) or Pause (false) the user pressed. Only the app's
 * transport commands call this; a queue rebuild's own resume or pause does not.
 */
export function recordTransportIntent(playing: boolean): void {
  transportIntent = { generation: transportIntent.generation + 1, playing };
}

export function latestTransportIntent(): TransportIntent {
  return transportIntent;
}

/** A tick this close to a seek target confirms that the seek landed. */
const SEEK_CONFIRM_SECONDS = 1.5;
/** Longest wait for a seek to finish before its target stops being held. */
const SEEK_PENDING_MS = 10_000;
/** After a seek lands, longest wait for a tick to confirm it. */
const SEEK_HOLD_MS = 3_000;

interface PendingSeek {
  generation: number;
  seconds: number;
  /** False while seekToTime() is in flight; true once it has resolved. */
  landed: boolean;
  holdUntil: number;
}

let seekGeneration = 0;
let pendingSeek: PendingSeek | undefined;

/**
 * Starts a seek. Until a tick lands near `seconds` (or the hold runs out),
 * `seekAwarePosition` reports the target, because MusicKit keeps ticking the
 * old position while the seek is in flight. Returns the seek's generation.
 */
export function beginSeek(seconds: number, now = Date.now()): number {
  seekGeneration += 1;
  pendingSeek = {
    generation: seekGeneration,
    seconds,
    landed: false,
    holdUntil: now + SEEK_PENDING_MS,
  };
  return seekGeneration;
}

/**
 * Records that `generation` landed and keeps holding stale ticks for
 * SEEK_HOLD_MS more. Returns whether it is still the pending seek.
 */
export function settleSeek(generation: number, now = Date.now()): boolean {
  if (pendingSeek?.generation !== generation) return false;
  pendingSeek = { ...pendingSeek, landed: true, holdUntil: now + SEEK_HOLD_MS };
  return true;
}

/**
 * Stops holding ticks; with a generation, only if that seek is still the
 * pending one. Returns whether it ended an unconfirmed seek.
 */
export function endSeek(generation?: number): boolean {
  if (!pendingSeek) return false;
  if (generation !== undefined && pendingSeek.generation !== generation) {
    return false;
  }
  pendingSeek = undefined;
  return true;
}

/** The position to show for a playback tick at `position`. */
export function seekAwarePosition(position: number, now = Date.now()): number {
  if (!pendingSeek) return position;
  // In flight, only the cap ends the hold; a tick at the target does not.
  if (!pendingSeek.landed && now <= pendingSeek.holdUntil) {
    return pendingSeek.seconds;
  }
  if (
    now > pendingSeek.holdUntil ||
    Math.abs(position - pendingSeek.seconds) <= SEEK_CONFIRM_SECONDS
  ) {
    pendingSeek = undefined;
    return position;
  }
  return pendingSeek.seconds;
}

function playerRecord(
  instance: MusicKit.MusicKitInstance,
): Record<string, unknown> {
  return (instance.player ?? instance) as unknown as Record<string, unknown>;
}

/**
 * Song selections Arlet has in flight, per instance. MusicKit stops playback
 * before it plays the chosen song, and that stop reports as an empty item and
 * a stopped state. events.ts drops those echoes while a selection is in flight.
 */
const selectionsInFlight = new WeakMap<MusicKit.MusicKitInstance, number>();

/** True while an Arlet-initiated song selection on `instance` has not settled. */
export function isSelectingSong(instance: MusicKit.MusicKitInstance): boolean {
  return (selectionsInFlight.get(instance) ?? 0) > 0;
}

function beginSelection(instance: MusicKit.MusicKitInstance): void {
  selectionsInFlight.set(instance, (selectionsInFlight.get(instance) ?? 0) + 1);
}

function endSelection(instance: MusicKit.MusicKitInstance): void {
  const remaining = (selectionsInFlight.get(instance) ?? 0) - 1;
  if (remaining > 0) selectionsInFlight.set(instance, remaining);
  else selectionsInFlight.delete(instance);
}

/**
 * After a failed selection, the stop or empty item that events.ts dropped is
 * gone for good, so read the instance once and apply a real stop.
 */
function rereadAfterFailedSelection(instance: MusicKit.MusicKitInstance): void {
  const states = MusicKit.PlaybackStates;
  const state = instance.playbackState;
  const stopped =
    state === states.stopped ||
    state === states.ended ||
    state === states.completed;
  if (!stopped) return;
  setPlaybackStatus("stopped");
  if (!instance.nowPlayingItem) setCurrentTrack(undefined);
}

/**
 * Move within the provider-owned queue without rebuilding it. MusicKit JS
 * exposes this on Player in current runtimes and on the instance in some
 * compatible builds, so keep both shapes behind feature detection.
 *
 * Every Arlet song selection goes through here, so the selection is counted
 * while it runs and its MusicKit stop echo is kept out of the store.
 */
export async function changeToMediaAtIndex(
  instance: MusicKit.MusicKitInstance,
  index: number,
): Promise<boolean> {
  beginSelection(instance);
  try {
    return await selectInProviderQueue(instance, index);
  } catch (error) {
    rereadAfterFailedSelection(instance);
    throw error;
  } finally {
    endSelection(instance);
  }
}

async function selectInProviderQueue(
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

interface RepeatModeValues {
  none: number;
  one: number;
  all: number;
}

interface ShuffleModeValues {
  off: number;
  songs: number;
}

/** Live MusicKit v3 numbers, used when the global enum is absent. */
const FALLBACK_REPEAT_MODE: RepeatModeValues = { none: 0, one: 1, all: 2 };
const FALLBACK_SHUFFLE_MODE: ShuffleModeValues = { off: 0, songs: 1 };

/** Every key must be an integer; a partial enum is treated as absent. */
function integerEnum<K extends string>(
  value: unknown,
  keys: readonly K[],
): Record<K, number> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const result = {} as Record<K, number>;
  for (const key of keys) {
    const entry = record[key];
    if (typeof entry !== "number" || !Number.isInteger(entry)) return undefined;
    result[key] = entry;
  }
  return result;
}

/**
 * Repeat numbers MusicKit uses. Live v3 is none 0, one 1, all 2, so reading
 * the global enum keeps Arlet in step with the runtime that plays the music.
 */
function repeatModeValues(): RepeatModeValues {
  const live =
    typeof MusicKit === "undefined"
      ? undefined
      : integerEnum(MusicKit.PlayerRepeatMode, ["none", "one", "all"]);
  return live ?? FALLBACK_REPEAT_MODE;
}

/** Shuffle numbers MusicKit uses: live v3 is off 0, songs 1. */
function shuffleModeValues(): ShuffleModeValues {
  const live =
    typeof MusicKit === "undefined"
      ? undefined
      : integerEnum(MusicKit.PlayerShuffleMode, ["off", "songs"]);
  return live ?? FALLBACK_SHUFFLE_MODE;
}

/**
 * MusicKit v3 exposes shuffle as `shuffleMode` (off 0, songs 1, from the
 * `PlayerShuffleMode` enum); `shuffle` is write-only there. Older shapes
 * expose a readable `shuffle` boolean.
 */
function readShuffle(record: Record<string, unknown>): boolean {
  const mode = record.shuffleMode;
  if (typeof mode === "number") return mode === shuffleModeValues().songs;
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
      keepOrder: false,
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
      const values = shuffleModeValues();
      record.shuffleMode = enabled ? values.songs : values.off;
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

/**
 * Reads shuffle and repeat as Arlet's normalized modes. Live MusicKit v3
 * reports repeat as a number (none 0, one 1, all 2); string names are
 * accepted too, with "none" and "off" both meaning no repeat.
 */
export function readPlaybackModes(instance: MusicKit.MusicKitInstance): {
  shuffleMode: "off" | "songs";
  repeatMode: NormalizedRepeatMode;
  capabilities: PlaybackModeCapabilities;
} {
  const record = playerRecord(instance);
  const repeat = record.repeatMode;
  const shuffleState = shuffleModeStates.get(instance);
  const providerShuffle = readShuffle(record);
  // An override or keep-order lease holds the provider, so report the desired mode.
  const held =
    shuffleState?.override !== undefined || shuffleState?.keepOrder === true;
  const shuffleMode = held
    ? shuffleState?.desired
      ? "songs"
      : "off"
    : providerShuffle
      ? "songs"
      : "off";
  if (shuffleState && !held) {
    shuffleState.desired = providerShuffle;
  }
  const repeatValues = repeatModeValues();
  const repeatMode: NormalizedRepeatMode =
    typeof repeat === "number"
      ? repeat === repeatValues.one
        ? "one"
        : repeat === repeatValues.all
          ? "all"
          : "off"
      : repeat === "one"
        ? "one"
        : repeat === "all"
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

/** Reads `bitrate` (kbps) from the instance, or undefined when it is not a number. */
export function readMusicKitBitrate(
  instance: MusicKit.MusicKitInstance,
): number | undefined {
  const value = (instance as unknown as Record<string, unknown>).bitrate;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Writes `bitrate` on the instance; false when the runtime rejects it. */
export function writeMusicKitBitrate(
  instance: MusicKit.MusicKitInstance,
  bitrate: number,
): boolean {
  const record = instance as unknown as Record<string, unknown>;
  if (!writableProperty(record, "bitrate")) return false;
  try {
    record.bitrate = bitrate;
    return record.bitrate === bitrate;
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
    // Turning shuffle on asks for a shuffle, so the release writes it instead
    // of holding the edited order.
    if (enabled && !state.desired) state.override.restoreOnRelease = true;
    state.desired = enabled;
    return true;
  }
  // The user's toggle always reaches MusicKit, so it ends a keep-order lease.
  const keptOrder = state.keepOrder;
  state.keepOrder = false;
  if (!writeShuffleMode(record, enabled)) {
    state.keepOrder = keptOrder;
    return false;
  }
  state.desired = enabled;
  return true;
}

/**
 * Temporarily changes the provider mode while preserving the user's desired
 * mode. The returned release only restores a lease it still owns. With
 * `restoreOnRelease: false`, releasing with shuffle on keeps MusicKit's order
 * (a keep-order lease) instead of writing shuffle on again, which would
 * reshuffle. Joining owners can only turn restoring off, never on; only the
 * user turning shuffle on during the override turns it back on.
 */
export function acquireShuffleModeOverride(
  instance: MusicKit.MusicKitInstance,
  enabled: boolean,
  options: { restoreOnRelease?: boolean } = {},
): (() => void) | undefined {
  const state = shuffleModeState(instance);
  const record = playerRecord(instance);
  const restoreOnRelease = options.restoreOnRelease ?? true;
  const owner = Symbol("shuffle mode override");
  let override = state.override;
  if (override) {
    override.owners.add(owner);
    if (!writeShuffleMode(record, override.enabled)) {
      override.owners.delete(owner);
      return undefined;
    }
    override.restoreOnRelease = override.restoreOnRelease && restoreOnRelease;
  } else {
    // A keep-order lease already holds the user's desired mode. Reading the
    // provider now would read off and overwrite that desired mode.
    const keptOrder = state.keepOrder;
    if (!keptOrder) state.desired = readShuffle(record);
    state.keepOrder = false;
    override = {
      generation: ++state.generation,
      enabled,
      owners: new Set([owner]),
      restoreOnRelease,
    };
    state.override = override;
    if (!writeShuffleMode(record, enabled)) {
      if (state.override === override) state.override = undefined;
      state.keepOrder = keptOrder;
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
    const release = playerRecord(instance);
    if (!current.restoreOnRelease && state.desired) {
      // Hold MusicKit at off so it keeps the order, but still report shuffle on.
      // The lease is set before the write: a change event read back during the
      // write must report the desired on, not adopt the provider's transient off.
      state.keepOrder = true;
      if (!writeShuffleMode(release, false)) state.keepOrder = false;
      return;
    }
    writeShuffleMode(release, state.desired);
  };
}

/**
 * Holds MusicKit's shuffle off while Arlet reports shuffle on, so an
 * already-shuffled queue keeps its order. Records desired as on. During a
 * temporary override the override owns the provider, so it is marked to keep
 * order when released instead of being written now. Returns false when shuffle
 * is not writable.
 */
export function holdProviderShuffleOff(
  instance: MusicKit.MusicKitInstance,
): boolean {
  const record = playerRecord(instance);
  if (!shuffleWritable(record)) return false;
  const state = shuffleModeState(instance);
  if (state.override) {
    state.override.restoreOnRelease = false;
    state.desired = true;
    return true;
  }
  // Record the hold before the write: MusicKit's change event can read back
  // synchronously, and an unheld read would adopt the transient off as desired
  // and publish it to the UI. A failed write restores the earlier state.
  const previous = { desired: state.desired, keepOrder: state.keepOrder };
  state.desired = true;
  state.keepOrder = true;
  if (!writeShuffleMode(record, false)) {
    state.desired = previous.desired;
    state.keepOrder = previous.keepOrder;
    return false;
  }
  return true;
}

/** True while a keep-order lease holds MusicKit's shuffle off. */
export function isProviderShuffleHeldOff(
  instance: MusicKit.MusicKitInstance,
): boolean {
  return shuffleModeStates.get(instance)?.keepOrder === true;
}

/**
 * Drops any override or keep-order lease without writing to MusicKit. The
 * provider keeps its current value, and the next read adopts it as desired.
 */
export function dropShuffleOverride(instance: MusicKit.MusicKitInstance): void {
  const state = shuffleModeStates.get(instance);
  if (!state) return;
  if (state.override) {
    state.override = undefined;
    state.generation += 1;
  }
  state.keepOrder = false;
}

/**
 * Restores the desired mode before a new play inspects or changes a queue.
 * A new play also ends a keep-order lease, so MusicKit can shuffle afresh.
 */
export function preparePlaybackModesForPlay(
  instance: MusicKit.MusicKitInstance,
): boolean {
  const state = shuffleModeStates.get(instance);
  if (!state || (!state.override && !state.keepOrder)) return true;
  state.override = undefined;
  state.keepOrder = false;
  state.generation += 1;
  return writeShuffleMode(playerRecord(instance), state.desired);
}

/**
 * Writes repeat mode. Numeric runtimes get live MusicKit v3 numbers (all 2,
 * one 1, none 0), so Repeat All writes 2 and Repeat One writes 1. String
 * runtimes get "none", "one", or "all".
 */
export function setRepeatMode(
  instance: MusicKit.MusicKitInstance,
  mode: NormalizedRepeatMode,
): boolean {
  const record = playerRecord(instance);
  if (!writableProperty(record, "repeatMode")) return false;
  const current = record.repeatMode;
  const repeatValues = repeatModeValues();
  const value =
    typeof current === "number"
      ? mode === "off"
        ? repeatValues.none
        : mode === "all"
          ? repeatValues.all
          : repeatValues.one
      : mode === "off"
        ? "none"
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

/**
 * Positions of autoplay songs in the snapshot. An item is one when it carries
 * `isAutoplay`, or is in `queue.autoplayItems` by identity. Copied items fall
 * back to the autoplay songs' positions in MusicKit's own queue list.
 */
function autoplayPositions(
  instance: MusicKit.MusicKitInstance,
  items: readonly MusicKit.MediaItem[],
): Set<number> {
  const positions = new Set<number>();
  items.forEach((item, index) => {
    if (asRecord(item)?.isAutoplay === true) positions.add(index);
  });
  const queue = Array.isArray(instance.queue) ? undefined : instance.queue;
  const autoplay = mediaItems(queue?.autoplayItems);
  if (!autoplay?.length) return positions;
  const autoplaySet = new Set<unknown>(autoplay);
  if (items.some((item) => autoplaySet.has(item))) {
    items.forEach((item, index) => {
      if (autoplaySet.has(item)) positions.add(index);
    });
    return positions;
  }
  const listed = mediaItems(queue?.items) ?? [];
  if (listed.length !== items.length) return positions;
  listed.forEach((item, index) => {
    if (autoplaySet.has(item)) positions.add(index);
  });
  return positions;
}

/** Sync app queue from provider queue. Returns false when runtime hides queue. */
export function syncMusicKitQueue(
  instance: MusicKit.MusicKitInstance,
  event?: Record<string, unknown>,
): boolean {
  const snapshot = readMusicKitQueue(instance, event);
  if (!snapshot) return false;
  const station = Array.isArray(instance.queue)
    ? undefined
    : instance.queue?.hasAutoplayStation;
  if (
    typeof station === "boolean" &&
    getState().playback.autoplayStation !== station
  ) {
    // setPlaybackModes is typed for modes, but spreads its patch into state.
    const patch: Partial<PlaybackState> = { autoplayStation: station };
    setPlaybackModes(patch);
  }
  const autoplay = autoplayPositions(instance, snapshot.items);
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
    if (autoplay.has(index)) normalized.autoplay = true;
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
