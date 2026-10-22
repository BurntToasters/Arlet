import type { LibrarySection } from "../routing/router.ts";

export type LibrarySort =
  "default" | "title-asc" | "title-desc" | "added-desc" | "added-asc";

export type LibraryContentFilter = "all" | "explicit" | "clean";

export interface LibraryViewOptions {
  sort: LibrarySort;
  favorites: boolean;
  content: LibraryContentFilter;
}

export interface LibraryViewCapabilities {
  sorts: readonly LibrarySort[];
  favorites: boolean;
  content: boolean;
}

const TITLE_SORTS: readonly LibrarySort[] = [
  "default",
  "title-asc",
  "title-desc",
];
const ALL_SORTS: readonly LibrarySort[] = [
  "default",
  "title-asc",
  "title-desc",
  "added-desc",
  "added-asc",
];
const CONTENT_FILTERS: readonly LibraryContentFilter[] = [
  "all",
  "explicit",
  "clean",
];

/** Sections without a toolbar (recent, history) have no entry. */
const CAPABILITIES: Partial<Record<LibrarySection, LibraryViewCapabilities>> = {
  artists: { sorts: TITLE_SORTS, favorites: false, content: false },
  albums: { sorts: ALL_SORTS, favorites: true, content: true },
  songs: { sorts: ALL_SORTS, favorites: true, content: true },
  playlists: { sorts: ALL_SORTS, favorites: true, content: false },
};

export const defaultViewOptions: Readonly<LibraryViewOptions> = {
  sort: "default",
  favorites: false,
  content: "all",
};

export const LIBRARY_VIEW_STORAGE_KEY = "arlet.library.view.v1";

export function libraryViewCapabilities(
  section: LibrarySection,
): LibraryViewCapabilities | undefined {
  return CAPABILITIES[section];
}

/** True when any control differs from its default, so the list is narrowed or reordered. */
export function isActive(options: LibraryViewOptions, text: string): boolean {
  return (
    options.sort !== "default" ||
    options.favorites ||
    options.content !== "all" ||
    text.trim().length > 0
  );
}

function viewStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // Blocked site data makes the accessor throw; choices then last the session.
    return undefined;
  }
}

/** Every saved section; anything malformed is treated as nothing saved. */
function readSavedViews(): Record<string, unknown> {
  try {
    const raw = viewStorage()?.getItem(LIBRARY_VIEW_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Unknown values and options the section does not offer fall back to defaults. */
function normalizeOptions(
  value: unknown,
  capabilities: LibraryViewCapabilities,
): LibraryViewOptions {
  const saved =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const sort =
    capabilities.sorts.find((candidate) => candidate === saved.sort) ??
    defaultViewOptions.sort;
  const content =
    CONTENT_FILTERS.find((candidate) => candidate === saved.content) ??
    defaultViewOptions.content;
  return {
    sort,
    favorites: capabilities.favorites && saved.favorites === true,
    content: capabilities.content ? content : defaultViewOptions.content,
  };
}

export function loadViewOptions(section: LibrarySection): LibraryViewOptions {
  const capabilities = libraryViewCapabilities(section);
  if (!capabilities) return { ...defaultViewOptions };
  return normalizeOptions(readSavedViews()[section], capabilities);
}

/** Saves one section; other sections are kept as they were stored. */
export function saveViewOptions(
  section: LibrarySection,
  options: LibraryViewOptions,
): void {
  const capabilities = libraryViewCapabilities(section);
  if (!capabilities) return;
  try {
    const storage = viewStorage();
    if (!storage) return;
    const views = readSavedViews();
    views[section] = normalizeOptions(options, capabilities);
    storage.setItem(LIBRARY_VIEW_STORAGE_KEY, JSON.stringify(views));
  } catch {
    // A failed write only loses the choice across restarts.
  }
}

/** One collator for every title comparison, so sorts and matches agree. */
const collator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

export interface SortableItem {
  title: string;
  dateAdded?: string;
}

function addedTime(item: SortableItem): number | undefined {
  const time = Date.parse(item.dateAdded ?? "");
  return Number.isFinite(time) ? time : undefined;
}

function compareAdded(
  left: SortableItem,
  right: SortableItem,
  direction: 1 | -1,
): number {
  const leftTime = addedTime(left);
  const rightTime = addedTime(right);
  if (leftTime === undefined || rightTime === undefined) {
    // Undated items go last in both directions.
    if (leftTime === rightTime) return 0;
    return leftTime === undefined ? 1 : -1;
  }
  return direction * (leftTime - rightTime);
}

export function compareItems(
  left: SortableItem,
  right: SortableItem,
  sort: LibrarySort,
): number {
  switch (sort) {
    case "title-asc":
      return collator.compare(left.title, right.title);
    case "title-desc":
      return collator.compare(right.title, left.title);
    case "added-desc":
      return compareAdded(left, right, -1);
    case "added-asc":
      return compareAdded(left, right, 1);
    default:
      return 0;
  }
}

/** Returns a new array. Items that compare equal keep their original order. */
export function sortItems<T extends SortableItem>(
  items: readonly T[],
  sort: LibrarySort,
): T[] {
  if (sort === "default") return [...items];
  return [...items].sort((left, right) => compareItems(left, right, sort));
}

/** Lowercase, with accents removed, so "Beyonce" matches "Beyoncé". */
export function foldText(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

export interface SearchableItem {
  title: string;
  artistName?: string;
  albumTitle?: string;
}

/** An empty query matches everything. */
export function matchesText(item: SearchableItem, text: string): boolean {
  const query = foldText(text.trim());
  if (!query) return true;
  return [item.title, item.artistName, item.albumTitle].some(
    (value) => value !== undefined && foldText(value).includes(query),
  );
}

export function matchesContent(
  item: { explicit?: boolean },
  content: LibraryContentFilter,
): boolean {
  if (content === "all") return true;
  const explicit = item.explicit === true;
  return content === "explicit" ? explicit : !explicit;
}
