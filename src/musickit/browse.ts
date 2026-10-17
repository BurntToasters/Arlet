import type { Album, Playlist, Station, Track } from "../domain/music.ts";
import {
  resolveMusicKitMusicRequest,
  resolveStorefront,
  stationsFromResponse,
} from "./catalog.ts";
import { asRecord, dataArray, resultsOf, safeNextPath } from "./response.ts";
import {
  normalizeAlbumResource,
  normalizePlaylistResource,
  normalizeTrackResource,
  type AppleMusicResource,
} from "./normalize.ts";

/** Items per chart request: the first page and each "Load more" page. */
export const BROWSE_PAGE_LIMIT = 20;

/** Shelves filled from the most-played chart or from the `with` charts. */
export type BrowseShelfKind =
  "songs" | "albums" | "playlists" | "cityCharts" | "dailyCharts";

export interface BrowseGenre {
  id: string;
  name: string;
}

/** One loaded page of a shelf; `next` is Apple's cursor when more exist. */
export interface BrowseShelfPage<T> {
  items: T[];
  next?: string;
}

export interface BrowseCharts {
  songs: BrowseShelfPage<Track>;
  albums: BrowseShelfPage<Album>;
  playlists: BrowseShelfPage<Playlist>;
  cityCharts: BrowseShelfPage<Playlist>;
  dailyCharts: BrowseShelfPage<Playlist>;
}

/** A further page of one shelf, tagged so the caller can route it. */
export type BrowseShelfResult =
  | ({ kind: "songs" } & BrowseShelfPage<Track>)
  | ({ kind: "albums" } & BrowseShelfPage<Album>)
  | ({ kind: "playlists" } & BrowseShelfPage<Playlist>)
  | ({ kind: "cityCharts" } & BrowseShelfPage<Playlist>)
  | ({ kind: "dailyCharts" } & BrowseShelfPage<Playlist>);

const isMostPlayed = (chart: unknown): boolean =>
  chart === undefined || chart === "most-played";

const isAnyChart = (): boolean => true;

/**
 * Items of one chart key. Each entry carries its own `chart` name; `keepChart`
 * picks the entries that belong to the shelf. The first `next` cursor wins.
 */
function shelfFrom<T>(
  results: Record<string, unknown>,
  key: string,
  normalize: (resource: AppleMusicResource) => T | undefined,
  keepChart: (chart: unknown) => boolean,
  limit = Number.POSITIVE_INFINITY,
): BrowseShelfPage<T> {
  const entries = Array.isArray(results[key]) ? results[key] : [];
  const selected = entries
    .map(asRecord)
    .filter(
      (entry): entry is Record<string, unknown> =>
        entry !== undefined && keepChart(entry.chart),
    );
  const items = selected
    .flatMap((entry) =>
      Array.isArray(entry.data) ? (entry.data as AppleMusicResource[]) : [],
    )
    .map(normalize)
    .filter((item): item is T => item !== undefined)
    .slice(0, limit);
  const next = selected.find((entry) => typeof entry.next === "string")?.next;
  return typeof next === "string" ? { items, next } : { items };
}

const playableTrack = (resource: AppleMusicResource): Track | undefined => {
  const track = normalizeTrackResource(resource);
  return track?.playable === false ? undefined : track;
};

function parseCharts(raw: unknown, limit: number): BrowseCharts {
  const results = resultsOf(raw) ?? {};
  return {
    songs: shelfFrom(results, "songs", playableTrack, isMostPlayed, limit),
    albums: shelfFrom(
      results,
      "albums",
      normalizeAlbumResource,
      isMostPlayed,
      limit,
    ),
    playlists: shelfFrom(
      results,
      "playlists",
      normalizePlaylistResource,
      isMostPlayed,
      limit,
    ),
    cityCharts: shelfFrom(
      results,
      "cityCharts",
      normalizePlaylistResource,
      isAnyChart,
      limit,
    ),
    dailyCharts: shelfFrom(
      results,
      "dailyGlobalTopCharts",
      normalizePlaylistResource,
      isAnyChart,
      limit,
    ),
  };
}

/**
 * Charts for Browse: the most-played lists, optionally for one genre, with the
 * city and daily playlist charts. An empty `genreId` means every genre.
 */
export async function loadBrowseCharts(
  instance: MusicKit.MusicKitInstance,
  options: { genreId?: string; limit?: number } = {},
): Promise<BrowseCharts> {
  const requested = options.limit ?? BROWSE_PAGE_LIMIT;
  const limit = Number.isFinite(requested)
    ? Math.max(0, Math.floor(requested))
    : BROWSE_PAGE_LIMIT;
  const storefront = await resolveStorefront(instance);
  const genre = options.genreId?.trim();
  const raw = await resolveMusicKitMusicRequest(instance)(
    `/v1/catalog/${encodeURIComponent(storefront)}/charts`,
    {
      chart: "most-played",
      types: "songs,albums,playlists",
      limit,
      with: "cityCharts,dailyGlobalTopCharts",
      ...(genre ? { genre } : {}),
    },
  );
  return parseCharts(raw, limit);
}

/**
 * The next page of one shelf, from the `next` cursor Apple returned with the
 * previous page. The cursor must be a chart path of this storefront, so a
 * response cannot send the request anywhere else.
 */
export async function loadBrowseShelfPage(
  instance: MusicKit.MusicKitInstance,
  kind: BrowseShelfKind,
  next: string,
): Promise<BrowseShelfResult> {
  const storefront = await resolveStorefront(instance);
  const prefix = `/v1/catalog/${encodeURIComponent(storefront)}/charts`;
  const cursor = safeNextPath(next, [prefix]);
  if (!cursor) {
    throw new Error("Apple Music returned an unexpected chart page.");
  }
  const raw = await resolveMusicKitMusicRequest(instance)(cursor);
  const results = resultsOf(raw) ?? {};
  switch (kind) {
    case "songs":
      return {
        kind,
        ...shelfFrom(results, "songs", playableTrack, isMostPlayed),
      };
    case "albums":
      return {
        kind,
        ...shelfFrom(results, "albums", normalizeAlbumResource, isMostPlayed),
      };
    case "playlists":
      return {
        kind,
        ...shelfFrom(
          results,
          "playlists",
          normalizePlaylistResource,
          isMostPlayed,
        ),
      };
    case "cityCharts":
      return {
        kind,
        ...shelfFrom(
          results,
          "cityCharts",
          normalizePlaylistResource,
          isAnyChart,
        ),
      };
    case "dailyCharts":
      return {
        kind,
        ...shelfFrom(
          results,
          "dailyGlobalTopCharts",
          normalizePlaylistResource,
          isAnyChart,
        ),
      };
  }
}

function genresFrom(raw: unknown): BrowseGenre[] {
  const data = dataArray(raw);
  const seen = new Set<string>();
  const genres: BrowseGenre[] = [];
  for (const value of data) {
    const record = asRecord(value);
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    const attributes = asRecord(record?.attributes);
    const name =
      typeof attributes?.name === "string" ? attributes.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    genres.push({ id, name });
  }
  return genres;
}

/** Music genres for the Browse picker, in Apple's order. */
export async function loadBrowseGenres(
  instance: MusicKit.MusicKitInstance,
): Promise<BrowseGenre[]> {
  const storefront = await resolveStorefront(instance);
  const raw = await resolveMusicKitMusicRequest(instance)(
    `/v1/catalog/${encodeURIComponent(storefront)}/genres`,
  );
  return genresFrom(raw);
}

/** Station genres for the Radio shelf, in Apple's order. */
export async function loadStationGenres(
  instance: MusicKit.MusicKitInstance,
): Promise<BrowseGenre[]> {
  const storefront = await resolveStorefront(instance);
  const raw = await resolveMusicKitMusicRequest(instance)(
    `/v1/catalog/${encodeURIComponent(storefront)}/station-genres`,
  );
  return genresFrom(raw);
}

/** Stations of one station genre; they play through the usual station path. */
export async function loadStationGenreStations(
  instance: MusicKit.MusicKitInstance,
  genreId: string,
): Promise<Station[]> {
  const storefront = await resolveStorefront(instance);
  const raw = await resolveMusicKitMusicRequest(instance)(
    `/v1/catalog/${encodeURIComponent(storefront)}/station-genres/${encodeURIComponent(genreId)}/stations`,
  );
  return stationsFromResponse(raw);
}
