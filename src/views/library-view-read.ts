import type { RuntimeAppState } from "../state.ts";
import type { LibrarySection } from "../routing/router.ts";
import {
  objectValue,
  stringValue,
  type CollectionLike,
} from "./library-view-convert.ts";

interface DetailLike extends CollectionLike {
  item?: unknown;
  resource?: unknown;
  tracks?: unknown[];
  albums?: unknown[];
}

interface LibraryModelLike {
  collections?: Record<string, unknown>;
  details?: object;
  [key: string]: unknown;
}

function readLibrary(
  state: Pick<RuntimeAppState, "library">,
): LibraryModelLike {
  return { ...state.library };
}

export function readCollection(
  state: Pick<RuntimeAppState, "library">,
  section: LibrarySection,
): CollectionLike {
  const library = readLibrary(state);
  const collections = objectValue(library.collections) ?? library;
  const value = objectValue(collections[section]);
  if (!value) return { items: [], status: "idle" };
  const items = Array.isArray(value.items)
    ? value.items
    : Array.isArray(value.results)
      ? value.results
      : [];
  return {
    items,
    status: stringValue(value.status) ?? (items.length ? "success" : "idle"),
    next: typeof value.next === "string" ? value.next : null,
    error: stringValue(value.error, objectValue(value.error)?.message),
    source: stringValue(value.source),
    lastUpdatedAt: value.lastUpdatedAt as number | string | undefined,
    stale: value.stale === true,
    isStale: value.isStale === true,
  };
}

export function readDetail(
  state: Pick<RuntimeAppState, "library">,
  kind: "album" | "artist" | "playlist",
  id: string,
): DetailLike {
  const library = readLibrary(state);
  const details = objectValue(library.details);
  const byKind = objectValue(details?.[kind]);
  const value = objectValue(byKind?.[id]) ?? objectValue(details?.[id]);
  if (!value) return { items: [], status: "idle" };
  const items = Array.isArray(value.items)
    ? value.items
    : Array.isArray(value.tracks)
      ? value.tracks
      : [];
  return {
    items,
    status: stringValue(value.status) ?? (items.length ? "success" : "idle"),
    next: typeof value.next === "string" ? value.next : null,
    error: stringValue(value.error, objectValue(value.error)?.message),
    source: stringValue(value.source),
    lastUpdatedAt: value.lastUpdatedAt as number | string | undefined,
    stale: value.stale === true,
    isStale: value.isStale === true,
    resource: value.resource,
    item: value.item,
    tracks: Array.isArray(value.tracks) ? value.tracks : undefined,
    albums: Array.isArray(value.albums) ? value.albums : undefined,
  };
}

/** Shared empty list, so memos keyed on it do not rerun every render. */
export const NO_ITEMS: readonly unknown[] = [];

export function readPlaylistFolderItems(
  state: Pick<RuntimeAppState, "library">,
): readonly unknown[] {
  const library = readLibrary(state);
  const details = objectValue(library.details);
  const folder = objectValue(details?.playlistFolder);
  return Array.isArray(folder?.items) ? folder.items : NO_ITEMS;
}
