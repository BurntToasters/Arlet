import type { Activity, Playlist } from "../domain/music.ts";
import { resolveMusicKitMusicRequest, resolveStorefront } from "./catalog.ts";
import { asRecord, dataArray } from "./response.ts";
import {
  artworkFromUnknown,
  normalizePlaylistResource,
  type AppleMusicResource,
} from "./normalize.ts";

/** Most playlists an activity page lists; later ones are never read. */
export const ACTIVITY_PLAYLIST_LIMIT = 10;

type UnknownRecord = Record<string, unknown>;

/** The first `limit` distinct playlist references Apple sent, in order. */
function playlistRefsOf(resource: AppleMusicResource): UnknownRecord[] {
  const data = asRecord(asRecord(resource.relationships)?.playlists)?.data;
  const seen = new Set<string>();
  const refs: UnknownRecord[] = [];
  for (const entry of Array.isArray(data) ? data : []) {
    const ref = asRecord(entry);
    const id = typeof ref?.id === "string" ? ref.id : "";
    if (!ref || !id || seen.has(id)) continue;
    seen.add(id);
    refs.push(ref);
    if (refs.length === ACTIVITY_PLAYLIST_LIMIT) break;
  }
  return refs;
}

/**
 * An Apple Music activity with up to 10 of its playlists. References that
 * carry attributes are used as they are; bare ids are read in one request.
 * Rejects when Apple does not return the activity.
 */
export async function loadActivity(
  instance: MusicKit.MusicKitInstance,
  id: string,
): Promise<Activity> {
  const storefront = await resolveStorefront(instance);
  const request = resolveMusicKitMusicRequest(instance);
  const base = `/v1/catalog/${encodeURIComponent(storefront)}`;
  const raw = await request(`${base}/activities/${encodeURIComponent(id)}`, {
    include: "playlists",
  });
  const resource = dataArray(raw).find(
    (entry) => asRecord(entry)?.id === id,
  ) as AppleMusicResource | undefined;
  if (!resource) throw new Error("This activity could not be found.");

  const refs = playlistRefsOf(resource);
  const playlists = new Map<string, Playlist>();
  const bareIds: string[] = [];
  for (const ref of refs) {
    const refId = String(ref.id);
    const playlist = asRecord(ref.attributes)
      ? normalizePlaylistResource(ref as AppleMusicResource)
      : undefined;
    if (playlist) playlists.set(refId, playlist);
    else bareIds.push(refId);
  }
  if (bareIds.length > 0) {
    const lookup = await request(`${base}/playlists`, {
      ids: bareIds.join(","),
    });
    for (const entry of dataArray(lookup)) {
      const playlist = normalizePlaylistResource(entry as AppleMusicResource);
      if (playlist) playlists.set(playlist.id, playlist);
    }
  }

  const attributes = asRecord(resource.attributes) ?? {};
  const name =
    typeof attributes.name === "string" && attributes.name.trim()
      ? attributes.name.trim()
      : "Activity";
  return {
    id,
    name,
    artwork: artworkFromUnknown(attributes.artwork, 300),
    playlists: refs.flatMap((ref) => {
      const playlist = playlists.get(String(ref.id));
      return playlist ? [playlist] : [];
    }),
  };
}
