import { asRecord, resultsOf } from "./response.ts";
import type {
  Album,
  Artist,
  Artwork,
  Playlist,
  Station,
  Track,
} from "../domain/music.ts";
import {
  normalizeStation,
  resolveMusicKitMusicRequest,
  resolveStorefront,
} from "./catalog.ts";
import {
  artworkFromUnknown,
  normalizeAlbumResource,
  normalizeArtistResource,
  normalizePlaylistResource,
  normalizeTrackResource,
  type AppleMusicResource,
} from "./normalize.ts";

/** Catalog result groups in display order. */
export const SEARCH_GROUP_KINDS: readonly SearchGroupKind[] = [
  "songs",
  "albums",
  "artists",
  "playlists",
  "stations",
  "curators",
];

export type SearchGroupKind =
  "songs" | "albums" | "artists" | "playlists" | "stations" | "curators";

/** Apple type behind each group. Curators are Apple's editorial curators. */
const GROUP_APPLE_TYPES: Record<SearchGroupKind, string> = {
  songs: "songs",
  albums: "albums",
  artists: "artists",
  playlists: "playlists",
  stations: "stations",
  curators: "apple-curators",
};

/** Music videos are left out: playback is not supported for them. */
const SEARCH_TYPES = SEARCH_GROUP_KINDS.map(
  (kind) => GROUP_APPLE_TYPES[kind],
).join(",");

/** First-page size for the overview; "See all" pages use the larger size. */
export const SEARCH_OVERVIEW_LIMIT = 10;
export const SEARCH_PAGE_LIMIT = 25;
const SUGGESTION_LIMIT = 5;
const SUGGESTION_TYPES = "songs,albums,artists,playlists,stations";

export interface SearchCurator {
  id: string;
  name: string;
  artwork?: Artwork;
}

/** One playable or openable catalog result, as the Search view shows it. */
export type SearchItem =
  | { kind: "songs"; track: Track }
  | { kind: "albums"; album: Album }
  | { kind: "artists"; artist: Artist }
  | { kind: "playlists"; playlist: Playlist }
  | { kind: "stations"; station: Station }
  | { kind: "curators"; curator: SearchCurator };

/** A typeahead row: a term to search for, or a result to open. */
export type SearchSuggestion =
  | { kind: "term"; term: string; displayTerm: string }
  | { kind: "item"; item: SearchItem };

/** One "See all" page of a single group, appended to the overview. */
export type SearchPage =
  | { kind: "songs"; items: Track[]; count: number }
  | { kind: "albums"; items: Album[]; count: number }
  | { kind: "artists"; items: Artist[]; count: number }
  | { kind: "playlists"; items: Playlist[]; count: number }
  | { kind: "stations"; items: Station[]; count: number }
  | { kind: "curators"; items: SearchCurator[]; count: number };

export interface CatalogSearchResult {
  songs: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
  stations: Station[];
  curators: SearchCurator[];
  /** Raw Apple item count per group; a full page means more may follow. */
  counts: Record<SearchGroupKind, number>;
  top?: SearchItem;
}

function resourcesAt(
  results: Record<string, unknown> | undefined,
  appleType: string,
): AppleMusicResource[] {
  const data = asRecord(results?.[appleType])?.data;
  return Array.isArray(data) ? (data as AppleMusicResource[]) : [];
}

function normalizeList<T>(
  resources: AppleMusicResource[],
  normalize: (resource: AppleMusicResource) => T | undefined,
): T[] {
  const items: T[] = [];
  for (const resource of resources) {
    const value = normalize(resource);
    if (value !== undefined) items.push(value);
  }
  return items;
}

function normalizeCurator(
  resource: AppleMusicResource,
): SearchCurator | undefined {
  const record = asRecord(resource);
  const attributes = asRecord(record?.attributes);
  const id = typeof record?.id === "string" ? record.id : "";
  const name =
    typeof attributes?.name === "string" ? attributes.name.trim() : "";
  if (!id || !name) return undefined;
  return { id, name, artwork: artworkFromUnknown(attributes?.artwork, 300) };
}

/** Maps one Apple resource to a Search item; unknown types yield undefined. */
export function searchItemFromResource(
  resource: AppleMusicResource,
): SearchItem | undefined {
  switch (asRecord(resource)?.type) {
    case "songs": {
      const track = normalizeTrackResource(resource);
      return track ? { kind: "songs", track } : undefined;
    }
    case "albums": {
      const album = normalizeAlbumResource(resource);
      return album ? { kind: "albums", album } : undefined;
    }
    case "artists": {
      const artist = normalizeArtistResource(resource);
      return artist ? { kind: "artists", artist } : undefined;
    }
    case "playlists": {
      const playlist = normalizePlaylistResource(resource);
      return playlist ? { kind: "playlists", playlist } : undefined;
    }
    case "stations": {
      const station = normalizeStation(resource);
      return station ? { kind: "stations", station } : undefined;
    }
    case "apple-curators":
    case "curators": {
      const curator = normalizeCurator(resource);
      return curator ? { kind: "curators", curator } : undefined;
    }
    default:
      return undefined;
  }
}

function topItemFrom(
  results: Record<string, unknown> | undefined,
): SearchItem | undefined {
  for (const resource of resourcesAt(results, "top")) {
    const item = searchItemFromResource(resource);
    if (item) return item;
  }
  return undefined;
}

/** Apple accepts 1 to 25 search results per type; anything else is a 400. */
function searchLimit(requested: number | undefined, fallback: number): number {
  const value = requested ?? fallback;
  return Number.isFinite(value)
    ? Math.min(25, Math.max(1, Math.floor(value)))
    : fallback;
}

/**
 * Overview search: every group plus the top result in one request. The
 * `with=topResults` parameter adds `results.top`.
 */
export async function searchCatalog(
  instance: MusicKit.MusicKitInstance,
  term: string,
  options: { limit?: number } = {},
): Promise<CatalogSearchResult> {
  const trimmed = term.trim();
  const limit = searchLimit(options.limit, SEARCH_OVERVIEW_LIMIT);
  if (!trimmed) {
    return {
      songs: [],
      albums: [],
      artists: [],
      playlists: [],
      stations: [],
      curators: [],
      counts: {
        songs: 0,
        albums: 0,
        artists: 0,
        playlists: 0,
        stations: 0,
        curators: 0,
      },
    };
  }
  const storefront = await resolveStorefront(instance);
  const raw = await resolveMusicKitMusicRequest(instance)(
    `/v1/catalog/${encodeURIComponent(storefront)}/search`,
    {
      term: trimmed,
      types: SEARCH_TYPES,
      limit,
      with: "topResults",
    },
  );
  const results = resultsOf(raw);
  const songs = resourcesAt(results, GROUP_APPLE_TYPES.songs);
  const albums = resourcesAt(results, GROUP_APPLE_TYPES.albums);
  const artists = resourcesAt(results, GROUP_APPLE_TYPES.artists);
  const playlists = resourcesAt(results, GROUP_APPLE_TYPES.playlists);
  const stations = resourcesAt(results, GROUP_APPLE_TYPES.stations);
  const curators = resourcesAt(results, GROUP_APPLE_TYPES.curators);
  return {
    songs: normalizeList(songs, normalizeTrackResource),
    albums: normalizeList(albums, normalizeAlbumResource),
    artists: normalizeList(artists, normalizeArtistResource),
    playlists: normalizeList(playlists, normalizePlaylistResource),
    stations: normalizeList(stations, normalizeStation),
    curators: normalizeList(curators, normalizeCurator),
    counts: {
      songs: songs.length,
      albums: albums.length,
      artists: artists.length,
      playlists: playlists.length,
      stations: stations.length,
      curators: curators.length,
    },
    top: topItemFrom(results),
  };
}

/**
 * One "See all" page for a single group. Offset counts Apple's raw items, so
 * `count` (not the normalized length) decides whether another page exists.
 */
export async function searchCatalogPage(
  instance: MusicKit.MusicKitInstance,
  term: string,
  kind: SearchGroupKind,
  offset: number,
): Promise<SearchPage> {
  const trimmed = term.trim();
  if (!trimmed) return { kind: "songs", items: [], count: 0 };
  const storefront = await resolveStorefront(instance);
  const raw = await resolveMusicKitMusicRequest(instance)(
    `/v1/catalog/${encodeURIComponent(storefront)}/search`,
    {
      term: trimmed,
      types: GROUP_APPLE_TYPES[kind],
      limit: SEARCH_PAGE_LIMIT,
      offset: Math.max(0, Math.floor(offset)),
    },
  );
  const resources = resourcesAt(resultsOf(raw), GROUP_APPLE_TYPES[kind]);
  const count = resources.length;
  switch (kind) {
    case "songs":
      return {
        kind,
        items: normalizeList(resources, normalizeTrackResource),
        count,
      };
    case "albums":
      return {
        kind,
        items: normalizeList(resources, normalizeAlbumResource),
        count,
      };
    case "artists":
      return {
        kind,
        items: normalizeList(resources, normalizeArtistResource),
        count,
      };
    case "playlists":
      return {
        kind,
        items: normalizeList(resources, normalizePlaylistResource),
        count,
      };
    case "stations":
      return { kind, items: normalizeList(resources, normalizeStation), count };
    case "curators":
      return { kind, items: normalizeList(resources, normalizeCurator), count };
  }
}

export function suggestionsFromResponse(raw: unknown): SearchSuggestion[] {
  const entries = resultsOf(raw)?.suggestions;
  if (!Array.isArray(entries)) return [];
  const suggestions: SearchSuggestion[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (record?.kind === "terms") {
      const term =
        typeof record.searchTerm === "string" ? record.searchTerm.trim() : "";
      const displayTerm =
        typeof record.displayTerm === "string" ? record.displayTerm.trim() : "";
      if (term) {
        suggestions.push({
          kind: "term",
          term,
          displayTerm: displayTerm || term,
        });
      }
    } else if (record?.kind === "topResults") {
      const content = asRecord(record.content);
      const item = content ? searchItemFromResource(content) : undefined;
      if (item) suggestions.push({ kind: "item", item });
    }
  }
  return suggestions;
}

/** Typeahead for the Search field; callers skip terms shorter than 2 chars. */
export async function loadSearchSuggestions(
  instance: MusicKit.MusicKitInstance,
  term: string,
): Promise<SearchSuggestion[]> {
  const trimmed = term.trim();
  if (trimmed.length < 2) return [];
  const storefront = await resolveStorefront(instance);
  const raw = await resolveMusicKitMusicRequest(instance)(
    `/v1/catalog/${encodeURIComponent(storefront)}/search/suggestions`,
    {
      term: trimmed,
      kinds: "terms,topResults",
      types: SUGGESTION_TYPES,
      limit: SUGGESTION_LIMIT,
    },
  );
  return suggestionsFromResponse(raw);
}
