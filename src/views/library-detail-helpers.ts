import { Disc3, ListMusic, UserRound } from "lucide-preact";
import type { LucideIcon } from "lucide-preact";
import { reportActionError } from "../components/action-errors.ts";
import { readDetail, toResource, type ResourceLike } from "./LibraryView.tsx";

export type DetailKind = "album" | "artist" | "playlist";
export type DetailSource = "library" | "catalog";

/** Background loads; their views render the error state. */
export function run(action: () => Promise<unknown> | undefined): void {
  void Promise.resolve(action()).catch(() => undefined);
}

/** User actions; failures surface as a toast. */
export function act(action: () => Promise<unknown> | undefined): void {
  void Promise.resolve(action()).catch(reportActionError);
}

export function callLoader(
  loader:
    | ((
        id: string,
        source?: DetailSource,
        options?: { refresh?: boolean },
      ) => Promise<unknown>)
    | undefined,
  id: string,
  source?: DetailSource,
  options?: { refresh?: boolean },
): void {
  if (loader) run(() => loader(id, source, options));
}

export function findResource(
  items: readonly unknown[],
  id: string,
): ResourceLike | undefined {
  // Converts until the match instead of the whole collection.
  for (const item of items) {
    const resource = toResource(item);
    if (resource?.id === id) return resource;
  }
  return undefined;
}

export function detailResource(
  detail: Pick<ReturnType<typeof readDetail>, "resource" | "item">,
  fallback: ResourceLike | undefined,
): ResourceLike | undefined {
  return toResource(detail.resource) ?? toResource(detail.item) ?? fallback;
}

export function detailItems(
  detail: Pick<ReturnType<typeof readDetail>, "tracks" | "albums" | "items">,
  resource: ResourceLike | undefined,
): ResourceLike[] {
  const source =
    detail.tracks ??
    detail.albums ??
    detail.items ??
    resource?.tracks ??
    resource?.albums ??
    [];
  return source
    .map(toResource)
    .filter((item): item is ResourceLike => Boolean(item));
}

export function detailCopy(kind: DetailKind): {
  eyebrow: string;
  fallback: string;
  icon: LucideIcon;
} {
  switch (kind) {
    case "artist":
      return { eyebrow: "Artist", fallback: "Artist", icon: UserRound };
    case "playlist":
      return { eyebrow: "Playlist", fallback: "Playlist", icon: ListMusic };
    case "album":
      return { eyebrow: "Album", fallback: "Album", icon: Disc3 };
  }
}
