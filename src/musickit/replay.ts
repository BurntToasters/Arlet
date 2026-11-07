import type { Album, Artist, ReplaySummary, Track } from "../domain/music.ts";
import { resolveMusicKitMusicRequest } from "./catalog.ts";
import { httpStatusOf } from "./errors.ts";
import { asRecord, dataArray } from "./response.ts";
import {
  normalizeAlbumResource,
  normalizeArtistResource,
  normalizeTrackResource,
  viewBlockOf,
  type AppleMusicResource,
} from "./normalize.ts";

const REPLAY_VIEWS = "top-artists,top-albums,top-songs";

/** Each shelf's entries, normalized; entries Apple sends malformed are dropped. */
function shelf<T>(
  summary: AppleMusicResource,
  view: string,
  normalize: (resource: AppleMusicResource) => T | undefined,
): T[] {
  const entries = viewBlockOf(summary, view)?.data ?? [];
  return entries.flatMap((entry) => {
    const value = normalize(entry as AppleMusicResource);
    return value === undefined ? [] : [value];
  });
}

/** Apple's year as a four-digit string, from a number or a string. */
function yearOf(attributes: Record<string, unknown>): string | undefined {
  const year = attributes.year;
  if (typeof year === "number" && Number.isInteger(year)) return String(year);
  if (typeof year === "string" && /^\d{4}$/u.test(year.trim())) {
    return year.trim();
  }
  return undefined;
}

/**
 * The latest Replay summary for the signed-in account. Resolves undefined when
 * there is no Replay data: an empty `data` array, a 404, or three empty shelves.
 * Other errors propagate.
 */
export async function loadReplay(
  instance: MusicKit.MusicKitInstance,
): Promise<ReplaySummary | undefined> {
  let raw: unknown;
  try {
    raw = await resolveMusicKitMusicRequest(instance)(
      "/v1/me/music-summaries",
      { "filter[year]": "latest", views: REPLAY_VIEWS },
    );
  } catch (error) {
    if (httpStatusOf(error) === 404) return undefined;
    throw error;
  }
  const summary = asRecord(dataArray(raw)[0]) as AppleMusicResource | undefined;
  if (!summary) return undefined;
  const topSongs: Track[] = shelf(summary, "top-songs", normalizeTrackResource);
  const topAlbums: Album[] = shelf(
    summary,
    "top-albums",
    normalizeAlbumResource,
  );
  const topArtists: Artist[] = shelf(
    summary,
    "top-artists",
    normalizeArtistResource,
  );
  if (!topSongs.length && !topAlbums.length && !topArtists.length) {
    return undefined;
  }
  const year = yearOf(asRecord(summary.attributes) ?? {});
  return {
    ...(year ? { year } : {}),
    topSongs,
    topAlbums,
    topArtists,
  };
}
