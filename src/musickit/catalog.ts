import type {
  Album,
  Artist,
  Playlist,
  Station,
  Track,
} from "../domain/music.ts";
import { httpStatusOf, mapErrorToCode } from "./errors.ts";
import { asRecord, dataArray, resultsOf } from "./response.ts";
import {
  normalizeAlbumResource,
  normalizeArtistResource,
  normalizeCatalogSong,
  normalizePlaylistResource,
  artworkFromUnknown,
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

function resourceData(raw: unknown, type: string): AppleMusicResource[] {
  if (Array.isArray(raw)) return raw as AppleMusicResource[];
  const results = resultsOf(raw);
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
  return dataArray(raw) as AppleMusicResource[];
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

// MKError keeps the HTTP status and Response on `data`, and reports a 429
// as errorCode QUOTA_EXCEEDED; httpStatusOf reads all of these.
function isRateLimited(error: unknown): boolean {
  if (httpStatusOf(error) === 429) return true;
  return mapErrorToCode(error) === "RATE_LIMITED";
}

function retryAfterMs(error: unknown): number | undefined {
  const record = asRecord(error);
  const header = [record?.data, record?.response]
    .map(
      (value) =>
        asRecord(value)?.headers as
          { get?: (name: string) => string | null } | undefined,
    )
    .map((headers) => headers?.get?.("retry-after"))
    .find((value) => value !== undefined && value !== null);
  // An absent header must not read as Number(null) === 0.
  if (header === undefined || header === null) return undefined;
  const seconds = Number(header);
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
  // Looked up per call: MusicKit replaces its API object, and the user token
  // in its headers, on every sign-in and sign-out.
  const raw: MusicKitMusicRequest = (path, query, requestOptions) => {
    const music = rawMusicKitMusicRequest(instance);
    return requestOptions !== undefined
      ? music(path, query, requestOptions)
      : query !== undefined
        ? music(path, query)
        : music(path);
  };
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
  // The instance outlives sign-out; another account can have another storefront.
  let languageStorefront = "";

  const withRetry = async (
    path: string,
    query?: Record<string, unknown>,
    requestOptions?: Record<string, unknown>,
  ): Promise<unknown> => {
    const method = String(requestOptions?.method ?? "GET").toUpperCase();
    const call = (): Promise<unknown> => raw(path, query, requestOptions);
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
    const storefront = String(instance.storefrontId ?? "").trim();
    // Before sign-in there is no storefront yet; nothing is cached, so the
    // language is looked up once one exists.
    if (!storefront) return Promise.resolve(undefined);
    if (storefront !== languageStorefront) {
      languageStorefront = storefront;
      language = undefined;
    }
    language ??= (async () => {
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

  const request: MusicKitMusicRequest = async (path, query, requestOptions) => {
    // Apple's next-page paths can already carry `l`; never send it twice.
    if (
      path.startsWith("/v1/catalog/") &&
      query?.l === undefined &&
      !/[?&]l=/u.test(path)
    ) {
      const tag = await resolveLanguage();
      if (tag)
        return withRetry(path, { ...(query ?? {}), l: tag }, requestOptions);
    }
    return withRetry(path, query, requestOptions);
  };

  return async (path, query, requestOptions) => {
    const guard = userTokenGuards.get(instance);
    const userPath = isUserPath(path);
    if (guard && userPath && guard.blocked()) {
      throw new Error(SESSION_EXPIRED_MESSAGE);
    }
    try {
      return await request(path, query, requestOptions);
    } catch (error) {
      if (guard && userPath) guard.onRejected(error, path);
      throw readableRefusal(error, userPath);
    }
  };
}

/**
 * MusicKit reports a refused request as its bare status ("403"). The status
 * and reason stay on the error; only the message the views show is replaced.
 */
function readableRefusal(error: unknown, userPath: boolean): unknown {
  const status = httpStatusOf(error);
  if (status !== 401 && status !== 403) return error;
  if (!(error instanceof Error) || !/^\s*\d*\s*$/u.test(error.message)) {
    return error;
  }
  try {
    error.message = userPath
      ? "Apple Music didn't accept your sign-in. Sign in again from Settings."
      : "Apple Music refused the request. Try again later.";
  } catch {
    // A read-only message keeps the original text.
  }
  return error;
}

export const SESSION_EXPIRED_MESSAGE =
  "Your Apple Music sign-in expired. Sign in again to load your library.";

export interface UserTokenGuard {
  /** True while the sign-in is known expired; `/v1/me` calls then fail at once. */
  blocked(): boolean;
  /** A `/v1/me` request failed. The caller decides whether the token is dead. */
  onRejected(error: unknown, path: string): void;
}

const userTokenGuards = new WeakMap<object, UserTokenGuard>();

const isUserPath = (path: string): boolean => /^\/v1\/me(?:[/?]|$)/u.test(path);

export function setUserTokenGuard(
  instance: MusicKit.MusicKitInstance,
  guard: UserTokenGuard | undefined,
): void {
  if (guard) userTokenGuards.set(instance, guard);
  else userTokenGuards.delete(instance);
}

/** Cheapest user-scoped call; sent without the guard to test the token. */
export function probeUserToken(
  instance: MusicKit.MusicKitInstance,
): Promise<unknown> {
  return rawMusicKitMusicRequest(instance)("/v1/me/storefront");
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
  // The envelope's `data` is the body, so the entries come from dataArray.
  const single = asRecord(raw)?.data;
  const listed = dataArray(raw);
  const entries = listed.length > 0 ? listed : single ? [single] : [];
  for (const entry of entries) {
    const record = asRecord(entry);
    const id = record?.id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
}

/**
 * Fallback lookups by instance. An entry is valid only for the user token it
 * was made with, so sign-out or a different account never reuses it.
 */
const storefrontFallbacks = new WeakMap<
  object,
  { userToken: string; storefront: Promise<string> }
>();

async function fetchStorefrontFromMe(
  instance: MusicKit.MusicKitInstance,
): Promise<string> {
  const request = resolveMusicKitMusicRequest(instance);
  const fromMe = storefrontFromMeResponse(await request("/v1/me/storefront"));
  if (fromMe) return fromMe;
  throw new Error(
    "MusicKit storefront is not available. Sign in and try again.",
  );
}

export async function resolveStorefront(
  instance: MusicKit.MusicKitInstance,
): Promise<string> {
  const existing = String(instance.storefrontId ?? "").trim();
  if (existing) return existing;
  const userToken = String(instance.musicUserToken ?? "");
  let cached = storefrontFallbacks.get(instance);
  if (cached?.userToken !== userToken) {
    const lookup = fetchStorefrontFromMe(instance);
    cached = { userToken, storefront: lookup };
    storefrontFallbacks.set(instance, cached);
    // A failed lookup is not kept, so the next call asks Apple again.
    void lookup.catch(() => {
      if (storefrontFallbacks.get(instance)?.storefront === lookup) {
        storefrontFallbacks.delete(instance);
      }
    });
  }
  return cached.storefront;
}

export function songsFromSearchResponse(raw: unknown): CatalogSongResource[] {
  const songs = asRecord(resultsOf(raw)?.songs);
  const data = songs?.data;
  if (!Array.isArray(data)) return [];
  return data.filter((item): item is CatalogSongResource => {
    const record = asRecord(item);
    return typeof record?.id === "string" && record.id.length > 0;
  });
}

/** Apple accepts 1 to 25 search results per type; anything else is a 400. */
function searchLimit(requested: number | undefined, fallback: number): number {
  const value = requested ?? fallback;
  return Number.isFinite(value)
    ? Math.min(25, Math.max(1, Math.floor(value)))
    : fallback;
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
  const raw = await request(
    `/v1/catalog/${encodeURIComponent(storefront)}/search`,
    {
      term: trimmed,
      types: "songs",
      limit: searchLimit(options.limit, 25),
    },
  );
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
  const limit = searchLimit(options.limit, 10);
  if (source === "catalog") {
    const storefront = await resolveStorefront(instance);
    const raw = await request(
      `/v1/catalog/${encodeURIComponent(storefront)}/search`,
      {
        term: trimmed,
        types: "songs,albums,artists,playlists",
        limit,
      },
    );
    return limitSearchGroups(normalizeSearchGroups(raw), limit);
  }
  const raw = await request("/v1/me/library/search", {
    term: trimmed,
    types: "library-songs,library-albums,library-artists,library-playlists",
    limit,
  });
  return limitSearchGroups(normalizeSearchGroups(raw, "library-"), limit);
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

export function normalizeStation(
  resource: AppleMusicResource,
): Station | undefined {
  const record = asRecord(resource);
  const attributes = asRecord(record?.attributes);
  const id = typeof record?.id === "string" ? record.id : undefined;
  if (!id) return undefined;
  // Shared with every other resource: fills all template fields and drops
  // URLs that are not http(s).
  const artwork = artworkFromUnknown(attributes?.artwork, 300);
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
    artwork,
    url: stationUrl(resource),
    isLive,
    resourceType,
  };
}

export function stationsFromResponse(raw: unknown): Station[] {
  return dataArray(raw)
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
      : `/v1/catalog/${encodeURIComponent(await resolveStorefront(instance))}/stations`;
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
