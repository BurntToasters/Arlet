import { ratingKeyOf, type RatingTarget } from "../app/ratings.ts";
import type { LibrarySection } from "../routing/router.ts";
import type { RuntimeAppState } from "../state.ts";
import {
  matchesContent,
  matchesText,
  sortItems,
  type LibraryViewOptions,
} from "../library/view-options.ts";
import type { ResourceLike } from "./library-view-convert.ts";

export function ratingTargetOf(
  resource: ResourceLike,
  section: LibrarySection,
): RatingTarget {
  return { type: resource.type ?? `library-${section}`, id: resource.id };
}

export function ratingKeyFor(
  resource: ResourceLike,
  section: LibrarySection,
): string | undefined {
  return ratingKeyOf(ratingTargetOf(resource, section));
}

/**
 * Items that pass the text, content and favorites controls, in sort order.
 * Folders pass through; PlaylistTree hides the ones with nothing to show.
 */
export function arrangeResources(
  resources: readonly ResourceLike[],
  section: LibrarySection,
  options: LibraryViewOptions,
  text: string,
  ratings: RuntimeAppState["ratings"],
): ResourceLike[] {
  // Unknown ratings count as not favorite; the view waits for them first.
  const isFavorite = (resource: ResourceLike): boolean => {
    const key = ratingKeyFor(resource, section);
    return key !== undefined && ratings[key] === 1;
  };
  const folders = resources.filter((resource) => resource.isFolder);
  const items = resources.filter(
    (resource) =>
      !resource.isFolder &&
      matchesText(resource, text) &&
      matchesContent(resource, options.content) &&
      (!options.favorites || isFavorite(resource)),
  );
  return [...folders, ...sortItems(items, options.sort)];
}
