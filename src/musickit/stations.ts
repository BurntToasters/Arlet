import type { MusicSource, Station, Track } from "../domain/music.ts";
import { httpStatusOf } from "./errors.ts";
import {
  normalizeStation,
  resolveMusicKitMusicRequest,
  resolveStorefront,
} from "./catalog.ts";
import { normalizeTrackResource } from "./normalize.ts";

export interface StationTarget {
  kind: "song" | "artist";
  id: string;
  catalogId?: string;
  source?: MusicSource;
}

type Body = Record<string, unknown>;

function asBody(value: unknown): Body | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Body)
    : undefined;
}

/** Accepts the MusicKit `{ request, response, data }` envelope or a bare body. */
function bodyOf(raw: unknown): Body | undefined {
  const root = asBody(raw);
  return asBody(root?.data) ?? root;
}

/** First related resource of the first `data` entry, e.g. `station`. */
function firstRelated(body: Body | undefined, name: string): unknown {
  const resource = asBody(Array.isArray(body?.data) ? body.data[0] : undefined);
  const related = asBody(asBody(resource?.relationships)?.[name]);
  return Array.isArray(related?.data) ? related.data[0] : undefined;
}

/** Library song IDs carry a one-letter prefix, e.g. `i.`. */
function isLibraryId(id: string): boolean {
  return /^[a-z]\.\S/iu.test(id);
}

/** Station and top-songs lookups with per-catalog-ID caching. */
export function createStationResolver(instance: MusicKit.MusicKitInstance) {
  const request = resolveMusicKitMusicRequest(instance);
  const stations = new Map<string, Promise<Station | undefined>>();
  const artistIds = new Map<string, Promise<string | undefined>>();

  /** A missing resource is "none", not a failure worth surfacing. */
  const orNone = async <T>(load: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await load();
    } catch (error) {
      if (httpStatusOf(error) === 404) return undefined;
      throw error;
    }
  };

  /** Dedupes by key; failed lookups are dropped so a retry can succeed. */
  const cached = <T>(
    cache: Map<string, Promise<T>>,
    key: string,
    load: () => Promise<T>,
  ): Promise<T> => {
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = load();
    cache.set(key, pending);
    pending.catch(() => {
      if (cache.get(key) === pending) cache.delete(key);
    });
    return pending;
  };

  const catalogArtistId = (
    id: string,
    catalogId: string | undefined,
    source: MusicSource | undefined,
  ): Promise<string | undefined> => {
    if (catalogId) return Promise.resolve(catalogId);
    if (source === "catalog") return Promise.resolve(id);
    return cached(artistIds, id, () =>
      orNone(async () => {
        const body = bodyOf(
          await request(`/v1/me/library/artists/${encodeURIComponent(id)}`, {
            include: "catalog",
          }),
        );
        const first = asBody(firstRelated(body, "catalog"));
        return typeof first?.id === "string" ? first.id : undefined;
      }),
    );
  };

  const stationFor = async (
    target: StationTarget,
  ): Promise<Station | undefined> => {
    const catalogId =
      target.kind === "song"
        ? (target.catalogId ?? (isLibraryId(target.id) ? undefined : target.id))
        : await catalogArtistId(target.id, target.catalogId, target.source);
    if (!catalogId) return undefined;
    const key = `${target.kind}:${catalogId}`;
    return cached(stations, key, () =>
      orNone(async () => {
        const storefront = await resolveStorefront(instance);
        const type = target.kind === "song" ? "songs" : "artists";
        const body = bodyOf(
          await request(
            `/v1/catalog/${encodeURIComponent(storefront)}/${type}/${encodeURIComponent(catalogId)}`,
            { include: "station" },
          ),
        );
        const first = firstRelated(body, "station");
        return first
          ? normalizeStation(first as Parameters<typeof normalizeStation>[0])
          : undefined;
      }),
    );
  };

  const topSongs = async (
    id: string,
    catalogId: string | undefined,
    source: MusicSource | undefined,
    limit = 10,
  ): Promise<Track[]> => {
    const artistId = await catalogArtistId(id, catalogId, source);
    if (!artistId) return [];
    const storefront = await resolveStorefront(instance);
    const body = bodyOf(
      await request(
        `/v1/catalog/${encodeURIComponent(storefront)}/artists/${encodeURIComponent(artistId)}/view/top-songs`,
        { limit },
      ),
    );
    const list = Array.isArray(body?.data) ? body.data : [];
    const tracks: Track[] = [];
    for (const value of list) {
      const track = asBody(value)
        ? normalizeTrackResource(value as never)
        : undefined;
      if (track) tracks.push(track);
    }
    return tracks;
  };

  return { stationFor, topSongs };
}
