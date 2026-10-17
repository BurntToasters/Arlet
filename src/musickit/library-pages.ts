/**
 * Page reads for the Apple library and catalog client: the request primitives
 * the other library-* modules build on, and the paging and cursor guards.
 */
import type { AppleMusicResource } from "./normalize.ts";
import {
  asRecord,
  findNextValue,
  findResourceArray,
  findTotal,
  safeNextPath,
} from "./response.ts";

export interface Page<T> {
  items: T[];
  /** Opaque path supplied by Apple for the next page. */
  next?: string;
  total?: number;
}

export interface LibraryPageOptions {
  cursor?: string;
  limit?: number;
}

/**
 * Largest page Apple accepts for library and catalog song, album, artist,
 * playlist and track lists. Recent-history endpoints cap lower, so they
 * keep Apple's default.
 */
export const LIBRARY_PAGE_LIMIT = 100;

/** Most ids Apple takes in one library multi-get or ratings request. */
export const MAX_BATCH_IDS = 100;

export type Query = Record<string, unknown>;
export type RequestOptions = {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
};
export type MusicRequest = (
  path: string,
  query?: Query,
  options?: RequestOptions,
) => Promise<unknown>;

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resourceLike(value: unknown): value is AppleMusicResource {
  const record = asRecord(value);
  return Boolean(
    record &&
    nonEmptyString(record.id) &&
    (nonEmptyString(record.type) ?? record.attributes !== undefined),
  );
}

export function firstResource(
  value: unknown,
  depth = 0,
): AppleMusicResource | undefined {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstResource(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (resourceLike(value)) return value;
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of [
    "data",
    "results",
    "resource",
    "item",
    "playlist",
    "album",
    "artist",
    "library-playlists",
    "library-playlist-folders",
  ]) {
    const found = firstResource(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

function withPageMetadata<T>(items: T[], raw: unknown): Page<T> {
  const page: Page<T> = { items };
  const next = safeNextPath(findNextValue(raw), APPLE_PAGE_PREFIXES);
  if (next) page.next = next;
  const total = findTotal(raw);
  if (total !== undefined) page.total = total;
  return page;
}

export function resourceKey(value: unknown): string | undefined {
  const record = asRecord(value);
  const id = nonEmptyString(record?.id);
  const type = nonEmptyString(record?.type);
  return id && type ? `${type}:${id}` : undefined;
}

export function encodePathPart(value: string): string {
  return encodeURIComponent(value.trim());
}

/**
 * Options for a non-GET call. MusicKit v3 sends only `fetchOptions` to
 * `fetch`; the top-level `method` tells the retry wrapper not to retry.
 */
export function mutationOptions(
  method: string,
  body?: unknown,
): RequestOptions {
  const init: RequestOptions = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  // MusicKit merges these headers with its auth headers.
  const fetchOptions =
    body === undefined
      ? { ...init }
      : { ...init, headers: { "Content-Type": "application/json" } };
  return { ...init, fetchOptions };
}

/**
 * Apple's `next` cursor does not always repeat the page size, so later pages
 * would fall back to 25 items; the requested limit is carried over.
 */
function withLimit(cursor: string, limit: number | undefined): string {
  if (limit === undefined || /[?&]limit=/u.test(cursor)) return cursor;
  return `${cursor}${cursor.includes("?") ? "&" : "?"}limit=${limit}`;
}

/**
 * Apple's `next` path usually carries only `offset`, so the call's query fills
 * in the keys it lacks (such as `include`). Keys the cursor already has win.
 */
function withMissingQuery(cursor: string, query: Query | undefined): string {
  const index = cursor.indexOf("?");
  const base = index === -1 ? cursor : cursor.slice(0, index);
  const search = index === -1 ? "" : cursor.slice(index + 1);
  const carried = new URLSearchParams(search);
  const missing = Object.entries(query ?? {}).filter(
    ([key, value]) => value !== undefined && !carried.has(key),
  );
  if (missing.length === 0) return cursor;
  const added = missing
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join("&");
  return `${base}?${search ? `${search}&` : ""}${added}`;
}

/** Apple's own page paths: the user's library and the catalog twin. */
export const APPLE_PAGE_PREFIXES = ["/v1/me/", "/v1/catalog/"];

export function createPageReaders(request: MusicRequest) {
  async function getPage<T>(
    path: string,
    cursor: string | LibraryPageOptions | undefined,
    query: Query | undefined,
    normalize: (resource: AppleMusicResource) => T | undefined,
  ): Promise<Page<T>> {
    const cursorValue = typeof cursor === "string" ? cursor : cursor?.cursor;
    const limit = typeof cursor === "object" ? cursor.limit : undefined;
    const firstQuery =
      limit === undefined ? query : { ...(query ?? {}), limit };
    // A cursor Apple did not hand out as a safe path ends the list here.
    const cursorPath = cursorValue?.trim()
      ? safeNextPath(cursorValue, APPLE_PAGE_PREFIXES)
      : undefined;
    if (cursorValue?.trim() && !cursorPath) return { items: [] };
    const raw = cursorPath
      ? await request(withLimit(withMissingQuery(cursorPath, query), limit))
      : firstQuery === undefined
        ? await request(path)
        : await request(path, firstQuery);
    const resources = findResourceArray(raw) ?? [];
    const items: T[] = [];
    for (const value of resources) {
      const resource = asRecord(value) as AppleMusicResource | undefined;
      if (!resource) continue;
      const item = normalize(resource);
      if (item !== undefined) items.push(item);
    }
    return withPageMetadata(items, raw);
  }

  async function getOne<T>(
    path: string,
    normalize: (resource: AppleMusicResource) => T | undefined,
    query?: Query,
  ): Promise<T | undefined> {
    const raw =
      query === undefined ? await request(path) : await request(path, query);
    const resource = firstResource(raw);
    return resource ? normalize(resource) : undefined;
  }

  return { getPage, getOne };
}
