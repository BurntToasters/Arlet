/**
 * Rating reads and writes for library and catalog items. Reads are batched to
 * the id limit Apple takes per request.
 */
import { asRecord, findResourceArray } from "./response.ts";
import {
  encodePathPart,
  MAX_BATCH_IDS,
  mutationOptions,
  nonEmptyString,
  type MusicRequest,
} from "./library-pages.ts";
import type { RatingValue } from "../domain/music.ts";

/** Library and catalog kinds Apple accepts for rating endpoints. */
export type RatingResourceType =
  | "songs"
  | "library-songs"
  | "albums"
  | "library-albums"
  | "playlists"
  | "library-playlists";

function ratingPath(type: RatingResourceType, id: string): string {
  const trimmed = id.trim();
  if (!trimmed) throw new Error("Rating item id is required.");
  return `/v1/me/ratings/${type}/${encodePathPart(trimmed)}`;
}

/** Loads ratings for the given ids; unrated ids are absent from the map. */
export async function getRatings(
  request: MusicRequest,
  type: RatingResourceType,
  ids: readonly string[],
): Promise<Map<string, RatingValue>> {
  const values = new Map<string, RatingValue>();
  const list = ids.map((id) => id.trim()).filter(Boolean);
  // Apple caps the ids in one ratings request; the chunks run in parallel.
  const chunks: string[][] = [];
  for (let start = 0; start < list.length; start += MAX_BATCH_IDS) {
    chunks.push(list.slice(start, start + MAX_BATCH_IDS));
  }
  const responses = await Promise.all(
    chunks.map((chunk) =>
      request(`/v1/me/ratings/${type}`, { ids: chunk.join(",") }),
    ),
  );
  for (const raw of responses) {
    for (const value of findResourceArray(raw) ?? []) {
      const resource = asRecord(value);
      const id = nonEmptyString(resource?.id);
      if (!id) continue;
      const rating = asRecord(resource?.attributes)?.value;
      values.set(id, rating === 1 ? 1 : rating === -1 ? -1 : 0);
    }
  }
  return values;
}

export async function setRating(
  request: MusicRequest,
  type: RatingResourceType,
  id: string,
  value: 1 | -1,
): Promise<void> {
  await request(
    ratingPath(type, id),
    undefined,
    mutationOptions("PUT", { type: "rating", attributes: { value } }),
  );
}

export async function clearRating(
  request: MusicRequest,
  type: RatingResourceType,
  id: string,
): Promise<void> {
  await request(ratingPath(type, id), undefined, mutationOptions("DELETE"));
}
