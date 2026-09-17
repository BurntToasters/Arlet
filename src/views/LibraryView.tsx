import {
  AlertCircle,
  Album as AlbumIcon,
  ChevronDown,
  ChevronRight,
  Disc3,
  Folder,
  History as HistoryIcon,
  ListMusic,
  LoaderCircle,
  Music2,
  Play,
  RefreshCw,
  UserRound,
} from "lucide-preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  useAppController,
  useAppRouter,
  useAppState,
} from "../app/context.tsx";
import type { AppController } from "../app/controller.ts";
import { Artwork } from "../components/Artwork.tsx";
import { EmptyState } from "./EmptyState.tsx";
import type { Track } from "../domain/music.ts";
import type { LibrarySection } from "../routing/router.ts";

export interface ResourceLike {
  id: string;
  type?: string;
  kind?: string;
  title: string;
  artistName?: string;
  artistId?: string;
  albumTitle?: string;
  albumId?: string;
  artwork?: Track["artwork"];
  durationMs?: number;
  explicit?: boolean;
  catalogUrl?: string;
  catalogId?: string;
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
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

interface LibraryController {
  loadLibrarySection?: (
    section: LibrarySection,
    options?: { refresh?: boolean; cursor?: string },
  ) => Promise<unknown>;
  loadMoreLibrarySection?: (
    section: LibrarySection,
    cursor?: string,
  ) => Promise<unknown>;
  refreshLibrarySection?: (section: LibrarySection) => Promise<unknown>;
  loadAlbum?: (id: string) => Promise<unknown>;
  loadArtist?: (id: string) => Promise<unknown>;
  loadPlaylist?: (id: string) => Promise<unknown>;
  loadPlaylistFolder?: (id?: string) => Promise<unknown>;
  playNextTracks?: (tracks: readonly Track[]) => Promise<void>;
  playLaterTracks?: (tracks: readonly Track[]) => Promise<void>;
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

export function toResource(value: unknown): ResourceLike | undefined {
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
    catalogUrl: stringValue(raw.catalogUrl, attributes.url, raw.href),
    catalogId: stringValue(raw.catalogId, attributes.catalogId),
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

export function toTrack(value: unknown): Track | undefined {
  const resource = toResource(value);
  if (!resource) return undefined;
  return {
    id: resource.id,
    title: resource.title,
    artistName: resource.artistName ?? "Unknown artist",
    albumTitle: resource.albumTitle,
    artwork: resource.artwork,
    durationMs: resource.durationMs,
    explicit: resource.explicit,
    catalogUrl: resource.catalogUrl,
    resourceType: resource.type,
    catalogId: resource.catalogId,
    playable: resource.playable,
    addable: resource.addable,
  };
}

function readLibrary(state: ReturnType<typeof useAppState>): LibraryModelLike {
  const value = (state as unknown as { library?: unknown }).library;
  return objectValue(value) ?? {};
}

export function readCollection(
  state: ReturnType<typeof useAppState>,
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
  state: ReturnType<typeof useAppState>,
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

function readPlaylistFolderItems(
  state: ReturnType<typeof useAppState>,
): unknown[] {
  const library = readLibrary(state);
  const details = objectValue(library.details);
  const folder = objectValue(details?.playlistFolder);
  return Array.isArray(folder?.items) ? folder.items : [];
}

function formatDuration(durationMs?: number): string {
  if (!durationMs || durationMs <= 0) return "—";
  const seconds = Math.floor(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatUpdated(value: number | string | undefined): string {
  if (value === undefined) return "";
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return `Updated ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(parsed))}`;
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

function run(action: () => Promise<unknown> | undefined): void {
  void Promise.resolve(action()).catch(() => undefined);
}

export function LibraryTrackRow({
  resource,
  index,
  onPlay,
  disabled,
}: {
  resource: ResourceLike;
  index: number;
  onPlay: (track: Track) => void;
  disabled: boolean;
}): JSX.Element {
  const track = toTrack(resource);
  if (!track) return <li />;
  return (
    <li>
      <button
        className="library-track-row"
        type="button"
        disabled={disabled}
        aria-label={`Play ${track.title} by ${track.artistName}`}
        {...contextData(resource, "track")}
        onClick={() => onPlay(track)}
      >
        <span className="library-row-number" aria-hidden="true">
          {String(index + 1).padStart(2, "0")}
        </span>
        <Artwork track={track} size="sm" alt="" />
        <span className="library-row-copy">
          <strong title={track.title}>{track.title}</strong>
          <span title={track.artistName}>
            {track.artistName}
            {track.albumTitle ? ` · ${track.albumTitle}` : ""}
          </span>
        </span>
        {track.explicit ? <span className="explicit-badge">E</span> : null}
        <span className="library-row-duration">
          {formatDuration(track.durationMs)}
        </span>
        <span className="row-play-button" aria-hidden="true">
          <Play size={15} fill="currentColor" strokeWidth={1.9} />
        </span>
      </button>
    </li>
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
  const Icon =
    kind === "album" ? AlbumIcon : kind === "artist" ? UserRound : ListMusic;
  const trackLike = toTrack(resource);
  return (
    <button
      className="library-card"
      type="button"
      {...contextData(resource, kind)}
      onClick={onOpen}
    >
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
        <small title={resource.artistName}>{resource.artistName ?? kind}</small>
      </span>
    </button>
  );
}

function PlaylistTree({
  resources,
  router,
}: {
  resources: ResourceLike[];
  router: ReturnType<typeof useAppRouter>;
}): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const folders = resources.filter((resource) => resource.isFolder);
  const playlists = resources.filter((resource) => !resource.isFolder);
  const childrenOf = (parentId?: string): ResourceLike[] =>
    resources.filter((resource) => resource.parentId === parentId);
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
    const nestedFolders = childrenOf(folder.id).filter(
      (child) => child.isFolder,
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
  const rootFolders = folders.filter(
    (folder) =>
      !folder.parentId ||
      !folders.some((candidate) => candidate.id === folder.parentId),
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
    return (
      <div className="library-feedback" role="status">
        <LoaderCircle className="spin" aria-hidden="true" size={22} /> Loading
        your library…
      </div>
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
  const state = useAppState();
  const controller = useAppController();
  const router = useAppRouter();
  const loadMoreTrigger = useRef<HTMLButtonElement>(null);
  const extendedController = controller as AppController & LibraryController;
  const copy = SECTION_COPY[section];
  const collection = readCollection(state, section);
  const authorized =
    state.auth.status === "authorized" &&
    state.initialization.status === "ready";
  const folderItems =
    section === "playlists" ? readPlaylistFolderItems(state) : [];
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
  const recentCards =
    section === "recent"
      ? resources.filter((resource) =>
          ["album", "artist", "playlist"].some((kind) =>
            resource.type?.includes(kind),
          ),
        )
      : [];
  const trackResources =
    section === "recent"
      ? resources.filter((resource) => !recentCards.includes(resource))
      : resources;

  useEffect(() => {
    if (!authorized || !extendedController.loadLibrarySection) return;
    run(() => extendedController.loadLibrarySection?.(section));
    if (section === "playlists" && extendedController.loadPlaylistFolder) {
      run(() => extendedController.loadPlaylistFolder?.());
    }
  }, [
    authorized,
    extendedController.loadLibrarySection,
    extendedController.loadPlaylistFolder,
    section,
  ]);

  const retry = (): void => {
    if (extendedController.refreshLibrarySection)
      run(() => extendedController.refreshLibrarySection?.(section));
    else if (extendedController.loadLibrarySection)
      run(() =>
        extendedController.loadLibrarySection?.(section, { refresh: true }),
      );
  };
  const loadMore = (): void => {
    if (collection.next && extendedController.loadMoreLibrarySection) {
      run(() =>
        extendedController.loadMoreLibrarySection?.(
          section,
          collection.next ?? undefined,
        ),
      );
    }
  };
  useEffect(() => {
    const target = loadMoreTrigger.current;
    if (
      !target ||
      !authorized ||
      !collection.next ||
      collection.status === "loading" ||
      typeof IntersectionObserver === "undefined"
    ) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: "180px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [authorized, collection.next, collection.status, section]);
  const playTrack = (track: Track): void =>
    run(() => controller.playTracks([track]));
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
            <span className="library-source-badge">Cached · updating</span>
          ) : null}
          {formatUpdated(collection.lastUpdatedAt) ? (
            <span className="library-updated">
              {formatUpdated(collection.lastUpdatedAt)}
            </span>
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

      {!authorized ? (
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
              onClick={() => run(controller.authorize)}
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
          {trackResources.length &&
          !["artists", "albums", "playlists"].includes(section) ? (
            <section className="library-list-panel" aria-label={copy.title}>
              <ol className="library-track-list">
                {trackResources.map((resource, index) => (
                  <LibraryTrackRow
                    key={resource.id}
                    resource={resource}
                    index={index}
                    onPlay={playTrack}
                    disabled={!authorized}
                  />
                ))}
              </ol>
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
          {resources.length && section === "albums" ? (
            <section className="library-card-grid" aria-label="Albums">
              {resources.map((resource) => (
                <ResourceCard
                  key={resource.id}
                  resource={resource}
                  kind="album"
                  onOpen={() =>
                    router.navigate({ kind: "album", id: resource.id })
                  }
                />
              ))}
            </section>
          ) : null}
          {resources.length && section === "artists" ? (
            <section className="library-card-grid" aria-label="Artists">
              {resources.map((resource) => (
                <ResourceCard
                  key={resource.id}
                  resource={resource}
                  kind="artist"
                  onOpen={() =>
                    router.navigate({ kind: "artist", id: resource.id })
                  }
                />
              ))}
            </section>
          ) : null}
          {resources.length && section === "playlists" ? (
            <PlaylistTree resources={resources} router={router} />
          ) : null}
          {collection.error && collection.items.length ? (
            <p className="library-stale-note" role="status">
              Showing saved data. Refresh failed: {collection.error}
            </p>
          ) : null}
          {collection.next ? (
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
