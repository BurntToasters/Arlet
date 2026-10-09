import type { Track } from "../domain/music.ts";
import { resolveMusicKitMusicRequest, resolveStorefront } from "./catalog.ts";

/** TTML larger than this is rejected before it reaches the DOM parser. */
export const MAX_LYRICS_BYTES = 512 * 1024;

export interface LyricLine {
  start?: number;
  end?: number;
  text: string;
}

export interface ParsedLyrics {
  /** True when at least one line has a valid start time. */
  synced: boolean;
  lines: LyricLine[];
}

export type LyricsResult =
  { status: "available"; lyrics: ParsedLyrics } | { status: "unavailable" };

export interface LyricsLoader {
  load(track: Track): Promise<LyricsResult>;
  clear(): void;
}

const UNAVAILABLE: LyricsResult = { status: "unavailable" };
// Apple rejects lyrics for third-party developer tokens with these codes.
const DENIED_STATUSES = new Set([401, 403]);
// A missing lyrics resource affects only that song.
const MISSING_STATUS = 404;
const HMS = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/u;
const MS = /^(\d+):(\d{1,2}(?:\.\d+)?)$/u;
const SECONDS = /^\d+(?:\.\d+)?$/u;
const OFFSET = /^(\d+(?:\.\d+)?)(ms|h|m|s)$/u;
const OFFSET_UNITS: Record<string, number> = {
  h: 3600,
  m: 60,
  s: 1,
  ms: 0.001,
};

function finiteOrUndefined(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Parses TTML clock (`hh:mm:ss.fff`, `mm:ss.fff`, `ss.fff`) and offset
 * (`12.3s`) times. Anything else returns undefined; it never throws.
 */
export function parseTtmlTime(
  value: string | null | undefined,
): number | undefined {
  const text = value?.trim() ?? "";
  if (!text) return undefined;
  const hms = HMS.exec(text);
  if (hms) {
    const minutes = Number(hms[2]);
    const seconds = Number(hms[3]);
    if (minutes >= 60 || seconds >= 60) return undefined;
    return finiteOrUndefined(Number(hms[1]) * 3600 + minutes * 60 + seconds);
  }
  const ms = MS.exec(text);
  if (ms) {
    const seconds = Number(ms[2]);
    if (seconds >= 60) return undefined;
    return finiteOrUndefined(Number(ms[1]) * 60 + seconds);
  }
  if (SECONDS.test(text)) return finiteOrUndefined(Number(text));
  const offset = OFFSET.exec(text);
  if (offset) {
    return finiteOrUndefined(
      Number(offset[1]) * (OFFSET_UNITS[offset[2] ?? "s"] ?? 1),
    );
  }
  return undefined;
}

/**
 * Reads only `<p>` timing and text from TTML. The result is plain data, so
 * markup, scripts and event handler attributes in the source never run.
 * Returns undefined for oversized or malformed input.
 */
export function parseLyricsTtml(ttml: string): ParsedLyrics | undefined {
  if (
    ttml.length > MAX_LYRICS_BYTES ||
    new TextEncoder().encode(ttml).byteLength > MAX_LYRICS_BYTES
  ) {
    return undefined;
  }
  const doc = new DOMParser().parseFromString(ttml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return undefined;

  const lines: LyricLine[] = [];
  for (const paragraph of Array.from(doc.getElementsByTagNameNS("*", "p"))) {
    const text = (paragraph.textContent ?? "").replace(/\s+/gu, " ").trim();
    if (!text) continue;
    const start = parseTtmlTime(paragraph.getAttribute("begin"));
    const end = parseTtmlTime(paragraph.getAttribute("end"));
    lines.push({
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
      text,
    });
  }
  return { synced: lines.some((line) => line.start !== undefined), lines };
}

/** Apple catalog song ID for lyrics; library songs use their catalog ID. */
export function lyricsCatalogId(
  track: Pick<Track, "id" | "catalogId" | "resourceType">,
): string | undefined {
  if (track.catalogId) return track.catalogId;
  return track.resourceType === "songs" ? track.id : undefined;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const response = record.response as Record<string, unknown> | undefined;
  for (const value of [record.status, record.statusCode, response?.status]) {
    if (typeof value === "number") return value;
  }
  return undefined;
}

function ttmlFromResponse(raw: unknown): string | undefined {
  const data = (raw as { data?: unknown } | null | undefined)?.data;
  const first = Array.isArray(data) ? data[0] : undefined;
  const attributes = (first as { attributes?: { ttml?: unknown } } | undefined)
    ?.attributes;
  return typeof attributes?.ttml === "string" ? attributes.ttml : undefined;
}

/**
 * Lyrics for the current session. A 401/403 turns lyrics off for the rest of
 * the session; a 404 marks only that song unavailable. Results are cached per catalog ID; transient failures are
 * not cached, so a later view can retry.
 */
export function createLyricsLoader(
  requireMusic: () => MusicKit.MusicKitInstance,
): LyricsLoader {
  let capable = true;
  let generation = 0;
  const results = new Map<string, LyricsResult>();
  const pending = new Map<string, Promise<LyricsResult>>();

  const fetchLyrics = async (catalogId: string): Promise<LyricsResult> => {
    const instance = requireMusic();
    const storefront = await resolveStorefront(instance);
    const raw = await resolveMusicKitMusicRequest(instance)(
      `/v1/catalog/${encodeURIComponent(storefront)}/songs/${encodeURIComponent(catalogId)}/lyrics`,
    );
    const ttml = ttmlFromResponse(raw);
    const lyrics = ttml === undefined ? undefined : parseLyricsTtml(ttml);
    return lyrics && lyrics.lines.length > 0
      ? { status: "available", lyrics }
      : UNAVAILABLE;
  };

  return {
    load(track: Track): Promise<LyricsResult> {
      const catalogId = lyricsCatalogId(track);
      if (!track.hasLyrics || !catalogId || !capable) {
        return Promise.resolve(UNAVAILABLE);
      }
      const cached = results.get(catalogId);
      if (cached) return Promise.resolve(cached);
      const inFlight = pending.get(catalogId);
      if (inFlight) return inFlight;

      const requestGeneration = generation;
      const request: Promise<LyricsResult> = fetchLyrics(catalogId).then(
        (result) => {
          if (requestGeneration === generation) {
            results.set(catalogId, result);
          }
          return result;
        },
        (error: unknown) => {
          const status = errorStatus(error);
          if (status !== undefined && DENIED_STATUSES.has(status)) {
            capable = false;
          } else if (
            status === MISSING_STATUS &&
            requestGeneration === generation
          ) {
            results.set(catalogId, UNAVAILABLE);
          }
          return UNAVAILABLE;
        },
      );
      pending.set(catalogId, request);
      void request.finally(() => {
        if (pending.get(catalogId) === request) pending.delete(catalogId);
      });
      return request;
    },
    clear(): void {
      generation += 1;
      results.clear();
      pending.clear();
    },
  };
}
