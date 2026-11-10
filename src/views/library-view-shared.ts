import { reportActionError } from "../components/action-errors.ts";
import type { LibrarySection } from "../routing/router.ts";
import type { ResourceLike } from "./library-view-convert.ts";

export const SECTION_COPY: Record<
  LibrarySection,
  { title: string; eyebrow: string; description: string }
> = {
  recent: {
    title: "Recently Added",
    eyebrow: "Library",
    description: "Albums and songs recently added to your Apple Music library.",
  },
  history: {
    title: "Recently Played",
    eyebrow: "Listening history",
    description:
      "The recent listening history Apple Music makes available to Arlet.",
  },
  artists: {
    title: "Artists",
    eyebrow: "Library",
    description: "Artists represented in your Apple Music library.",
  },
  albums: {
    title: "Albums",
    eyebrow: "Library",
    description: "Albums saved to your Apple Music library.",
  },
  songs: {
    title: "Songs",
    eyebrow: "Library",
    description: "Songs saved to your Apple Music library.",
  },
  playlists: {
    title: "Playlists",
    eyebrow: "Library",
    description: "Your Apple Music playlists and folders.",
  },
};

const updatedFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatUpdated(value: number | string | undefined): string {
  if (value === undefined) return "";
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return `Updated ${updatedFormatter.format(new Date(parsed))}`;
}

export function contextData(
  resource: ResourceLike,
  kind: "track" | "album" | "artist" | "playlist" | "folder",
): Record<string, string> {
  return {
    "data-context-kind": kind,
    "data-context-id": resource.id,
    "data-context-title": resource.title,
    ...(resource.artistName
      ? { "data-context-artist": resource.artistName }
      : {}),
    ...(resource.albumTitle
      ? { "data-context-album": resource.albumTitle }
      : {}),
    ...(resource.artwork?.url
      ? { "data-context-artwork": resource.artwork.url }
      : {}),
    ...(resource.type ? { "data-context-resource-type": resource.type } : {}),
    ...(resource.catalogId
      ? { "data-context-catalog-id": resource.catalogId }
      : {}),
    ...(kind === "album" || kind === "artist" || kind === "playlist"
      ? { "data-context-route-kind": kind }
      : {}),
  };
}

/** Background loads; their views render the error state. */
export function run(action: () => Promise<unknown> | undefined): void {
  void Promise.resolve(action()).catch(() => undefined);
}

/** User actions; failures surface as a toast. */
export function act(action: () => Promise<unknown> | undefined): void {
  void Promise.resolve(action()).catch(reportActionError);
}
