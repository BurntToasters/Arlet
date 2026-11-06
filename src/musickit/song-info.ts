import { idSource, type SongInfo, type Track } from "../domain/music.ts";
import { resolveMusicKitMusicRequest, resolveStorefront } from "./catalog.ts";
import { asRecord, dataArray } from "./response.ts";
import { normalizeSongInfo, type AppleMusicResource } from "./normalize.ts";

/** The catalog song ID for a track; a library song uses its catalog twin. */
export function catalogSongIdOf(track: Track): string | undefined {
  return [track.catalogId, track.id].find(
    (id): id is string => id !== undefined && idSource(id) === "catalog",
  );
}

/** The ID of the first related resource in a relationship, or undefined. */
function firstRelatedId(
  resource: AppleMusicResource,
  name: string,
): string | undefined {
  const data = asRecord(asRecord(resource.relationships)?.[name])?.data;
  const first = Array.isArray(data) ? data[0] : data;
  const id = asRecord(first)?.id;
  return typeof id === "string" && id ? id : undefined;
}

/** The resource with `id` in a response, or undefined. */
function resourceWithId(
  raw: unknown,
  id: string,
): AppleMusicResource | undefined {
  return dataArray(raw).find((entry) => asRecord(entry)?.id === id) as
    AppleMusicResource | undefined;
}

/**
 * The album with its record label, or undefined when that request fails. The
 * label and copyright are extras, so their failure must not fail Get Info.
 */
async function loadAlbumWithLabel(
  request: ReturnType<typeof resolveMusicKitMusicRequest>,
  base: string,
  albumId: string,
): Promise<AppleMusicResource | undefined> {
  try {
    return resourceWithId(
      await request(`${base}/albums/${encodeURIComponent(albumId)}`, {
        include: "record-labels",
      }),
      albumId,
    );
  } catch {
    return undefined;
  }
}

/**
 * Get Info for a song. Reads the catalog song with its album, then the album
 * with its record label. Rejects for a library song with no catalog entry, or
 * when Apple does not return the song. A failed album request leaves out only
 * the label and copyright.
 */
export async function loadSongInfo(
  instance: MusicKit.MusicKitInstance,
  track: Track,
): Promise<SongInfo> {
  const songId = catalogSongIdOf(track);
  if (!songId) throw new Error("This song has no Apple Music catalog entry.");
  const storefront = await resolveStorefront(instance);
  const request = resolveMusicKitMusicRequest(instance);
  const base = `/v1/catalog/${encodeURIComponent(storefront)}`;
  const song = resourceWithId(
    await request(`${base}/songs/${encodeURIComponent(songId)}`, {
      include: "albums",
    }),
    songId,
  );
  if (!song) throw new Error("This song could not be found.");
  const albumId = firstRelatedId(song, "albums");
  const album = albumId
    ? await loadAlbumWithLabel(request, base, albumId)
    : undefined;
  const info = normalizeSongInfo(song, album);
  if (!info) throw new Error("This song could not be found.");
  return info;
}
