import type {
  Album,
  Artist,
  Artwork as ArtworkData,
  Playlist,
  Track,
} from "../domain/music.ts";
import type { SearchSuggestionOption } from "../components/SearchSuggestions.tsx";
import type { SearchGroupKind, SearchItem } from "../musickit/search.ts";
import { serializeRoute } from "../routing/router.ts";

export function trackContextData(track: Track): Record<string, string> {
  return {
    "data-context-kind": "track",
    "data-context-id": track.id,
    "data-context-title": track.title,
    "data-context-artist": track.artistName,
    ...(track.albumTitle ? { "data-context-album": track.albumTitle } : {}),
    ...(track.artwork?.url
      ? { "data-context-artwork": track.artwork.url }
      : {}),
    ...(track.resourceType
      ? { "data-context-resource-type": track.resourceType }
      : {}),
    ...(track.catalogId ? { "data-context-catalog-id": track.catalogId } : {}),
  };
}

export function itemTrack(item: Album | Artist | Playlist): Track {
  return {
    id: item.id,
    title: "name" in item ? item.name : item.title,
    artistName: "artistName" in item ? item.artistName : "Apple Music",
    artwork: item.artwork,
    resourceType: item.resourceType,
  };
}

/** Search tabs in display order; the panel below follows the active one. */
export const SEARCH_SOURCES = [
  { id: "catalog", label: "Apple Music" },
  { id: "library", label: "Your Library" },
] as const;

export const GROUP_TITLES: Record<SearchGroupKind, string> = {
  songs: "Songs",
  albums: "Albums",
  artists: "Artists",
  playlists: "Playlists",
  stations: "Stations",
  curators: "Curators",
  "record-labels": "Record Labels",
  activities: "Activities",
};

/** Hash link to a record label or activity page; undefined for other results. */
export function overviewHref(item: SearchItem): string | undefined {
  switch (item.kind) {
    case "record-labels":
      return serializeRoute({ kind: "label", id: item.recordLabel.id });
    case "activities":
      return serializeRoute({ kind: "activity", id: item.activity.id });
    default:
      return undefined;
  }
}

/** Waits this long after a keystroke before asking for suggestions. */
export const SUGGESTION_DELAY_MS = 150;
/** Waits this long after a keystroke before the results search runs. */
export const SEARCH_DELAY_MS = 250;

export interface PopupOption extends SearchSuggestionOption {
  run(): void;
}

export function routeContextData(
  kind: "album" | "artist" | "playlist",
  id: string,
  title: string,
): Record<string, string> {
  return {
    "data-context-kind": kind,
    "data-context-id": id,
    "data-context-title": title,
    "data-context-route-kind": kind,
    "data-context-source": "catalog",
  };
}

/** Text, artwork, and context-menu data for a catalog result. */
export function displayFor(item: SearchItem): {
  title: string;
  subtitle: string;
  kindLabel: string;
  artwork?: ArtworkData;
  catalogUrl?: string;
  contextData: Record<string, string>;
} {
  switch (item.kind) {
    case "songs":
      return {
        title: item.track.title,
        subtitle: item.track.artistName,
        kindLabel: "Song",
        artwork: item.track.artwork,
        catalogUrl: item.track.catalogUrl,
        contextData: trackContextData(item.track),
      };
    case "albums":
      return {
        title: item.album.title,
        subtitle: item.album.artistName,
        kindLabel: "Album",
        artwork: item.album.artwork,
        catalogUrl: item.album.catalogUrl,
        contextData: routeContextData("album", item.album.id, item.album.title),
      };
    case "artists":
      return {
        title: item.artist.name,
        subtitle: "Artist",
        kindLabel: "Artist",
        artwork: item.artist.artwork,
        catalogUrl: item.artist.catalogUrl,
        contextData: routeContextData(
          "artist",
          item.artist.id,
          item.artist.name,
        ),
      };
    case "playlists":
      return {
        title: item.playlist.name,
        subtitle: item.playlist.curatorName ?? "Playlist",
        kindLabel: "Playlist",
        artwork: item.playlist.artwork,
        catalogUrl: item.playlist.catalogUrl,
        contextData: routeContextData(
          "playlist",
          item.playlist.id,
          item.playlist.name,
        ),
      };
    case "stations":
      return {
        title: item.station.name,
        subtitle: item.station.isLive ? "Live radio" : "Station",
        kindLabel: "Station",
        artwork: item.station.artwork,
        contextData: {},
      };
    case "curators":
      return {
        title: item.curator.name,
        subtitle: "Curator",
        kindLabel: "Curator",
        artwork: item.curator.artwork,
        contextData: {},
      };
    case "record-labels":
      return {
        title: item.recordLabel.name,
        subtitle: "Record label",
        kindLabel: "Record Label",
        artwork: item.recordLabel.artwork,
        contextData: {},
      };
    case "activities":
      return {
        title: item.activity.name,
        subtitle: "Activity",
        kindLabel: "Activity",
        artwork: item.activity.artwork,
        contextData: {},
      };
  }
}
