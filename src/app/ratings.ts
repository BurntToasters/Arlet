import { reportActionError } from "../components/action-errors.ts";
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
import type { RatingValue, Track } from "../domain/music.ts";
import { httpStatusOf } from "../musickit/errors.ts";
import { clearRatings, getState, ratingKey, setRating } from "../state.ts";
import {
  safeErrorMessage,
  type ControllerContext,
} from "./controller-support.ts";

/** A song, album or playlist, by Apple resource type and ID. */
export interface RatingTarget {
  type: string;
  id: string;
}

type RatableKind = "songs" | "albums" | "playlists";

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

export function trackRatingTarget(track: Track): RatingTarget {
  return { type: track.resourceType ?? "songs", id: track.id };
}

export interface Ratings {
  rate(target: RatingTarget, value: RatingValue): Promise<void>;
  loadRating(target: RatingTarget): Promise<void>;
  addToLibrary(target: RatingTarget): Promise<void>;
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
  // Writes for one key run in click order, so the last click wins on the server.
  const tails = new Map<string, Promise<void>>();
  const inFlight = new Map<string, number>();
  const adding = new Set<string>();
  const added = new Set<string>();
  // Responses may write state only for the last explicit load and the playing track.
  let loadKey: string | undefined;
  let playingKey: string | undefined;
  let accountGeneration = 0;

  const request = (): MusicRequest =>
    resolveMusicKitMusicRequest(context.requireMusic()) as MusicRequest;

  const fetchRating = async (
    target: RatingTarget,
    type: RatingResourceType,
    key: string,
    accountAtStart = accountGeneration,
  ): Promise<void> => {
    const ratingGeneration = generations.get(key) ?? 0;
    const isCurrent = (): boolean =>
      accountGeneration === accountAtStart &&
      (loadKey === key || playingKey === key);
    try {
      const values = await getRatings(request(), type, [target.id]);
      // A newer change, or one still unsettled, owns this key now.
      if (
        !isCurrent() ||
        inFlight.has(key) ||
        (generations.get(key) ?? 0) !== ratingGeneration
      ) {
        return;
      }
      const value = values.get(target.id) ?? 0;
      settled.set(key, value);
      setRating(key, value);
    } catch (error) {
      // Apple answers 404 when the item has no rating.
      if (httpStatusOf(error) === 404) {
        if (
          isCurrent() &&
          !inFlight.has(key) &&
          (generations.get(key) ?? 0) === ratingGeneration
        ) {
          settled.set(key, 0);
          setRating(key, 0);
        }
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
    generations.set(key, generation);
    // With no write in flight, the displayed value is the server's value.
    if (!inFlight.has(key)) settled.set(key, getState().ratings[key] ?? 0);
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
        if (accountGeneration === accountAtStart) settled.set(key, value);
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

  const addToLibrary = async (target: RatingTarget): Promise<void> => {
    const accountAtStart = accountGeneration;
    try {
      const kind = ratableKind(target);
      if (!kind) throw new Error("This item cannot be added to your library.");
      if (isLibraryTarget(target)) {
        throw new Error("This item is already in your library.");
      }
      const flight = `${kind}:${target.id}`;
      if (added.has(flight) || adding.has(flight)) return;
      adding.add(flight);
      try {
        const ids: AddToLibraryIds = {};
        ids[kind] = [target.id];
        await addToLibraryRequest(request(), ids);
        if (accountGeneration === accountAtStart) added.add(flight);
      } finally {
        if (accountGeneration === accountAtStart) adding.delete(flight);
      }
    } catch (error) {
      if (accountGeneration === accountAtStart) {
        context.log(`Add to library failed: ${safeErrorMessage(error)}`);
        reportActionError(error);
      }
    }
  };

  const reset = (): void => {
    accountGeneration += 1;
    generations.clear();
    settled.clear();
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
