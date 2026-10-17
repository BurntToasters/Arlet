import type { MusicSource } from "../domain/music.ts";
import type { ResourceLike } from "./LibraryView.tsx";

/** Library or catalog origin, from the raw source or a library type. */
export function resourceSource(
  resource: ResourceLike,
): MusicSource | undefined {
  const raw = resource.raw;
  const attributes =
    raw.attributes && typeof raw.attributes === "object"
      ? (raw.attributes as Record<string, unknown>)
      : undefined;
  const value = raw.source ?? attributes?.source;
  if (value === "library" || value === "catalog") return value;
  const type = resource.type?.toLowerCase();
  return type?.startsWith("library-") ? "library" : undefined;
}

/** Context-menu attributes for a page header or card; its "..." reads them. */
export function detailContext(
  resource: ResourceLike,
  kind: "album" | "artist" | "playlist",
): Record<string, string> {
  return {
    "data-context-kind": kind,
    "data-context-id": resource.id,
    "data-context-title": resource.title,
    "data-context-route-kind": kind,
    ...(resourceSource(resource)
      ? { "data-context-source": resourceSource(resource) as string }
      : {}),
    // The menu's "Copy Apple Music link" reads this; it validates the URL.
    ...(resource.catalogUrl
      ? { "data-context-catalog-url": resource.catalogUrl }
      : {}),
  };
}
