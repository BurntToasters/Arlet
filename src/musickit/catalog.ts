import type {
  Album,
  Artist,
  Playlist,
  Station,
  Track,
} from "../domain/music.ts";
import { mapErrorToCode } from "./errors.ts";
import {
  normalizeAlbumResource,
  normalizeArtistResource,
  normalizeCatalogSong,
  normalizePlaylistResource,
  normalizeTrackResource,
  type AppleMusicResource,
  type CatalogSongResource,
} from "./normalize.ts";

export interface SearchResourceGroups {
  songs: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
}

export interface BrowseResources {
  songs: Track[];
  albums: Album[];
  playlists: Playlist[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function resourceData(raw: unknown, type: string): AppleMusicResource[] {
  if (Array.isArray(raw)) return raw as AppleMusicResource[];
  const root = asRecord(raw);
  const payload = asRecord(root?.data) ?? root;
  const results = asRecord(payload?.results) ?? payload;
  const typed = asRecord(results?.[type]);
  const data = typed?.data;
  if (Array.isArray(data)) return data as AppleMusicResource[];
  const typedEntries = results?.[type];
  if (Array.isArray(typedEntries)) {
    const chartData: AppleMusicResource[] = [];
    for (const entry of typedEntries) {
      const record = asRecord(entry);
      if (Array.isArray(record?.data)) {
        chartData.push(...(record.data as AppleMusicResource[]));
      }
    }
    if (chartData.length > 0) return chartData;
    const resources = typedEntries.filter(
      (entry): entry is AppleMusicResource =>
        typeof asRecord(entry)?.id === "string",
    );
    if (resources.length > 0) return resources;
    return [];
  }
  if (Array.isArray(results?.data)) return results.data as AppleMusicResource[];
  if (Array.isArray(root?.data)) return root.data as AppleMusicResource[];
  return [];
}

function normalizeResourceList<T>(
  values: AppleMusicResource[],
  normalize: (value: AppleMusicResource) => T | undefined,
): T[] {
  return values
    .map(normalize)
    .filter((value): value is T => value !== undefined);
}

function normalizeSearchGroups(
  raw: unknown,
  prefix = "",
): SearchResourceGroups {
  const songs =
    prefix && resourceData(raw, `${prefix}songs`).length === 0
      ? resourceData(raw, "songs")
      : resourceData(raw, `${prefix}songs`);
  const albums =
    prefix && resourceData(raw, `${prefix}albums`).length === 0
      ? resourceData(raw, "albums")
      : resourceData(raw, `${prefix}albums`);
  const artists =
    prefix && resourceData(raw, `${prefix}artists`).length === 0
      ? resourceData(raw, "artists")
      : resourceData(raw, `${prefix}artists`);
  const playlists =
    prefix && resourceData(raw, `${prefix}playlists`).length === 0
      ? resourceData(raw, "playlists")
      : resourceData(raw, `${prefix}playlists`);
  return {
    songs: normalizeResourceList(songs, normalizeTrackResource),
    albums: normalizeResourceList(albums, normalizeAlbumResource),
    artists: normalizeResourceList(artists, normalizeArtistResource),
    playlists: normalizeResourceList(playlists, normalizePlaylistResource),
  };
}

function limitSearchGroups(
  groups: SearchResourceGroups,
  limit: number,
): SearchResourceGroups {
  return {
    songs: groups.songs.slice(0, limit),
    albums: groups.albums.slice(0, limit),
    artists: groups.artists.slice(0, limit),
    playlists: groups.playlists.slice(0, limit),
  };
}

export type MusicKitMusicRequest = (
  path: string,
  query?: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<unknown>;

/** Backoff for HTTP 429 on reads; Retry-After wins, capped at 10 s. */
export const RATE_LIMIT_RETRY_DELAYS_MS = [1_000, 3_000] as const;
const MAX_RETRY_AFTER_MS = 10_000;

export interface MusicRequestOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Preferred UI languages, most preferred first. */
  languages?: () => readonly string[];
}

function isRateLimited(error: unknown): boolean {
  const record = asRecord(error);
  if (record?.status === 429 || record?.statusCode === 429) return true;
  return mapErrorToCode(error) === "RATE_LIMITED";
}

function retryAfterMs(error: unknown): number | undefined {
  const headers = asRecord(asRecord(error)?.response)?.headers as
    { get?: (name: string) => string | null } | undefined;
  const seconds = Number(headers?.get?.("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    : undefined;
}

/** Best supported tag for the user's languages, exact match first. */
function pickLanguage(
  preferred: readonly string[],
  supported: readonly string[],
): string | undefined {
  const lower = supported.map((tag) => tag.toLowerCase());
  for (const language of preferred) {
    const exact = lower.indexOf(language.toLowerCase());
    if (exact >= 0) return supported[exact];
  }
  for (const language of preferred) {
    const primary = language.split("-")[0]?.toLowerCase();
    const index = lower.findIndex((tag) => tag.split("-")[0] === primary);
    if (index >= 0) return supported[index];
  }
  return undefined;
}

/**
 * Wraps MusicKit's request function: rate-limited reads are retried with
 * bounded backoff, and catalog reads carry `l` for the user's language when
 * the storefront supports it (otherwise Apple's default applies).
 */
export function createMusicRequest(
  instance: MusicKit.MusicKitInstance,
  options: MusicRequestOptions = {},
): MusicKitMusicRequest {
  const raw = rawMusicKitMusicRequest(instance);
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const languages =
    options.languages ??
    (() =>
      typeof navigator === "undefined"
        ? []
        : navigator.languages?.length
          ? navigator.languages
          : [navigator.language]);
  let language: Promise<string | undefined> | undefined;

  const withRetry = async (
    path: string,
    query?: Record<string, unknown>,
    requestOptions?: Record<string, unknown>,
  ): Promise<unknown> => {
    const method = String(requestOptions?.method ?? "GET").toUpperCase();
    const call = (): Promise<unknown> =>
      requestOptions !== undefined
        ? raw(path, query, requestOptions)
        : query !== undefined
          ? raw(path, query)
          : raw(path);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call();
      } catch (error) {
        const delay = RATE_LIMIT_RETRY_DELAYS_MS[attempt];
        if (method !== "GET" || delay === undefined || !isRateLimited(error)) {
          throw error;
        }
        await sleep(retryAfterMs(error) ?? delay);
      }
    }
  };

  const resolveLanguage = (): Promise<string | undefined> => {
    language ??= (async () => {
      const storefront = String(instance.storefrontId ?? "").trim();
      if (!storefront) return undefined;
      try {
        const resource = asRecord(
          (
            asRecord(
              await withRetry(
                `/v1/storefronts/${encodeURIComponent(storefront)}`,
              ),
            )?.data as unknown[] | undefined
          )?.[0],
        );
        const supported = asRecord(resource?.attributes)?.supportedLanguageTags;
        return Array.isArray(supported)
          ? pickLanguage(
              languages(),
              supported.filter((tag): tag is string => typeof tag === "string"),
            )
          : undefined;
      } catch {
        language = undefined;
        return undefined;
      }
    })();
    return language;
  };

  return async (path, query, requestOptions) => {
    if (path.startsWith("/v1/catalog/") && query?.l === undefined) {
      const tag = await resolveLanguage();
      if (tag)
        return withRetry(path, { ...(query ?? {}), l: tag }, requestOptions);
    }
    return withRetry(path, query, requestOptions);
  };
}

const musicRequests = new WeakMap<object, MusicKitMusicRequest>();

export function resolveMusicKitMusicRequest(
  instance: MusicKit.MusicKitInstance,
): MusicKitMusicRequest {
  let request = musicRequests.get(instance);
  if (!request) {
    request = createMusicRequest(instance);
    musicRequests.set(instance, request);
  }
  return request;
}

function rawMusicKitMusicRequest(
  instance: MusicKit.MusicKitInstance,
): MusicKitMusicRequest {
  const api = instance.api as unknown;
  if (typeof api === "function") {
    return (api as MusicKitMusicRequest).bind(api);
  }
  if (api && typeof api === "object") {
    const record = api as Record<string, unknown>;
    if (typeof record.music === "function") {
      return (record.music as MusicKitMusicRequest).bind(record);
    }
    const v3 = record.v3;
    if (v3 && typeof v3 === "object") {
      const v3Record = v3 as Record<string, unknown>;
      if (typeof v3Record.music === "function") {
        return (v3Record.music as MusicKitMusicRequest).bind(v3Record);
      }
    }
  }
  throw new Error("MusicKit v3 catalog API is not available.");
}

export function storefrontFromMeResponse(raw: unknown): string | null {
  const root = asRecord(raw);
  const data = root?.data;
  const entries = Array.isArray(data) ? data : data ? [data] : [];
  for (const entry of entries) {
    const record = asRecord(entry);
    const id = record?.id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
}

export async function resolveStorefront(
  instance: MusicKit.MusicKitInstance,
): Promise<string> {
  const existing = String(instance.storefrontId ?? "").trim();
  if (existing) return existing;
  const request = resolveMusicKitMusicRequest(instance);
  const fromMe = storefrontFromMeResponse(await request("/v1/me/storefront"));
  if (fromMe) return fromMe;
  throw new Error(
    "MusicKit storefront is not available. Sign in and try again.",
  );
}

export function songsFromSearchResponse(raw: unknown): CatalogSongResource[] {
  const root = asRecord(raw);
  const payload = asRecord(root?.data) ?? root;
  const results = asRecord(payload?.results) ?? payload;
  const songs = asRecord(results?.songs);
  const data = songs?.data;
  if (!Array.isArray(data)) return [];
  return data.filter((item): item is CatalogSongResource => {
    const record = asRecord(item);
    return typeof record?.id === "string" && record.id.length > 0;
  });
}

export async function searchCatalogSongs(
  instance: MusicKit.MusicKitInstance,
  term: string,
  options: { limit?: number } = {},
): Promise<Track[]> {
  const trimmed = term.trim();
  if (!trimmed) return [];
  const storefront = await resolveStorefront(instance);
  const request = resolveMusicKitMusicRequest(instance);
  const raw = await request(`/v1/catalog/${storefront}/search`, {
    term: trimmed,
    types: "songs",
    limit: options.limit ?? 25,
  });
  return songsFromSearchResponse(raw).map(normalizeCatalogSong);
}

export async function searchMusicResources(
  instance: MusicKit.MusicKitInstance,
  term: string,
  source: "catalog" | "library",
  options: { limit?: number } = {},
): Promise<SearchResourceGroups> {
  const trimmed = term.trim();
  if (!trimmed) {
    return { songs: [], albums: [], artists: [], playlists: [] };
  }
  const request = resolveMusicKitMusicRequest(instance);
  const requestedLimit = options.limit ?? 10;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(0, Math.floor(requestedLimit))
    : 10;
  if (source === "catalog") {
    const storefront = await resolveStorefront(instance);
    const raw = await request(`/v1/catalog/${storefront}/search`, {
      term: trimmed,
      types: "songs,albums,artists,playlists",
      limit,
    });
    return limitSearchGroups(normalizeSearchGroups(raw), limit);
  }
  const raw = await request("/v1/me/library/search", {
    term: trimmed,
    types: "library-songs,library-albums,library-artists,library-playlists",
    limit,
  });
  return limitSearchGroups(normalizeSearchGroups(raw, "library-"), limit);
}

export async function loadBrowseCharts(
  instance: MusicKit.MusicKitInstance,
  options: { limit?: number } = {},
): Promise<BrowseResources> {
  const requestedLimit = options.limit ?? 20;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(0, Math.floor(requestedLimit))
    : 20;
  const storefront = await resolveStorefront(instance);
  const raw = await resolveMusicKitMusicRequest(instance)(
    `/v1/catalog/${storefront}/charts`,
    {
      chart: "most-played",
      types: "songs,albums,playlists",
      limit,
    },
  );
  const groups = normalizeSearchGroups(raw);
  return {
    songs: groups.songs
      .filter((track) => track.playable !== false)
      .slice(0, limit),
    albums: groups.albums.slice(0, limit),
    playlists: groups.playlists.slice(0, limit),
  };
}

function stationUrl(resource: AppleMusicResource): string | undefined {
  const record = asRecord(resource);
  const attributes = asRecord(record?.attributes);
  const playParams = asRecord(attributes?.playParams);
  const candidate = [
    attributes?.url,
    attributes?.stationUrl,
    playParams?.url,
  ].find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  return candidate?.trim();
}

function normalizeStation(resource: AppleMusicResource): Station | undefined {
  const record = asRecord(resource);
  const attributes = asRecord(record?.attributes);
  const id = typeof record?.id === "string" ? record.id : undefined;
  if (!id) return undefined;
  const artwork = asRecord(attributes?.artwork);
  const artworkUrl = typeof artwork?.url === "string" ? artwork.url : undefined;
  const url = artworkUrl
    ? artworkUrl.replace(/\{w\}/gu, "300").replace(/\{h\}/gu, "300")
    : undefined;
  const resourceType =
    typeof record?.type === "string" ? record.type : "stations";
  const isLive =
    attributes?.isLive === true ||
    resourceType.includes("live") ||
    String(attributes?.kind ?? "")
      .toLowerCase()
      .includes("live") ||
    String(attributes?.stationType ?? "")
      .toLowerCase()
      .includes("live");
  const name =
    (typeof attributes?.name === "string" ? attributes.name.trim() : "") ||
    (typeof attributes?.title === "string" ? attributes.title.trim() : "");
  if (!name) return undefined;
  return {
    id,
    name,
    description:
      typeof attributes?.description === "string"
        ? attributes.description
        : undefined,
    artwork: url ? { url, width: 300, height: 300 } : undefined,
    url: stationUrl(resource),
    isLive,
    resourceType,
  };
}

export function stationsFromResponse(raw: unknown): Station[] {
  const root = asRecord(raw);
  const data = Array.isArray(root?.data)
    ? root.data
    : Array.isArray(raw)
      ? raw
      : [];
  return data
    .map((value) => normalizeStation(value as AppleMusicResource))
    .filter((value): value is Station => Boolean(value));
}

export async function loadRadioStations(
  instance: MusicKit.MusicKitInstance,
  kind: "personal" | "live" | "recent",
): Promise<Station[]> {
  const request = resolveMusicKitMusicRequest(instance);
  const path =
    kind === "recent"
      ? "/v1/me/recent/radio-stations"
      : `/v1/catalog/${await resolveStorefront(instance)}/stations`;
  const query =
    kind === "personal"
      ? { "filter[identity]": "personal", limit: 10 }
      : kind === "live"
        ? { "filter[featured]": "apple-music-live-radio", limit: 25 }
        : { limit: 10 };
  const stations = stationsFromResponse(await request(path, query));
  return kind === "live"
    ? stations.map((station) => ({ ...station, isLive: true }))
    : stations;
}
