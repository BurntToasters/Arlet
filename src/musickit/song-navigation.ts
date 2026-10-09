import type { MusicEntityRef, MusicSource, Track } from "../domain/music.ts";
import { resolveMusicKitMusicRequest, resolveStorefront } from "./catalog.ts";
import { normalizeTrackNavigation } from "./normalize.ts";

export interface TrackNavigation {
  album?: MusicEntityRef;
  artists: MusicEntityRef[];
}

type NavigationRefs = Pick<Track, "albumRef" | "artistRefs">;

function sourceForTrack(track: Track): MusicSource {
  if (track.resourceType)
    return track.resourceType.startsWith("library-") ? "library" : "catalog";
  if (track.albumRef?.source) return track.albumRef.source;
  return track.artistRefs?.[0]?.source ?? "catalog";
}

function resourcePathForTrack(track: Track): string {
  const type = track.resourceType?.replace(/^library-/u, "");
  return type === "music-videos" ? "music-videos" : "songs";
}

function isComplete(track: Track, refs: NavigationRefs): boolean {
  const albumNameAvailable = Boolean(refs.albumRef?.name ?? track.albumTitle);
  const artists = refs.artistRefs ?? [];
  const artistNamesAvailable = artists.every((artist) =>
    Boolean(
      artist.name ?? (artists.length === 1 ? track.artistName : undefined),
    ),
  );
  return (
    Boolean(refs.albumRef && artists.length > 0) &&
    albumNameAvailable &&
    artistNamesAvailable
  );
}

function navigationFrom(track: Track, refs: NavigationRefs): TrackNavigation {
  const artists = refs.artistRefs ?? [];
  return {
    ...(refs.albumRef
      ? {
          album: {
            ...refs.albumRef,
            name: refs.albumRef.name ?? track.albumTitle,
          },
        }
      : {}),
    artists: artists.map((artist) => ({
      ...artist,
      ...(artist.name
        ? {}
        : artists.length === 1 && track.artistName
          ? { name: track.artistName }
          : {}),
    })),
  };
}

function mergeRefs(
  known: NavigationRefs,
  loaded: NavigationRefs,
): NavigationRefs {
  const loadedArtists = loaded.artistRefs ?? [];
  const knownArtists = known.artistRefs ?? [];
  const mergedArtists = new Map(
    knownArtists.map((artist) => [`${artist.source}:${artist.id}`, artist]),
  );
  for (const artist of loadedArtists) {
    const key = `${artist.source}:${artist.id}`;
    const knownArtist = mergedArtists.get(key);
    mergedArtists.set(key, {
      ...artist,
      ...knownArtist,
      name: knownArtist?.name ?? artist.name,
    });
  }
  const albumRef = known.albumRef
    ? {
        ...loaded.albumRef,
        ...known.albumRef,
        name: known.albumRef.name ?? loaded.albumRef?.name,
      }
    : loaded.albumRef;
  return {
    ...(albumRef ? { albumRef } : {}),
    artistRefs: [...mergedArtists.values()],
  };
}

/** Shares pending song relationship requests for one MusicKit session. */
export function createTrackNavigationResolver(
  requireMusic: () => MusicKit.MusicKitInstance,
): {
  resolve(track: Track): Promise<TrackNavigation>;
  clear(): void;
} {
  const pending = new Map<string, Promise<NavigationRefs>>();
  let storefrontRequest: Promise<string> | undefined;
  let generation = 0;

  const load = async (
    track: Track,
    source: MusicSource,
    storefront: string,
  ): Promise<NavigationRefs> => {
    const prefix =
      source === "catalog"
        ? `/v1/catalog/${encodeURIComponent(storefront)}`
        : "/v1/me/library";
    const resource = resourcePathForTrack(track);
    const raw = await resolveMusicKitMusicRequest(requireMusic())(
      `${prefix}/${resource}/${encodeURIComponent(track.id)}`,
      { include: "albums,artists" },
    );
    return normalizeTrackNavigation(raw);
  };

  return {
    async resolve(track): Promise<TrackNavigation> {
      const requestGeneration = generation;
      const known = normalizeTrackNavigation(track);
      if (!track.id || isComplete(track, known)) {
        return navigationFrom(track, known);
      }

      const source = sourceForTrack(track);
      const instance = requireMusic();
      if (!storefrontRequest) {
        let storefrontLookup: Promise<string>;
        storefrontLookup = resolveStorefront(instance).catch(
          (error: unknown) => {
            if (storefrontRequest === storefrontLookup)
              storefrontRequest = undefined;
            throw error;
          },
        );
        storefrontRequest = storefrontLookup;
      }
      const storefront = await storefrontRequest;
      if (requestGeneration !== generation) return { artists: [] };
      const key = `${source}|${storefront}|${resourcePathForTrack(track)}|${track.id}`;
      let request = pending.get(key);
      if (!request) {
        request = load(track, source, storefront);
        pending.set(key, request);
        void request.catch(() => {
          if (pending.get(key) === request) pending.delete(key);
        });
      }
      const loaded = await request;
      if (requestGeneration !== generation) return { artists: [] };
      return navigationFrom(track, mergeRefs(known, loaded));
    },
    clear(): void {
      generation += 1;
      pending.clear();
      storefrontRequest = undefined;
    },
  };
}
