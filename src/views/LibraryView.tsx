import {
  AlertCircle,
  Album as AlbumIcon,
  ChevronDown,
  ChevronRight,
  Disc3,
  Folder,
  History as HistoryIcon,
  ListMusic,
  Music2,
  RefreshCw,
  SearchX,
  UserRound,
} from "lucide-preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  useAppController,
  useAppRouter,
  useAppSelector,
  useAppSlices,
} from "../app/context.tsx";
import { nearestTrackIndex } from "../app/queue-window.ts";
import {
  ratingKeyOf,
  requestRatings,
  type RatingTarget,
} from "../app/ratings.ts";
import type { RuntimeAppState } from "../state.ts";
import { Artwork } from "../components/Artwork.tsx";
import { LibraryToolbar } from "../components/LibraryToolbar.tsx";
import { SongRow } from "../components/SongRow.tsx";
import { CardActions, CardShell } from "../components/CardActions.tsx";
import { EmptyState } from "./EmptyState.tsx";
import {
  isActive,
  libraryViewCapabilities,
  loadViewOptions,
  matchesContent,
  matchesText,
  saveViewOptions,
  sortItems,
  type LibrarySort,
  type LibraryViewOptions,
} from "../library/view-options.ts";
import type { Track } from "../domain/music.ts";
import { normalizeTrackNavigation } from "../musickit/normalize.ts";
import type { LibrarySection } from "../routing/router.ts";
import { reportActionError } from "../components/action-errors.ts";
import { OfflineBanner } from "../components/OfflineBanner.tsx";
import { VirtualGrid } from "../components/VirtualGrid.tsx";
import { VirtualList } from "../components/VirtualList.tsx";
import {
  SkeletonCardGrid,
  SkeletonRows,
  SkeletonStatus,
} from "../components/Skeleton.tsx";

export interface ResourceLike {
  id: string;
  type?: string;
  kind?: string;
  title: string;
  artistName?: string;
  artistId?: string;
  albumTitle?: string;
  albumId?: string;
  albumRef?: Track["albumRef"];
  artistRefs?: Track["artistRefs"];
  artwork?: Track["artwork"];
  durationMs?: number;
  explicit?: boolean;
  catalogUrl?: string;
  /** Track's position on its disc, from Apple. */
  trackNumber?: number;
  catalogId?: string;
  /** Albums: `YYYY-MM-DD` (or `YYYY`) from Apple. */
  releaseDate?: string;
  /** When the item joined the library, as an ISO time. */
  dateAdded?: string;
  playable?: boolean;
  addable?: boolean;
  parentId?: string;
  isFolder?: boolean;
  tracks?: unknown[];
  albums?: unknown[];
  children?: unknown[];
  raw: Record<string, unknown>;
}

export interface CollectionLike {
  items: unknown[];
  status: string;
  next?: string | null;
  error?: string;
  source?: string;
  lastUpdatedAt?: number | string;
  stale?: boolean;
  isStale?: boolean;
}

interface DetailLike extends CollectionLike {
  item?: unknown;
  resource?: unknown;
  tracks?: unknown[];
  albums?: unknown[];
}

interface LibraryModelLike {
  collections?: Record<string, unknown>;
  details?: object;
  [key: string]: unknown;
}

const SECTION_COPY: Record<
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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
}

function numberValue(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
}

/** A 1-based track position from Apple; anything else is unknown. */
function positionValue(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number =>
      typeof value === "number" && Number.isInteger(value) && value > 0,
  );
}

function artworkValue(value: unknown): Track["artwork"] | undefined {
  const artwork = objectValue(value);
  if (!artwork) return undefined;
  const url = stringValue(artwork.url, artwork.href);
  if (!url) return undefined;
  const widths = Array.isArray(artwork.widths) ? artwork.widths[0] : undefined;
  const heights = Array.isArray(artwork.heights)
    ? artwork.heights[0]
    : undefined;
  return {
    url,
    width: numberValue(artwork.width, widths) ?? 300,
    height: numberValue(artwork.height, heights) ?? 300,
  };
}

/**
 * Converted items, keyed on the stored object. The store keeps earlier items
 * by identity, so a page append converts only its own items. `null` marks an
 * item that does not convert.
 */
const resourceCache = new WeakMap<object, ResourceLike | null>();
const trackCache = new WeakMap<object, Track | null>();

export function toResource(value: unknown): ResourceLike | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cached = resourceCache.get(value);
  if (cached !== undefined) return cached ?? undefined;
  const resource = convertResource(value);
  resourceCache.set(value, resource ?? null);
  return resource;
}

function convertResource(value: unknown): ResourceLike | undefined {
  const raw = objectValue(value);
  if (!raw) return undefined;
  const attributes = objectValue(raw.attributes) ?? raw;
  const id = stringValue(raw.id, attributes.id);
  if (!id) return undefined;
  const type = stringValue(
    raw.type,
    raw.resourceType,
    attributes.type,
    attributes.resourceType,
  );
  const kind = stringValue(raw.kind, attributes.kind, type);
  const title = stringValue(
    raw.title,
    raw.name,
    attributes.title,
    attributes.name,
    "Untitled",
  ) as string;
  const artist = objectValue(raw.artist) ?? objectValue(attributes.artist);
  const album = objectValue(raw.album) ?? objectValue(attributes.album);
  const artwork =
    artworkValue(raw.artwork) ??
    artworkValue(attributes.artwork) ??
    artworkValue(raw.artworkUrl) ??
    artworkValue(attributes.artworkUrl);
  const trackCollection =
    raw.tracks ?? attributes.tracks ?? objectValue(raw.relationships)?.tracks;
  const albumCollection = raw.albums ?? attributes.albums;
  const children = raw.children ?? attributes.children;
  const folder =
    raw.isFolder === true ||
    attributes.isFolder === true ||
    type?.toLowerCase().includes("folder") === true ||
    kind?.toLowerCase().includes("folder") === true;
  return {
    id,
    type,
    kind,
    title,
    ...normalizeTrackNavigation(raw),
    artistName: stringValue(
      raw.artistName,
      attributes.artistName,
      artist?.name,
      artist?.title,
    ),
    artistId: stringValue(raw.artistId, attributes.artistId, artist?.id),
    albumTitle: stringValue(
      raw.albumTitle,
      attributes.albumTitle,
      album?.name,
      album?.title,
    ),
    albumId: stringValue(raw.albumId, attributes.albumId, album?.id),
    artwork,
    durationMs: numberValue(
      raw.durationMs,
      attributes.durationInMillis,
      attributes.durationMs,
    ),
    explicit:
      typeof raw.explicit === "boolean"
        ? raw.explicit
        : typeof attributes.contentRating === "string"
          ? attributes.contentRating.toLowerCase() === "explicit"
          : undefined,
    // `href` is an API path (/v1/...), not a page link.
    catalogUrl: stringValue(raw.catalogUrl, attributes.url),
    trackNumber: positionValue(raw.trackNumber, attributes.trackNumber),
    catalogId: stringValue(raw.catalogId, attributes.catalogId),
    releaseDate: stringValue(raw.releaseDate, attributes.releaseDate),
    dateAdded: stringValue(raw.dateAdded, attributes.dateAdded),
    playable: typeof raw.playable === "boolean" ? raw.playable : undefined,
    addable: typeof raw.addable === "boolean" ? raw.addable : undefined,
    parentId: stringValue(
      raw.parentId,
      attributes.parentId,
      raw.folderId,
      attributes.folderId,
    ),
    isFolder: folder,
    tracks: Array.isArray(trackCollection) ? trackCollection : undefined,
    albums: Array.isArray(albumCollection) ? albumCollection : undefined,
    children: Array.isArray(children) ? children : undefined,
    raw,
  };
}

/** One Track per item, so rows that memoize on it keep their identity. */
export function toTrack(value: unknown): Track | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cached = trackCache.get(value);
  if (cached !== undefined) return cached ?? undefined;
  const track = trackFromResource(toResource(value));
  trackCache.set(value, track ?? null);
  return track;
}

function trackFromResource(
  resource: ResourceLike | undefined,
): Track | undefined {
  if (!resource) return undefined;
  return {
    id: resource.id,
    title: resource.title,
    artistName: resource.artistName ?? "Unknown artist",
    albumTitle: resource.albumTitle,
    albumRef: resource.albumRef,
    artistRefs: resource.artistRefs,
    artwork: resource.artwork,
    durationMs: resource.durationMs,
    explicit: resource.explicit,
    catalogUrl: resource.catalogUrl,
    trackNumber: resource.trackNumber,
    resourceType: resource.type,
    catalogId: resource.catalogId,
    playable: resource.playable,
    addable: resource.addable,
  };
}

function readLibrary(
  state: Pick<RuntimeAppState, "library">,
): LibraryModelLike {
  return { ...state.library };
}

export function readCollection(
  state: Pick<RuntimeAppState, "library">,
  section: LibrarySection,
): CollectionLike {
  const library = readLibrary(state);
  const collections = objectValue(library.collections) ?? library;
  const value = objectValue(collections[section]);
  if (!value) return { items: [], status: "idle" };
  const items = Array.isArray(value.items)
    ? value.items
    : Array.isArray(value.results)
      ? value.results
      : [];
  return {
    items,
    status: stringValue(value.status) ?? (items.length ? "success" : "idle"),
    next: typeof value.next === "string" ? value.next : null,
    error: stringValue(value.error, objectValue(value.error)?.message),
    source: stringValue(value.source),
    lastUpdatedAt: value.lastUpdatedAt as number | string | undefined,
    stale: value.stale === true,
    isStale: value.isStale === true,
  };
}

export function readDetail(
  state: Pick<RuntimeAppState, "library">,
  kind: "album" | "artist" | "playlist",
  id: string,
): DetailLike {
  const library = readLibrary(state);
  const details = objectValue(library.details);
  const byKind = objectValue(details?.[kind]);
  const value = objectValue(byKind?.[id]) ?? objectValue(details?.[id]);
  if (!value) return { items: [], status: "idle" };
  const items = Array.isArray(value.items)
    ? value.items
    : Array.isArray(value.tracks)
      ? value.tracks
      : [];
  return {
    items,
    status: stringValue(value.status) ?? (items.length ? "success" : "idle"),
    next: typeof value.next === "string" ? value.next : null,
    error: stringValue(value.error, objectValue(value.error)?.message),
    source: stringValue(value.source),
    lastUpdatedAt: value.lastUpdatedAt as number | string | undefined,
    stale: value.stale === true,
    isStale: value.isStale === true,
    resource: value.resource,
    item: value.item,
    tracks: Array.isArray(value.tracks) ? value.tracks : undefined,
    albums: Array.isArray(value.albums) ? value.albums : undefined,
  };
}

/** Shared empty list, so memos keyed on it do not rerun every render. */
const NO_ITEMS: readonly unknown[] = [];

function readPlaylistFolderItems(
  state: Pick<RuntimeAppState, "library">,
): readonly unknown[] {
  const library = readLibrary(state);
  const details = objectValue(library.details);
  const folder = objectValue(details?.playlistFolder);
  return Array.isArray(folder?.items) ? folder.items : NO_ITEMS;
}

const updatedFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatUpdated(value: number | string | undefined): string {
  if (value === undefined) return "";
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return `Updated ${updatedFormatter.format(new Date(parsed))}`;
}

function contextData(
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
function run(action: () => Promise<unknown> | undefined): void {
  void Promise.resolve(action()).catch(() => undefined);
}

/** User actions; failures surface as a toast. */
function act(action: () => Promise<unknown> | undefined): void {
  void Promise.resolve(action()).catch(reportActionError);
}

interface LibraryViewState {
  options: LibraryViewOptions;
  text: string;
}

function initialViewState(section: LibrarySection): LibraryViewState {
  return { options: loadViewOptions(section), text: "" };
}

function ratingTargetOf(
  resource: ResourceLike,
  section: LibrarySection,
): RatingTarget {
  return { type: resource.type ?? `library-${section}`, id: resource.id };
}

function ratingKeyFor(
  resource: ResourceLike,
  section: LibrarySection,
): string | undefined {
  return ratingKeyOf(ratingTargetOf(resource, section));
}

/**
 * Items that pass the text, content and favorites controls, in sort order.
 * Folders pass through; PlaylistTree hides the ones with nothing to show.
 */
function arrangeResources(
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

export function LibraryTrackRow({
  resource,
  index,
  onPlay,
  onPlayNext,
  disabled,
  contextData: collectionContext,
  discTrackNumbers,
}: {
  resource: ResourceLike;
  index: number;
  onPlay: (track: Track, index: number) => void;
  onPlayNext?: (track: Track) => void;
  disabled: boolean;
  contextData?: Record<string, string>;
  /** Shows the track's position on its disc; see SongRow. */
  discTrackNumbers?: boolean;
}): JSX.Element {
  const appController = useAppController();
  const track = toTrack(resource);
  if (!track) return <li />;
  const playNext =
    onPlayNext ??
    ((value: Track) => {
      act(() => appController.playNextTracks([value]));
    });
  return (
    <SongRow
      track={track}
      index={index}
      onPlay={() => onPlay(track, index)}
      onPlayNext={() => playNext(track)}
      disabled={disabled}
      rowClassName="library-track-row"
      numberClassName="library-row-number"
      copyClassName="library-row-copy"
      durationClassName="library-row-duration"
      contextData={{ ...contextData(resource, "track"), ...collectionContext }}
      discTrackNumbers={discTrackNumbers}
    />
  );
}

function ResourceCard({
  resource,
  kind,
  onOpen,
}: {
  resource: ResourceLike;
  kind: "album" | "artist" | "playlist";
  onOpen: () => void;
}): JSX.Element {
  const appController = useAppController();
  const Icon =
    kind === "album" ? AlbumIcon : kind === "artist" ? UserRound : ListMusic;
  const trackLike = toTrack(resource);
  // Artists have no collection playback, so only albums and playlists get Play.
  const collectionKind = kind === "artist" ? undefined : kind;
  return (
    <CardShell
      contextData={contextData(resource, kind)}
      catalogUrl={resource.catalogUrl}
    >
      <button className="library-card" type="button" onClick={onOpen}>
        {kind === "artist" && !resource.artwork ? (
          <span
            className="library-card-art library-card-art-icon"
            aria-hidden="true"
          >
            <Icon size={27} strokeWidth={1.5} />
          </span>
        ) : (
          <Artwork
            track={trackLike}
            size="lg"
            alt={`${resource.title} artwork`}
            className="library-card-art"
          />
        )}
        <span className="library-card-copy">
          <strong title={resource.title}>{resource.title}</strong>
          <small title={resource.artistName}>
            {resource.artistName ?? kind}
          </small>
        </span>
      </button>
      <CardActions
        title={resource.title}
        onPlay={
          collectionKind && resource.playable !== false
            ? () =>
                act(() =>
                  appController.playCollection(
                    collectionKind,
                    resource.id,
                    "library",
                    0,
                  ),
                )
            : undefined
        }
      />
    </CardShell>
  );
}

function PlaylistTree({
  resources,
  router,
  sort,
  filtered,
}: {
  resources: ResourceLike[];
  router: ReturnType<typeof useAppRouter>;
  sort: LibrarySort;
  /** A text or favorites filter is on, so folders with no match are hidden. */
  filtered: boolean;
}): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const folders = resources.filter((resource) => resource.isFolder);
  const playlists = resources.filter((resource) => !resource.isFolder);
  const childrenOf = (parentId?: string): ResourceLike[] =>
    resources.filter((resource) => resource.parentId === parentId);
  // Folders sort by title only for title sorts; otherwise they keep their order.
  const orderFolders = (list: ResourceLike[]): ResourceLike[] =>
    sort === "title-asc" || sort === "title-desc"
      ? sortItems(list, sort)
      : list;
  // Only matching playlists are in `resources`, so a folder shows when one sits below it.
  const hasShownContent = (folder: ResourceLike): boolean =>
    childrenOf(folder.id).some(
      (child) => !child.isFolder || hasShownContent(child),
    );
  const shownFolders = (list: ResourceLike[]): ResourceLike[] =>
    orderFolders(filtered ? list.filter(hasShownContent) : list);
  const renderPlaylist = (playlist: ResourceLike): JSX.Element => (
    <ResourceCard
      key={playlist.id}
      resource={playlist}
      kind="playlist"
      onOpen={() => router.navigate({ kind: "playlist", id: playlist.id })}
    />
  );
  const renderFolder = (folder: ResourceLike, depth = 0): JSX.Element => {
    const isOpen = open[folder.id] ?? true;
    const nestedPlaylists = childrenOf(folder.id).filter(
      (child) => !child.isFolder,
    );
    const nestedFolders = shownFolders(
      childrenOf(folder.id).filter((child) => child.isFolder),
    );
    return (
      <div
        className="playlist-folder"
        key={folder.id}
        style={{ "--folder-depth": depth }}
      >
        <button
          className="playlist-folder-heading"
          type="button"
          aria-expanded={isOpen}
          {...contextData(folder, "folder")}
          onClick={() =>
            setOpen((current) => ({ ...current, [folder.id]: !isOpen }))
          }
        >
          {isOpen ? (
            <ChevronDown size={16} aria-hidden="true" />
          ) : (
            <ChevronRight size={16} aria-hidden="true" />
          )}
          <Folder size={16} aria-hidden="true" />
          <span>{folder.title}</span>
        </button>
        {isOpen ? (
          <div className="library-card-grid playlist-folder-content">
            {nestedFolders.map((child) => renderFolder(child, depth + 1))}
            {nestedPlaylists.map(renderPlaylist)}
          </div>
        ) : null}
      </div>
    );
  };
  const rootFolders = shownFolders(
    folders.filter(
      (folder) =>
        !folder.parentId ||
        !folders.some((candidate) => candidate.id === folder.parentId),
    ),
  );
  const rootPlaylists = playlists.filter(
    (playlist) =>
      !playlist.parentId ||
      !folders.some((folder) => folder.id === playlist.parentId),
  );
  return (
    <div className="playlist-tree">
      {rootFolders.map((folder) => renderFolder(folder))}
      {rootPlaylists.length ? (
        <div className="library-card-grid">
          {rootPlaylists.map(renderPlaylist)}
        </div>
      ) : null}
    </div>
  );
}

function CollectionFeedback({
  collection,
  section,
  onRetry,
}: {
  collection: CollectionLike;
  section: LibrarySection;
  onRetry: () => void;
}): JSX.Element | null {
  if (collection.status === "loading" && collection.items.length === 0) {
    const label = `Loading ${SECTION_COPY[section].title}…`;
    if (section === "recent") {
      return (
        <SkeletonStatus label={label}>
          <SkeletonRows count={5} />
          <SkeletonCardGrid count={4} />
        </SkeletonStatus>
      );
    }
    if (
      section === "artists" ||
      section === "albums" ||
      section === "playlists"
    ) {
      return (
        <SkeletonStatus label={label}>
          <SkeletonCardGrid count={8} />
        </SkeletonStatus>
      );
    }
    return (
      <SkeletonStatus label={label}>
        <SkeletonRows count={8} />
      </SkeletonStatus>
    );
  }
  if (collection.error && collection.items.length === 0) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Library could not be loaded"
        description={collection.error}
        action={
          <button className="secondary-button" type="button" onClick={onRetry}>
            Try again
          </button>
        }
      />
    );
  }
  if (collection.status !== "loading" && collection.items.length === 0) {
    const Icon =
      section === "history"
        ? HistoryIcon
        : section === "artists"
          ? UserRound
          : section === "albums"
            ? Disc3
            : section === "playlists"
              ? ListMusic
              : Music2;
    return (
      <EmptyState
        icon={Icon}
        title={
          section === "history"
            ? "No recent listening yet"
            : "Your library is empty"
        }
        description={SECTION_COPY[section].description}
        compact
      />
    );
  }
  return null;
}

export function LibraryView({
  section,
}: {
  section: LibrarySection;
}): JSX.Element {
  const state = useAppSlices("auth", "initialization", "library");
  const controller = useAppController();
  const router = useAppRouter();
  const loadMoreTrigger = useRef<HTMLButtonElement>(null);
  // Toolbar state per section, for this session. Sections that have no
  // toolbar read the defaults.
  const [viewStates, setViewStates] = useState<
    Partial<Record<LibrarySection, LibraryViewState>>
  >({});
  const ratings = useAppSelector((store) => store.ratings);
  const copy = SECTION_COPY[section];
  const capabilities = libraryViewCapabilities(section);
  const view = useMemo(
    () => viewStates[section] ?? initialViewState(section),
    [viewStates, section],
  );
  const { options, text } = view;
  const collection = readCollection(state, section);
  const authorized =
    state.auth.status === "authorized" &&
    state.initialization.status === "ready";
  const offline = state.library.offline;
  const canView = authorized || offline;
  const canAutoLoad = authorized && !offline;
  const folderItems =
    section === "playlists" ? readPlaylistFolderItems(state) : NO_ITEMS;
  // Rebuilt only when the stored items change; converted items are cached,
  // so an appended page converts just its own rows.
  const resources = useMemo(() => {
    const items = [...folderItems, ...collection.items]
      .map(toResource)
      .filter((resource): resource is ResourceLike => Boolean(resource));
    const seen = new Set<string>();
    return items.filter((resource) => {
      if (seen.has(resource.id)) return false;
      seen.add(resource.id);
      return true;
    });
  }, [collection.items, folderItems]);
  const controlsActive = capabilities !== undefined && isActive(options, text);
  const favoritesOn = controlsActive && options.favorites;
  // The list in the order and subset the controls show. With no control
  // active, it is the stored order, as before the toolbar.
  const visibleResources = useMemo(
    () =>
      controlsActive
        ? arrangeResources(resources, section, options, text, ratings)
        : resources,
    [controlsActive, resources, section, options, text, ratings],
  );
  const visibleCount = visibleResources.filter(
    (resource) => !resource.isFolder,
  ).length;
  const totalCount = resources.filter((resource) => !resource.isFolder).length;
  const favoritesPending =
    favoritesOn &&
    canAutoLoad &&
    resources.some((resource) => {
      const key = resource.isFolder
        ? undefined
        : ratingKeyFor(resource, section);
      return key !== undefined && ratings[key] === undefined;
    });
  const loadingAll =
    controlsActive &&
    canAutoLoad &&
    Boolean(collection.next) &&
    collection.status === "loading";
  const noMatches =
    controlsActive &&
    totalCount > 0 &&
    visibleCount === 0 &&
    !loadingAll &&
    !favoritesPending;
  const status = loadingAll
    ? `Loading full library… ${collection.items.length} loaded`
    : favoritesPending
      ? "Checking favorites…"
      : undefined;

  const { recentCards, trackResources } = useMemo(() => {
    if (section !== "recent") {
      return {
        recentCards: [] as ResourceLike[],
        trackResources: visibleResources,
      };
    }
    const cards = visibleResources.filter((resource) =>
      ["album", "artist", "playlist"].some((kind) =>
        resource.type?.includes(kind),
      ),
    );
    const cardSet = new Set(cards);
    return {
      recentCards: cards,
      trackResources: visibleResources.filter(
        (resource) => !cardSet.has(resource),
      ),
    };
  }, [visibleResources, section]);

  useEffect(() => {
    if (!canView) return;
    run(() => controller.loadLibrarySection(section));
    if (section === "playlists") {
      run(() => controller.loadPlaylistFolder());
    }
  }, [canView, controller, section]);

  useEffect(() => {
    // Filters and sorts need every page. After an error the loading stops, and
    // Load more or Refresh retries.
    if (
      !controlsActive ||
      !canAutoLoad ||
      !collection.next ||
      collection.status === "loading" ||
      collection.error
    ) {
      return;
    }
    run(() => controller.loadAllLibrarySection(section));
  }, [
    controlsActive,
    canAutoLoad,
    collection.next,
    collection.status,
    collection.error,
    controller,
    section,
  ]);

  useEffect(() => {
    if (!favoritesOn || !canAutoLoad) return;
    const targets = resources
      .filter((resource) => !resource.isFolder)
      .map((resource) => ratingTargetOf(resource, section));
    if (targets.length) run(() => requestRatings(targets));
  }, [favoritesOn, canAutoLoad, resources, section]);

  const patchView = (patch: Partial<LibraryViewState>): void => {
    setViewStates((current) => ({
      ...current,
      [section]: {
        ...(current[section] ?? initialViewState(section)),
        ...patch,
      },
    }));
  };
  // Options are saved here; text is session-only.
  const changeOptions = (next: LibraryViewOptions): void => {
    saveViewOptions(section, next);
    patchView({ options: next });
  };
  // Clears text, favorites and content. The sort stays.
  const clearFilters = (): void => {
    changeOptions({ ...options, favorites: false, content: "all" });
    patchView({ text: "" });
  };

  const retry = (): void => {
    run(() => controller.refreshLibrarySection(section));
  };
  const loadMore = (): void => {
    if (collection.next) {
      run(() =>
        controller.loadMoreLibrarySection(
          section,
          collection.next ?? undefined,
        ),
      );
    }
  };
  // The observer is rebuilt only when the list state changes; it calls the
  // latest loadMore, which is recreated on every render.
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  useEffect(() => {
    const target = loadMoreTrigger.current;
    if (
      !target ||
      !authorized ||
      // Load more is hidden while a control is active; every page loads anyway.
      controlsActive ||
      !collection.next ||
      collection.status === "loading" ||
      // After a failed page load the trigger is still visible; observing
      // again would retry in a tight loop. "Load more" stays the retry.
      collection.error ||
      typeof IntersectionObserver === "undefined"
    ) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMoreRef.current();
        }
      },
      { rootMargin: "180px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [
    authorized,
    controlsActive,
    collection.next,
    collection.status,
    collection.error,
    section,
  ]);
  // Like Apple Music: the clicked song plays first and the rest of the list
  // follows (the songs loaded so far; long queues continue as they play).
  const playTrack = (track: Track, index: number): void => {
    const tracks = trackResources
      .map(toTrack)
      .filter((item): item is Track => Boolean(item));
    const start = nearestTrackIndex(tracks, index, track.id);
    act(() =>
      start >= 0
        ? controller.playTracks(tracks, start)
        : controller.playTracks([track]),
    );
  };
  const updatedLabel = formatUpdated(collection.lastUpdatedAt);
  return (
    <>
      <div className="page-heading library-heading">
        <div>
          <span className="eyebrow">{copy.eyebrow}</span>
          <h1 tabIndex={-1}>{copy.title}</h1>
          <p className="library-description">{copy.description}</p>
        </div>
        <div className="library-heading-actions">
          {collection.source === "cache" ||
          collection.stale ||
          collection.isStale ? (
            <span className="library-source-badge">
              {offline ? "Cached" : "Cached · updating"}
            </span>
          ) : null}
          {updatedLabel ? (
            <span className="library-updated">{updatedLabel}</span>
          ) : null}
          <button
            className="icon-button"
            type="button"
            aria-label="Refresh library"
            onClick={retry}
            disabled={!authorized || collection.status === "loading"}
          >
            <RefreshCw
              aria-hidden="true"
              size={16}
              className={collection.status === "loading" ? "spin" : ""}
            />
          </button>
        </div>
      </div>

      {capabilities && canView ? (
        <LibraryToolbar
          key={section}
          title={copy.title}
          nameSort={section === "artists"}
          capabilities={capabilities}
          options={options}
          text={text}
          favoritesDisabled={!canAutoLoad}
          status={status}
          count={
            controlsActive ? `${visibleCount} of ${totalCount}` : undefined
          }
          onOptionsChange={changeOptions}
          onTextChange={(next) => patchView({ text: next })}
        />
      ) : null}

      {offline ? <OfflineBanner /> : null}
      {!canView ? (
        <EmptyState
          icon={Music2}
          title="Sign in to view your library"
          description="Connect your Apple Music account to sync playlists, albums, songs, and recent listening."
          action={
            <button
              className="primary-button"
              type="button"
              disabled={
                state.initialization.status !== "ready" ||
                state.auth.pending === true
              }
              onClick={() => act(controller.authorize)}
            >
              {state.auth.pending === true ? "Signing in…" : "Sign in"}
            </button>
          }
        />
      ) : (
        <>
          <CollectionFeedback
            collection={collection}
            section={section}
            onRetry={retry}
          />
          {noMatches ? (
            <EmptyState
              icon={SearchX}
              title="No matches"
              description="Nothing in this section matches the current filters."
              compact
              action={
                <button
                  className="secondary-button"
                  type="button"
                  data-library-clear
                  onClick={clearFilters}
                >
                  Clear filters
                </button>
              }
            />
          ) : null}
          {trackResources.length &&
          !["artists", "albums", "playlists"].includes(section) ? (
            <section className="library-list-panel" aria-label={copy.title}>
              <VirtualList
                className="library-track-list"
                items={trackResources}
                getKey={(resource) => resource.id}
                renderRow={(resource, index) => (
                  <LibraryTrackRow
                    resource={resource}
                    index={index}
                    onPlay={playTrack}
                    onPlayNext={(track) =>
                      act(() => controller.playNextTracks([track]))
                    }
                    disabled={!authorized}
                  />
                )}
              />
            </section>
          ) : null}
          {recentCards.length ? (
            <section
              className="library-card-grid"
              aria-label="Recently added collections"
            >
              {recentCards.map((resource) => {
                const kind = resource.type?.includes("artist")
                  ? "artist"
                  : resource.type?.includes("playlist")
                    ? "playlist"
                    : "album";
                return (
                  <ResourceCard
                    key={resource.id}
                    resource={resource}
                    kind={kind}
                    onOpen={() => router.navigate({ kind, id: resource.id })}
                  />
                );
              })}
            </section>
          ) : null}
          {visibleResources.length && section === "albums" ? (
            <section aria-label="Albums">
              <VirtualGrid
                className="library-card-grid"
                items={visibleResources}
                getKey={(resource) => resource.id}
                renderItem={(resource) => (
                  <ResourceCard
                    resource={resource}
                    kind="album"
                    onOpen={() =>
                      router.navigate({ kind: "album", id: resource.id })
                    }
                  />
                )}
              />
            </section>
          ) : null}
          {visibleResources.length && section === "artists" ? (
            <section aria-label="Artists">
              <VirtualGrid
                className="library-card-grid"
                items={visibleResources}
                getKey={(resource) => resource.id}
                renderItem={(resource) => (
                  <ResourceCard
                    resource={resource}
                    kind="artist"
                    onOpen={() =>
                      router.navigate({ kind: "artist", id: resource.id })
                    }
                  />
                )}
              />
            </section>
          ) : null}
          {visibleResources.length && section === "playlists" ? (
            <PlaylistTree
              resources={visibleResources}
              router={router}
              sort={options.sort}
              filtered={favoritesOn || text.trim().length > 0}
            />
          ) : null}
          {collection.error && collection.items.length ? (
            <p className="library-stale-note" role="status">
              Showing saved data. Refresh failed: {collection.error}
            </p>
          ) : null}
          {collection.next && !controlsActive ? (
            <button
              ref={loadMoreTrigger}
              className="secondary-button library-load-more"
              type="button"
              disabled={collection.status === "loading"}
              onClick={loadMore}
            >
              {collection.status === "loading" ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </>
      )}
    </>
  );
}
