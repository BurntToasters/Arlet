import {
  reportActionError,
  reportNotice,
} from "../components/action-errors.ts";
import { resolveMusicKitMusicRequest } from "../musickit/catalog.ts";
import {
  addToLibrary as addToLibraryRequest,
  clearRating,
  getRatings,
  setRating as putRating,
  type AddToLibraryIds,
  type MusicRequest,
  type RatingResourceType,
} from "../musickit/library.ts";
import {
  resourceTypeForId,
  type RatingValue,
  type Track,
} from "../domain/music.ts";
import { httpStatusOf } from "../musickit/errors.ts";
import {
  clearRatings,
  getState,
  ratingKey,
  setRating,
  setRatings,
} from "../state.ts";
import {
  safeErrorMessage,
  type ControllerContext,
} from "./controller-support.ts";

/** A song, album or playlist, by Apple resource type and ID. */
export interface RatingTarget {
  type: string;
  id: string;
}

export type RatableKind = "songs" | "albums" | "playlists";

const RATABLE_KINDS: readonly string[] = ["songs", "albums", "playlists"];

/** Library IDs carry an `i.`, `l.` or `p.` prefix; catalog IDs are numeric. */
export function isLibraryTarget(target: RatingTarget): boolean {
  return (
    target.type.startsWith("library-") || /^[ilp]\./u.test(target.id.trim())
  );
}

function ratableKind(target: RatingTarget): RatableKind | undefined {
  const kind = target.type.replace(/^library-/u, "");
  return RATABLE_KINDS.includes(kind) ? (kind as RatableKind) : undefined;
}

/** Rating endpoint kind for a target, or undefined when Apple does not rate it. */
export function ratingResourceType(
  target: RatingTarget,
): RatingResourceType | undefined {
  const kind = ratableKind(target);
  if (!kind) return undefined;
  return (
    isLibraryTarget(target) ? `library-${kind}` : kind
  ) as RatingResourceType;
}

/** State key for a target's rating, or undefined when it cannot be rated. */
export function ratingKeyOf(target: RatingTarget): string | undefined {
  const type = ratingResourceType(target);
  return type ? ratingKey(type, target.id) : undefined;
}

/** Most entries kept per ratings cache for the session. */
const RATINGS_CACHE_LIMIT = 2000;

interface BoundedCache {
  readonly size: number;
  keys(): IterableIterator<string>;
  delete(key: string): boolean;
}

/**
 * Evicts the oldest entries past the cap. Entries in flight and `keep` are
 * skipped, so a pending write or lookup is never dropped.
 */
function trimCache(
  cache: BoundedCache,
  keep: string,
  isBusy: (key: string) => boolean,
): void {
  for (const key of cache.keys()) {
    if (cache.size <= RATINGS_CACHE_LIMIT) return;
    if (key !== keep && !isBusy(key)) cache.delete(key);
  }
}

// Apple's ratings endpoint takes up to 100 ids in one request.
const RATING_BATCH_IDS = 100;
// Set by createRatings, the one ratings owner the app builds.
let batchLoader:
  ((targets: readonly RatingTarget[]) => Promise<void>) | undefined;

/**
 * Loads ratings for songs on screen, in requests of up to 100 ids per endpoint.
 * Values already in the store and lookups already in flight are skipped. Does
 * nothing before the app has created its ratings. Callers check sign-in and
 * connectivity first.
 */
export function requestRatings(
  targets: readonly RatingTarget[],
): Promise<void> {
  return batchLoader?.(targets) ?? Promise.resolve();
}

export function trackRatingTarget(track: Track): RatingTarget {
  // A library type with a catalog ID asks Apple for a library rating of a
  // catalog song, which it rejects (400).
  return {
    type: resourceTypeForId(track.id, track.resourceType),
    id: track.id,
  };
}

export interface Ratings {
  rate(target: RatingTarget, value: RatingValue): Promise<void>;
  loadRating(target: RatingTarget): Promise<void>;
  /** Resolves to the library section that gained the item, if it was added. */
  addToLibrary(target: RatingTarget): Promise<RatableKind | undefined>;
  /** Loads the rating once per now-playing track; a no-op otherwise. */
  syncCurrentTrack(): void;
  /** Invalidates account-specific state and actions at sign-out or reauth. */
  reset(): void;
}

export function createRatings(
  context: Pick<ControllerContext, "requireMusic" | "log">,
): Ratings {
  // Newest rate() call per key. Only that call may roll the UI back.
  const generations = new Map<string, number>();
  // Last server-confirmed value per key, the rollback target.
  const settled = new Map<string, RatingValue>();
  // Lookups in flight per key, so repeated opens share one GET. Ratings are
  // never reused from earlier lookups: another device may have changed them.
  // Cleared by reset(), which runs on sign-in and sign-out.
  const lookups = new Map<string, Promise<void>>();
  // Writes for one key run in click order, so the last click wins on the server.
  const tails = new Map<string, Promise<void>>();
  const inFlight = new Map<string, number>();
  const adding = new Set<string>();
  const added = new Set<string>();
  // Responses may write state only for the last explicit load and the playing track.
  let loadKey: string | undefined;
  let playingKey: string | undefined;
  let accountGeneration = 0;

  // A key with a write or lookup in flight is never evicted from the caches.
  const isBusy = (key: string): boolean =>
    inFlight.has(key) || lookups.has(key) || tails.has(key);
  // Writes the entry as the newest, so a re-set key is not evicted first.
  const remember = <V>(map: Map<string, V>, key: string, value: V): void => {
    map.delete(key);
    map.set(key, value);
    trimCache(map, key, isBusy);
  };

  const request = (): MusicRequest =>
    resolveMusicKitMusicRequest(context.requireMusic()) as MusicRequest;

  const fetchRating = (
    target: RatingTarget,
    type: RatingResourceType,
    key: string,
    accountAtStart = accountGeneration,
  ): Promise<void> => {
    const pending = lookups.get(key);
    if (pending) return pending;
    const lookup: Promise<void> = fetchRatingNow(
      target,
      type,
      key,
      accountAtStart,
    ).finally(() => {
      if (lookups.get(key) === lookup) lookups.delete(key);
    });
    lookups.set(key, lookup);
    return lookup;
  };

  const fetchRatingNow = async (
    target: RatingTarget,
    type: RatingResourceType,
    key: string,
    accountAtStart: number,
  ): Promise<void> => {
    const ratingGeneration = generations.get(key) ?? 0;
    const isCurrent = (): boolean =>
      accountGeneration === accountAtStart &&
      (loadKey === key || playingKey === key);
    // Shows a value only if no newer change, and no unsettled write, owns the
    // key. Returns whether it was shown.
    const apply = (value: RatingValue): boolean => {
      if (
        !isCurrent() ||
        inFlight.has(key) ||
        (generations.get(key) ?? 0) !== ratingGeneration
      ) {
        return false;
      }
      remember(settled, key, value);
      setRating(key, value);
      return true;
    };
    try {
      const values = await getRatings(request(), type, [target.id]);
      apply(values.get(target.id) ?? 0);
    } catch (error) {
      // Apple answers 404 when the item has no rating.
      if (httpStatusOf(error) === 404) {
        apply(0);
        return;
      }
      context.log(`Rating lookup failed: ${safeErrorMessage(error)}`);
    }
  };

  const loadRating = async (target: RatingTarget): Promise<void> => {
    const type = ratingResourceType(target);
    if (!type) return;
    loadKey = ratingKey(type, target.id);
    await fetchRating(target, type, loadKey, accountGeneration);
  };

  const syncCurrentTrack = (): void => {
    const current = getState().playback.current;
    const target = current ? trackRatingTarget(current) : undefined;
    const type = target ? ratingResourceType(target) : undefined;
    const key = target && type ? ratingKey(type, target.id) : undefined;
    if (key === playingKey) return;
    playingKey = key;
    if (target && type && key) {
      void fetchRating(target, type, key, accountGeneration);
    }
  };

  const rate = async (
    target: RatingTarget,
    value: RatingValue,
  ): Promise<void> => {
    const accountAtStart = accountGeneration;
    const type = ratingResourceType(target);
    if (!type) {
      reportActionError(new Error("This item cannot be rated."));
      return;
    }
    const key = ratingKey(type, target.id);
    const generation = (generations.get(key) ?? 0) + 1;
    remember(generations, key, generation);
    // With no write in flight, the displayed value is the server's value.
    if (!inFlight.has(key)) {
      remember(settled, key, getState().ratings[key] ?? 0);
    }
    setRating(key, value);
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    const write = (tails.get(key) ?? Promise.resolve()).then(async () => {
      if (accountGeneration !== accountAtStart) return;
      try {
        if (value === 0) {
          await clearRating(request(), type, target.id);
        } else {
          await putRating(request(), type, target.id, value);
        }
        if (accountGeneration === accountAtStart) {
          remember(settled, key, value);
        }
      } catch (error) {
        if (
          accountGeneration === accountAtStart &&
          generations.get(key) === generation
        ) {
          setRating(key, settled.get(key) ?? 0);
        }
        if (accountGeneration === accountAtStart) {
          context.log(`Rating update failed: ${safeErrorMessage(error)}`);
          reportActionError(error);
        }
      } finally {
        if (accountGeneration === accountAtStart) {
          const remaining = (inFlight.get(key) ?? 1) - 1;
          if (remaining > 0) inFlight.set(key, remaining);
          else {
            inFlight.delete(key);
            // The rollback target only matters while a write is in flight.
            // `generations` stays: it still fences older lookups.
            settled.delete(key);
          }
        }
      }
    });
    tails.set(key, write);
    // Settled chains are not kept for the rest of the session.
    void write.then(() => {
      if (tails.get(key) === write) tails.delete(key);
    });
    await write;
  };

  const addToLibrary = async (
    target: RatingTarget,
  ): Promise<RatableKind | undefined> => {
    const accountAtStart = accountGeneration;
    try {
      const kind = ratableKind(target);
      if (!kind) throw new Error("This item cannot be added to your library.");
      if (isLibraryTarget(target)) {
        throw new Error("This item is already in your library.");
      }
      const flight = `${kind}:${target.id}`;
      if (added.has(flight)) {
        reportNotice("Already added to your library.");
        return undefined;
      }
      if (adding.has(flight)) return undefined;
      adding.add(flight);
      try {
        const ids: AddToLibraryIds = {};
        ids[kind] = [target.id];
        await addToLibraryRequest(request(), ids);
        if (accountGeneration !== accountAtStart) return undefined;
        added.delete(flight);
        added.add(flight);
        trimCache(added, flight, (key) => adding.has(key));
        reportNotice("Added to your library.");
        return kind;
      } finally {
        if (accountGeneration === accountAtStart) adding.delete(flight);
      }
    } catch (error) {
      if (accountGeneration === accountAtStart) {
        context.log(`Add to library failed: ${safeErrorMessage(error)}`);
        reportActionError(error);
      }
      return undefined;
    }
  };

  // One request per batch of ids for one endpoint. Only ids with no stored
  // value and no lookup in flight are requested.
  const fetchBatch = async (
    type: RatingResourceType,
    batch: readonly RatingTarget[],
    accountAtStart: number,
  ): Promise<void> => {
    const starts = new Map(
      batch.map((target) => {
        const key = ratingKey(type, target.id);
        return [key, generations.get(key) ?? 0] as const;
      }),
    );
    let values: Map<string, RatingValue>;
    try {
      values = await getRatings(
        request(),
        type,
        batch.map((target) => target.id),
      );
    } catch (error) {
      if (httpStatusOf(error) !== 404) {
        context.log(`Rating lookup failed: ${safeErrorMessage(error)}`);
        return;
      }
      // Apple answers 404 when the items have no rating.
      values = new Map();
    }
    const entries: [string, RatingValue][] = [];
    for (const target of batch) {
      const key = ratingKey(type, target.id);
      // Same guards as a single lookup: no newer change and no unsettled write.
      if (
        accountGeneration !== accountAtStart ||
        inFlight.has(key) ||
        (generations.get(key) ?? 0) !== starts.get(key)
      ) {
        continue;
      }
      const value = values.get(target.id) ?? 0;
      remember(settled, key, value);
      entries.push([key, value]);
    }
    // One store update for the whole batch, not one per id.
    setRatings(entries);
  };

  const loadRatings = async (
    targets: readonly RatingTarget[],
  ): Promise<void> => {
    const accountAtStart = accountGeneration;
    const byType = new Map<RatingResourceType, RatingTarget[]>();
    const queued = new Set<string>();
    for (const target of targets) {
      const type = ratingResourceType(target);
      if (!type) continue;
      const key = ratingKey(type, target.id);
      if (
        queued.has(key) ||
        getState().ratings[key] !== undefined ||
        lookups.has(key)
      ) {
        continue;
      }
      queued.add(key);
      const list = byType.get(type) ?? [];
      list.push(target);
      byType.set(type, list);
    }
    const pending: Promise<void>[] = [];
    for (const [type, list] of byType) {
      for (let start = 0; start < list.length; start += RATING_BATCH_IDS) {
        const batch = list.slice(start, start + RATING_BATCH_IDS);
        const keys = batch.map((target) => ratingKey(type, target.id));
        const lookup = fetchBatch(type, batch, accountAtStart);
        // Single lookups for these ids now share this request.
        for (const key of keys) lookups.set(key, lookup);
        pending.push(
          lookup.finally(() => {
            for (const key of keys) {
              if (lookups.get(key) === lookup) lookups.delete(key);
            }
          }),
        );
      }
    }
    await Promise.all(pending);
  };
  batchLoader = loadRatings;

  const reset = (): void => {
    accountGeneration += 1;
    generations.clear();
    settled.clear();
    lookups.clear();
    tails.clear();
    inFlight.clear();
    adding.clear();
    added.clear();
    loadKey = undefined;
    playingKey = undefined;
    clearRatings();
  };

  return { rate, loadRating, addToLibrary, syncCurrentTrack, reset };
}
