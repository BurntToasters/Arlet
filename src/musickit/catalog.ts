import type { Track } from "../domain/music.ts";
import { normalizeCatalogSong, type CatalogSongResource } from "./normalize.ts";

export type MusicKitMusicRequest = (
  path: string,
  query?: Record<string, unknown>,
) => Promise<unknown>;

export function resolveMusicKitMusicRequest(
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
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
