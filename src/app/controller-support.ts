import { normalizeLibraryItems } from "../musickit/normalize.ts";
import type { AppleMusicLibraryClient } from "../musickit/library.ts";
import type { CachedPage } from "../library/cache.ts";
import type {
  MusicResourceRef,
  MusicSource,
  PlaylistTrackResourceType,
  Track,
} from "../domain/music.ts";
import { redactSensitive } from "../platform/redact.ts";
import type { LibraryEntity } from "../state.ts";

/** Shared services the controller passes to its domain modules. */
export interface ControllerContext {
  requireMusic(): MusicKit.MusicKitInstance;
  getMusic(): MusicKit.MusicKitInstance | null;
  now(): number;
  log(message: string): void;
}

export type LibraryMethod = (...args: unknown[]) => Promise<unknown>;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function safeErrorMessage(error: unknown): string {
  return redactSensitive(errorMessage(error))
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, 500);
}

export function timestamp(now: () => number): string {
  return new Date(now()).toISOString();
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function asItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  for (const key of ["items", "data", "tracks", "resources"]) {
    if (Array.isArray(record?.[key])) return record[key] as unknown[];
  }
  return [];
}

export function asNext(value: unknown): string | undefined {
  const record = asRecord(value);
  for (const key of ["next", "nextCursor", "next_cursor", "nextUrl"]) {
    const candidate = record?.[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

export function asLibraryEntities(value: unknown): LibraryEntity[] {
  const record = asRecord(value);
  const values = typeof record?.id === "string" ? [value] : asItems(value);
  return values.filter((item): item is LibraryEntity => {
    const record = asRecord(item);
    return typeof record?.id === "string" && record.id.length > 0;
  });
}

export function normalizedLibraryEntities(value: unknown): LibraryEntity[] {
  const resources = asItems(value);
  return normalizeLibraryItems(resources) as unknown as LibraryEntity[];
}

export function asPage(
  raw: unknown,
  cursor: string | undefined,
  updatedAt: number,
): CachedPage<LibraryEntity> {
  return {
    cursor,
    items: asLibraryEntities(raw),
    next: asNext(raw),
    updatedAt,
  };
}

export function detailFromResponse(raw: unknown): {
  item?: LibraryEntity;
  items: LibraryEntity[];
  next?: string;
} {
  const record = asRecord(raw);
  const candidate = record?.item ?? record?.resource ?? raw;
  const itemRecord = asRecord(candidate);
  const item =
    typeof itemRecord?.id === "string"
      ? (itemRecord as LibraryEntity)
      : undefined;
  return {
    item,
    items: asLibraryEntities(
      record?.tracks ?? record?.items ?? record?.data ?? [],
    ),
    next: asNext(raw),
  };
}

export function detailCacheSection(
  kind: "album" | "artist" | "playlist",
  id: string,
  source: MusicSource,
): string {
  const base = `${kind}:${id}`;
  return source === "catalog" ? `${kind}:catalog:${id}` : base;
}

export function detailRequestKey(
  kind: "album" | "artist" | "playlist",
  id: string,
  source: MusicSource,
): string {
  return `${kind}:${source}:${id}`;
}

export function flattenFolderChildren(value: unknown): LibraryEntity[] {
  const output: LibraryEntity[] = [];
  const seen = new Set<string>();
  const visit = (candidate: unknown, parentId?: string): void => {
    const record = asRecord(candidate);
    if (!record || typeof record.id !== "string" || seen.has(record.id)) return;
    seen.add(record.id);
    const item = {
      ...record,
      ...(parentId && typeof record.parentId !== "string" ? { parentId } : {}),
    } as LibraryEntity;
    output.push(item);
    const children = Array.isArray(record.children) ? record.children : [];
    for (const child of children) visit(child, record.id);
  };
  const root = asRecord(value);
  const children = Array.isArray(root?.children) ? root.children : [];
  for (const child of children) visit(child, root?.id as string | undefined);
  return output;
}

export function libraryMethod(
  client: AppleMusicLibraryClient,
  name: string,
): LibraryMethod {
  const method = (client as unknown as Record<string, unknown>)[name];
  if (typeof method !== "function") {
    throw new Error(`Apple Music library operation is unavailable: ${name}`);
  }
  return method.bind(client) as LibraryMethod;
}

export function trackIds(
  tracks: readonly Track[] | readonly string[],
): string[] {
  return tracks
    .map((track) => (typeof track === "string" ? track : track.id))
    .filter((id) => id.trim().length > 0);
}

const playlistTrackTypes = new Set<PlaylistTrackResourceType>([
  "songs",
  "library-songs",
  "music-videos",
  "library-music-videos",
]);

export function trackRefs(
  tracks: readonly Track[] | readonly string[],
): MusicResourceRef[] {
  return tracks.map((track) => {
    if (typeof track === "string") {
      return { id: track, type: "songs" };
    }
    const type = playlistTrackTypes.has(
      track.resourceType as PlaylistTrackResourceType,
    )
      ? (track.resourceType as PlaylistTrackResourceType)
      : "songs";
    const id = type.startsWith("library-")
      ? track.id
      : (track.catalogId ?? track.id);
    return { id, type };
  });
}

export function materializeTracks(
  tracks: readonly Track[] | readonly string[],
): Track[] {
  return tracks
    .map((track) =>
      typeof track === "string"
        ? {
            id: track.trim(),
            title: track.trim(),
            artistName: "Unknown Artist",
          }
        : track,
    )
    .filter((track) => track.id.trim().length > 0);
}

export function sameTrackIds(
  left: readonly Track[],
  right: readonly Track[],
): boolean {
  return (
    left.length === right.length &&
    left.every((track, index) => track.id === right[index]?.id)
  );
}
