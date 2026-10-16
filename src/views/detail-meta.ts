import type { Album, Playlist } from "../domain/music.ts";
import type { ResourceLike } from "./LibraryView.tsx";

/** Runtime as "1 hr 5 min" or "42 min", rounded to whole minutes. */
export function formatRuntime(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** Sum of the durations that are known; undefined when none is. */
export function knownRuntimeMs(
  tracks: readonly Pick<ResourceLike, "durationMs">[],
): number | undefined {
  let total = 0;
  let known = false;
  for (const track of tracks) {
    if (typeof track.durationMs === "number" && track.durationMs > 0) {
      total += track.durationMs;
      known = true;
    }
  }
  return known ? total : undefined;
}

/** The year of an Apple `YYYY-MM-DD` (or `YYYY`) release date. */
export function releaseYear(
  releaseDate: string | undefined,
): string | undefined {
  return releaseDate && /^\d{4}/u.test(releaseDate)
    ? releaseDate.slice(0, 4)
    : undefined;
}

/** Disc a track sits on. A track without a disc number is on disc 1. */
export function discNumberOf(resource: ResourceLike): number {
  const disc = resource.raw.discNumber;
  return typeof disc === "number" && Number.isInteger(disc) && disc > 0
    ? disc
    : 1;
}

export interface DiscGroup<T> {
  disc: number;
  /** Each item with its position in the full list, which plays it. */
  items: { item: T; index: number }[];
}

/** Groups items by disc, in disc order; within a disc, list order is kept. */
export function groupByDisc<T>(
  items: readonly T[],
  discOf: (item: T) => number,
): DiscGroup<T>[] {
  const groups = new Map<number, DiscGroup<T>>();
  items.forEach((item, index) => {
    const disc = discOf(item);
    const group = groups.get(disc) ?? { disc, items: [] };
    group.items.push({ item, index });
    groups.set(disc, group);
  });
  return [...groups.values()].sort((left, right) => left.disc - right.disc);
}

/** The metadata line under an album or playlist title, in display order. */
export function detailSummary(
  kind: "album" | "playlist",
  resource: ResourceLike,
  tracks: readonly ResourceLike[],
  complete: boolean,
): string[] {
  const info = resource.raw as Partial<Album & Playlist>;
  const parts: string[] = [];
  if (kind === "album") {
    const year = releaseYear(resource.releaseDate);
    if (year) parts.push(year);
  }
  const count =
    typeof info.trackCount === "number" && info.trackCount > 0
      ? info.trackCount
      : tracks.length;
  if (count > 0) parts.push(`${count} ${count === 1 ? "song" : "songs"}`);
  // A partly loaded list would under-state the length, so it is left out.
  const runtime = complete ? knownRuntimeMs(tracks) : undefined;
  if (runtime !== undefined) parts.push(formatRuntime(runtime));
  if (kind === "album" && info.genreNames?.[0]) {
    parts.push(info.genreNames[0]);
  }
  if (kind === "playlist" && info.curatorName) {
    parts.push(`Curated by ${info.curatorName}`);
  }
  return parts;
}

export interface DetailNotes {
  notes?: string;
  recordLabel?: string;
  copyright?: string;
}

/** The collapsible "More" content, or undefined when there is none. */
export function detailNotes(
  kind: "album" | "playlist",
  resource: ResourceLike,
): DetailNotes | undefined {
  const info = resource.raw as Partial<Album & Playlist>;
  const notes = kind === "album" ? info.editorialNotes : info.description;
  const recordLabel = kind === "album" ? info.recordLabel : undefined;
  const copyright = kind === "album" ? info.copyright : undefined;
  if (!notes && !recordLabel && !copyright) return undefined;
  return { notes, recordLabel, copyright };
}
