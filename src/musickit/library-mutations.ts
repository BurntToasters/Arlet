/**
 * Writes to the Apple library: adding catalog items to the library, and adding
 * tracks to a library playlist.
 */
import {
  encodePathPart,
  mutationOptions,
  type MusicRequest,
} from "./library-pages.ts";
import { normalizeMusicResourceRef } from "./normalize.ts";
import type { MusicResourceRef } from "../domain/music.ts";

export function normalizedRefs(
  refs: readonly (MusicResourceRef | string)[],
): MusicResourceRef[] {
  return refs.map((ref) => {
    const normalized = normalizeMusicResourceRef(
      typeof ref === "string" ? { id: ref, type: "songs" } : ref,
    );
    if (!normalized) {
      throw new Error("Unsupported playlist track resource reference.");
    }
    return normalized;
  });
}

export async function addTracksToPlaylist(
  request: MusicRequest,
  playlistId: string,
  refs: readonly (MusicResourceRef | string)[],
): Promise<void> {
  if (!playlistId.trim()) throw new Error("Playlist id is required.");
  if (refs.length === 0) return;
  await request(
    `/v1/me/library/playlists/${encodePathPart(playlistId)}/tracks`,
    undefined,
    mutationOptions("POST", { data: normalizedRefs(refs) }),
  );
}

/** Catalog kinds accepted by `POST /v1/me/library`. */
export interface AddToLibraryIds {
  songs?: readonly string[];
  albums?: readonly string[];
  playlists?: readonly string[];
}

export async function addToLibrary(
  request: MusicRequest,
  items: AddToLibraryIds,
): Promise<void> {
  const query: Record<string, string> = {};
  for (const type of ["songs", "albums", "playlists"] as const) {
    const ids = (items[type] ?? []).map((id) => id.trim()).filter(Boolean);
    if (ids.length > 0) query[`ids[${type}]`] = ids.join(",");
  }
  if (Object.keys(query).length === 0) {
    throw new Error("At least one item is required.");
  }
  await request("/v1/me/library", query, mutationOptions("POST"));
}
