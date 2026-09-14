import type { Track, Artwork } from "../domain/music.ts";

export function normalizeArtworkUrl(url: string, size: number): string {
  return url.replace("{w}", String(size)).replace("{h}", String(size));
}

export function normalizeArtwork(
  item: MusicKit.MediaItem,
  size = 300,
): Artwork | undefined {
  const artwork = item.artwork;
  if (!artwork?.url) return undefined;
  return {
    url: normalizeArtworkUrl(artwork.url, size),
    width: size,
    height: size,
  };
}

function catalogDurationMs(item: MusicKit.MediaItem): number | undefined {
  const fromAttributes = item.attributes?.durationInMillis;
  if (typeof fromAttributes === "number" && fromAttributes > 0) {
    return fromAttributes;
  }
  if (item.playbackDuration > 0) {
    return item.playbackDuration * 1000;
  }
  return undefined;
}

export function normalizeTrack(item: MusicKit.MediaItem): Track {
  return {
    id: item.id,
    title: item.title || "Unknown Title",
    artistName: item.artistName || "Unknown Artist",
    albumTitle: item.albumName,
    artwork: normalizeArtwork(item),
    durationMs: catalogDurationMs(item),
  };
}

export interface CatalogSongResource {
  id: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    durationInMillis?: number;
    artwork?: { url: string; width: number; height: number };
  };
}

export function normalizeCatalogSong(resource: CatalogSongResource): Track {
  const attributes = resource.attributes ?? {};
  const artworkUrl = attributes.artwork?.url;
  const title = attributes.name?.trim() ?? "";
  const artistName = attributes.artistName?.trim() ?? "";
  return {
    id: resource.id,
    title: title.length > 0 ? title : "Unknown Title",
    artistName: artistName.length > 0 ? artistName : "Unknown Artist",
    albumTitle: attributes.albumName,
    artwork: artworkUrl
      ? {
          url: normalizeArtworkUrl(artworkUrl, 300),
          width: 300,
          height: 300,
        }
      : undefined,
    durationMs:
      typeof attributes.durationInMillis === "number" &&
      attributes.durationInMillis > 0
        ? attributes.durationInMillis
        : undefined,
  };
}
