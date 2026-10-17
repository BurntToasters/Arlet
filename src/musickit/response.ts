/**
 * Shared readers for Apple Music response bodies. MusicKit's `api.music`
 * resolves to `{ data: body }`, while a plain body is Apple's JSON itself.
 * These helpers accept both shapes so every parser reads them the same way.
 */

const APPLE_ORIGIN = "https://api.music.apple.com";

/** A plain object, or undefined. Arrays are not records. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * The body inside MusicKit's `{ data: body }` envelope, or the plain body when
 * there is no envelope. The envelope is unwrapped only when `data` is an object.
 */
export function responseBody(
  raw: unknown,
): Record<string, unknown> | undefined {
  const root = asRecord(raw);
  return asRecord(root?.data) ?? root;
}

/**
 * The resource array of a response: `{ data: [...] }`, the envelope
 * `{ data: { data: [...] } }`, or a bare array. Anything else is empty.
 */
export function dataArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const root = asRecord(raw);
  const outer = root?.data;
  if (Array.isArray(outer)) return outer;
  const body = asRecord(outer)?.data;
  return Array.isArray(body) ? body : [];
}

/** Apple's `results` object (search and charts), in either envelope shape. */
export function resultsOf(raw: unknown): Record<string, unknown> | undefined {
  const body = responseBody(raw);
  return asRecord(body?.results) ?? body;
}

/**
 * Apple's `next` cursor, returned only when it is a relative `/v1/...` path
 * that starts with one of `allowedPrefixes`. Anything else (a scheme, a host,
 * a backslash, a traversal segment, another area of the API) is undefined, so
 * a response cannot point a follow-up request somewhere else.
 */
export function safeNextPath(
  next: unknown,
  allowedPrefixes: readonly string[],
): string | undefined {
  if (typeof next !== "string" || !next.startsWith("/v1/")) return undefined;
  if (next.includes("\\") || /\p{Cc}/u.test(next)) return undefined;
  let url: URL;
  try {
    url = new URL(next, APPLE_ORIGIN);
  } catch {
    return undefined;
  }
  if (url.origin !== APPLE_ORIGIN) return undefined;
  // The raw and normalized paths must both match, so `..` or `%2e` segments
  // cannot move a path that looked allowed into another area of the API.
  const rawPath = next.split(/[?#]/, 1)[0] ?? next;
  const allowed = allowedPrefixes.some(
    (prefix) => url.pathname.startsWith(prefix) && rawPath.startsWith(prefix),
  );
  if (!allowed) return undefined;
  return `${url.pathname}${url.search}`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The first resource array found by walking known wrapper keys, up to a fixed
 * depth. Prefer `dataArray` for Apple's standard shapes. Use this walker when
 * the wrapper varies, such as SDK envelopes or library responses.
 */
export function findResourceArray(
  value: unknown,
  depth = 0,
): unknown[] | undefined {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return undefined;

  // Standard Apple response shape and common SDK envelope shape.
  if (Array.isArray(record.data)) return record.data;
  for (const key of [
    "data",
    "results",
    "resources",
    "items",
    "songs",
    "albums",
    "artists",
    "playlists",
    "tracks",
    "library-songs",
    "library-albums",
    "library-artists",
    "library-playlists",
    "library-music-videos",
  ]) {
    const found = findResourceArray(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * The first `next` cursor found by walking known wrapper keys, up to a fixed
 * depth. Pass the result to `safeNextPath`; it is not validated here.
 */
export function findNextValue(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || Array.isArray(value)) return undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  const next = nonEmptyString(record.next);
  if (next) return next;
  const links = asRecord(record.links);
  const linkNext = nonEmptyString(links?.next);
  if (linkNext) return linkNext;
  for (const key of [
    "data",
    "results",
    "resources",
    "items",
    "meta",
    "songs",
    "albums",
    "artists",
    "playlists",
    "tracks",
    "library-playlists",
    "library-songs",
  ]) {
    const found = findNextValue(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * The first non-negative finite `total` found by walking known wrapper keys,
 * up to a fixed depth. A `meta.total` counts too.
 */
export function findTotal(value: unknown, depth = 0): number | undefined {
  if (depth > 8 || Array.isArray(value)) return undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  const directTotal = record.total;
  if (
    typeof directTotal === "number" &&
    Number.isFinite(directTotal) &&
    directTotal >= 0
  ) {
    return directTotal;
  }
  const meta = asRecord(record.meta);
  if (
    typeof meta?.total === "number" &&
    Number.isFinite(meta.total) &&
    meta.total >= 0
  ) {
    return meta.total;
  }
  for (const key of [
    "data",
    "results",
    "resources",
    "items",
    "songs",
    "albums",
    "artists",
    "playlists",
    "tracks",
    "library-playlists",
    "library-songs",
  ]) {
    const found = findTotal(record[key], depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}
