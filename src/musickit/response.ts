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
  if (!allowedPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
    return undefined;
  }
  return next;
}
