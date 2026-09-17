import { invoke } from "@tauri-apps/api/core";
import {
  authorize,
  installAuthPopupProbe,
  isAuthorized,
  unauthorize,
} from "../musickit/auth.ts";
import { initializeMusicKit } from "../musickit/bootstrap.ts";
import {
  resolveMusicKitMusicRequest,
  searchCatalogSongs,
} from "../musickit/catalog.ts";
import { registerMusicKitEvents } from "../musickit/events.ts";
import {
  CONSECUTIVE_TRACK_TARGET,
  seekToTime,
  setVolume as setMusicVolume,
  skipToNext,
  skipToPrevious,
  toggle,
} from "../musickit/player.ts";
import { mapErrorToCode } from "../musickit/errors.ts";
import {
  normalizeLibraryItems,
  normalizeTrack,
} from "../musickit/normalize.ts";
import { classifyPlaybackKind } from "../musickit/preview.ts";
import {
  appendDiagnosticLog,
  DEFAULT_SETTINGS,
  getState,
  resetState,
  setAuthState,
  setAuthPending,
  setCurrentTrack,
  setInitializationState,
  setPlaybackError,
  setPlaybackPosition,
  setPlaybackStatus,
  setQueue,
  setSearchState,
  setSettings,
  setUpdateState,
  setUiState,
  setVolume,
  setWindowEffectState,
  type AppSettings,
  type ThemePreference,
  type UpdateChannel,
  type WindowEffectPreference,
} from "../state.ts";
import {
  applyWindowEffect,
  darkModeForTheme,
  loadSettings as loadPersistedSettings,
  saveSettings as savePersistedSettings,
  watchSystemTheme,
  type InvokeFunction,
} from "./settings.ts";
import type { Track } from "../domain/music.ts";
import type {
  MusicResourceRef,
  PlaylistTrackResourceType,
} from "../domain/music.ts";
import type { DiagnosticsStore } from "../diagnostics/store.ts";
import type { GateEnvironment } from "../phase0/gate-session.ts";
import { redactSensitive } from "../platform/redact.ts";
import { createUpdaterService, type UpdaterService } from "../updater.ts";
import {
  createAppleMusicLibraryClient,
  type AppleMusicLibraryClient,
} from "../musickit/library.ts";
import {
  LIBRARY_CACHE_SCOPE,
  createLibraryCache,
  type CachedPage,
  type LibraryCache,
} from "../library/cache.ts";
import type { LibraryEntity, LibrarySection } from "../state.ts";
import {
  appendLibraryCollectionItems,
  clearLibraryState,
  setAccountSummary,
  setLibraryCollectionItems,
  setLibraryCollectionState,
  setLibraryDetailState,
  setLibraryHydrated,
} from "../state.ts";

export interface ControllerDependencies {
  initializeMusicKit?: typeof initializeMusicKit;
  searchCatalogSongs?: typeof searchCatalogSongs;
  invokeFn?: InvokeFunction;
  now?: () => number;
  diagnosticsStore?: DiagnosticsStore;
  updater?: UpdaterService;
  libraryCache?: LibraryCache;
  createLibraryClient?: (
    instance: MusicKit.MusicKitInstance,
  ) => AppleMusicLibraryClient;
}

export interface AppController {
  initialize(): Promise<void>;
  loadSettings(): Promise<void>;
  authorize(): Promise<void>;
  signOut(): Promise<void>;
  loadLibrarySection(
    section: LibrarySection,
    options?: { refresh?: boolean; cursor?: string },
  ): Promise<void>;
  loadMoreLibrarySection(
    section: LibrarySection,
    cursor?: string,
  ): Promise<void>;
  refreshLibrarySection(section: LibrarySection): Promise<void>;
  loadAlbum(id: string): Promise<void>;
  loadArtist(id: string): Promise<void>;
  loadPlaylist(id: string): Promise<void>;
  loadPlaylistFolder(id?: string): Promise<void>;
  searchPlaylists(query: string): Promise<LibraryEntity[]>;
  createPlaylist(
    name: string,
    description?: string,
  ): Promise<LibraryEntity | undefined>;
  createPlaylistFolder(name: string): Promise<LibraryEntity | undefined>;
  addTracksToPlaylist(
    playlistId: string,
    tracks: readonly Track[] | readonly string[],
  ): Promise<void>;
  playNextTracks(tracks: readonly Track[] | readonly string[]): Promise<void>;
  playLaterTracks(tracks: readonly Track[] | readonly string[]): Promise<void>;
  refreshCurrentData(): Promise<void>;
  search(term: string): Promise<Track[]>;
  playFromSearch(index: number): Promise<void>;
  playTracks(tracks: readonly Track[], startIndex?: number): Promise<void>;
  playConsecutive(): Promise<void>;
  togglePlayback(): Promise<void>;
  previous(): Promise<void>;
  next(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(volume: number): void;
  setTheme(theme: ThemePreference): Promise<void>;
  setWindowEffect(preference: WindowEffectPreference): Promise<void>;
  setAutoCheckUpdates(enabled: boolean): Promise<void>;
  setUpdateChannel(channel: UpdateChannel): Promise<void>;
  startupUpdateCheck(): Promise<void>;
  checkForUpdates(): Promise<void>;
  dismissUpdate(): void;
  installUpdate(): Promise<void>;
  toggleQueue(): void;
  toggleDiagnostics(): void;
  closeDiagnostics(): void;
  openMusicDiagnostic(): Promise<string>;
  setDiagnosticsEnvironment(environment: GateEnvironment): void;
  log(message: string): void;
  dispose(): void;
  readonly consecutiveTrackTarget: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeErrorMessage(error: unknown): string {
  return redactSensitive(errorMessage(error))
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, 500);
}

function timestamp(now: () => number): string {
  return new Date(now()).toISOString();
}

type LibraryMethod = (...args: unknown[]) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function asItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  for (const key of ["items", "data", "tracks", "resources"]) {
    if (Array.isArray(record?.[key])) return record[key] as unknown[];
  }
  return [];
}

function asNext(value: unknown): string | undefined {
  const record = asRecord(value);
  for (const key of ["next", "nextCursor", "next_cursor", "nextUrl"]) {
    const candidate = record?.[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function asLibraryEntities(value: unknown): LibraryEntity[] {
  const record = asRecord(value);
  const values = typeof record?.id === "string" ? [value] : asItems(value);
  return values.filter((item): item is LibraryEntity => {
    const record = asRecord(item);
    return typeof record?.id === "string" && record.id.length > 0;
  });
}

function normalizedLibraryEntities(value: unknown): LibraryEntity[] {
  const resources = asItems(value);
  return normalizeLibraryItems(resources) as unknown as LibraryEntity[];
}

function asPage(
  raw: unknown,
  cursor: string | undefined,
  updatedAt: number,
): CachedPage<LibraryEntity> {
  return {
    cursor,
    items: asLibraryEntities(raw),
    next: asNext(raw),
    updatedAt,
  };
}

function detailFromResponse(raw: unknown): {
  item?: LibraryEntity;
  items: LibraryEntity[];
  next?: string;
} {
  const record = asRecord(raw);
  const candidate = record?.item ?? record?.resource ?? raw;
  const itemRecord = asRecord(candidate);
  const item =
    typeof itemRecord?.id === "string"
      ? (itemRecord as LibraryEntity)
      : undefined;
  return {
    item,
    items: asLibraryEntities(
      record?.tracks ?? record?.items ?? record?.data ?? [],
    ),
    next: asNext(raw),
  };
}

function flattenFolderChildren(value: unknown): LibraryEntity[] {
  const output: LibraryEntity[] = [];
  const seen = new Set<string>();
  const visit = (candidate: unknown, parentId?: string): void => {
    const record = asRecord(candidate);
    if (!record || typeof record.id !== "string" || seen.has(record.id)) return;
    seen.add(record.id);
    const item = {
      ...record,
      ...(parentId && typeof record.parentId !== "string" ? { parentId } : {}),
    } as LibraryEntity;
    output.push(item);
    const children = Array.isArray(record.children) ? record.children : [];
    for (const child of children) visit(child, record.id);
  };
  const root = asRecord(value);
  const children = Array.isArray(root?.children) ? root.children : [];
  for (const child of children) visit(child, root?.id as string | undefined);
  return output;
}

function queueOptionsForTracks(
  tracks: readonly Track[],
): MusicKit.QueueOptions {
  const types = new Set(tracks.map((track) => track.resourceType));
  if (types.size === 1 && types.has("library-songs")) {
    return { librarySongs: tracks.map((track) => track.id) };
  }
  if (types.size === 1 && types.has("library-music-videos")) {
    return { libraryMusicVideos: tracks.map((track) => track.id) };
  }
  if (types.size === 1 && types.has("music-videos")) {
    return { musicVideos: tracks.map((track) => track.catalogId ?? track.id) };
  }
  return { songs: tracks.map((track) => track.catalogId ?? track.id) };
}

function libraryMethod(
  client: AppleMusicLibraryClient,
  name: string,
): LibraryMethod {
  const method = (client as unknown as Record<string, unknown>)[name];
  if (typeof method !== "function") {
    throw new Error(`Apple Music library operation is unavailable: ${name}`);
  }
  return method.bind(client) as LibraryMethod;
}

function trackIds(tracks: readonly Track[] | readonly string[]): string[] {
  return tracks
    .map((track) => (typeof track === "string" ? track : track.id))
    .filter((id) => id.trim().length > 0);
}

const playlistTrackTypes = new Set<PlaylistTrackResourceType>([
  "songs",
  "library-songs",
  "music-videos",
  "library-music-videos",
]);

function trackRefs(
  tracks: readonly Track[] | readonly string[],
): MusicResourceRef[] {
  return tracks.map((track) => {
    if (typeof track === "string") {
      return { id: track, type: "songs" };
    }
    const type = playlistTrackTypes.has(
      track.resourceType as PlaylistTrackResourceType,
    )
      ? (track.resourceType as PlaylistTrackResourceType)
      : "songs";
    const id = type.startsWith("library-")
      ? track.id
      : (track.catalogId ?? track.id);
    return { id, type };
  });
}

export function createAppController(
  dependencies: ControllerDependencies = {},
): AppController {
  const initialize = dependencies.initializeMusicKit ?? initializeMusicKit;
  const searchCatalog = dependencies.searchCatalogSongs ?? searchCatalogSongs;
  const invokeFn = dependencies.invokeFn ?? (invoke as InvokeFunction);
  const now = dependencies.now ?? Date.now;
  const diagnosticsStore = dependencies.diagnosticsStore;
  let music: MusicKit.MusicKitInstance | null = null;
  let searchRequestId = 0;
  let lastSearchTracks: Track[] = [];
  let restoreAuthProbe: (() => void) | undefined;
  let stopMusicKitEvents: (() => void) | undefined;
  let stopThemeWatcher: (() => void) | undefined;
  const libraryCache = dependencies.libraryCache ?? createLibraryCache();
  const createLibraryClient =
    dependencies.createLibraryClient ?? createAppleMusicLibraryClient;
  let libraryClient: AppleMusicLibraryClient | null = null;
  let cacheReady: Promise<void> | undefined;
  const refreshedSections = new Set<LibrarySection>();
  const libraryRequests = new Map<LibrarySection, number>();

  const ensureLibraryCache = async (): Promise<void> => {
    cacheReady ??= libraryCache.initialize().catch((error: unknown) => {
      log(`Library cache unavailable: ${safeErrorMessage(error)}`);
    });
    await cacheReady;
    setLibraryHydrated(true);
    try {
      const meta = await libraryCache.getMeta(LIBRARY_CACHE_SCOPE);
      if (meta?.storefront || meta?.lastRefreshAt) {
        setAccountSummary({
          storefront: meta.storefront,
          lastRefreshAt: meta.lastRefreshAt,
        });
      }
    } catch (error) {
      log(`Library cache metadata unavailable: ${safeErrorMessage(error)}`);
    }
  };

  const clearLibraryCache = async (): Promise<void> => {
    refreshedSections.clear();
    clearLibraryState();
    try {
      await libraryCache.clear(LIBRARY_CACHE_SCOPE);
    } catch (error) {
      log(`Library cache clear failed: ${safeErrorMessage(error)}`);
    }
  };

  const requireLibrary = (): AppleMusicLibraryClient => {
    requireMusic();
    if (getState().auth.status !== "authorized") {
      throw new Error("Sign in to access your Apple Music library.");
    }
    if (!libraryClient) {
      throw new Error("Apple Music library is still initializing.");
    }
    return libraryClient;
  };

  const libraryPage = async (
    section: LibrarySection,
    cursor: string | undefined,
  ): Promise<CachedPage<LibraryEntity>> => {
    const client = requireLibrary();
    const raw =
      section === "recent"
        ? await libraryMethod(client, "getRecentlyAdded")(cursor)
        : section === "history"
          ? await libraryMethod(client, "getRecentlyPlayedTracks")(cursor)
          : section === "artists"
            ? await libraryMethod(client, "getArtists")(cursor)
            : section === "albums"
              ? await libraryMethod(client, "getAlbums")(cursor)
              : section === "songs"
                ? await libraryMethod(client, "getSongs")(cursor)
                : await libraryMethod(client, "getPlaylists")(cursor);
    const storefront = String(requireMusic().storefrontId ?? "").trim();
    if (storefront) setAccountSummary({ storefront });
    return asPage(raw, cursor, now());
  };

  const hydrateLibrarySection = async (
    section: LibrarySection,
  ): Promise<CachedPage<LibraryEntity> | undefined> => {
    await ensureLibraryCache();
    try {
      const cached = await libraryCache.readSection<LibraryEntity>(
        LIBRARY_CACHE_SCOPE,
        section,
      );
      if (cached && cached.items.length > 0) {
        setLibraryCollectionItems(section, cached.items, {
          source: "cache",
          status: "success",
          next: cached.next,
          lastUpdatedAt: cached.updatedAt,
          stale: true,
        });
        return cached;
      }
    } catch (error) {
      log(`Library cache read failed (${section}): ${safeErrorMessage(error)}`);
    }
    return undefined;
  };

  const refreshLibrarySection = async (
    section: LibrarySection,
  ): Promise<void> => {
    const requestId = (libraryRequests.get(section) ?? 0) + 1;
    libraryRequests.set(section, requestId);
    const current = getState().library.collections[section];
    setLibraryCollectionState(section, {
      status: current.items.length > 0 ? "refreshing" : "loading",
      error: undefined,
    });
    try {
      const page = await libraryPage(section, undefined);
      if (libraryRequests.get(section) !== requestId) return;
      await ensureLibraryCache();
      try {
        await libraryCache.clearSection(LIBRARY_CACHE_SCOPE, section);
        await libraryCache.writePage(LIBRARY_CACHE_SCOPE, section, page);
      } catch (error) {
        log(
          `Library cache write failed (${section}): ${safeErrorMessage(error)}`,
        );
      }
      setLibraryCollectionItems(section, page.items, {
        source: "network",
        status: "success",
        next: page.next,
        lastUpdatedAt: page.updatedAt,
        stale: false,
      });
      const storefront = getState().library.account.storefront;
      setAccountSummary({ lastRefreshAt: page.updatedAt });
      try {
        await libraryCache.setMeta({
          scope: LIBRARY_CACHE_SCOPE,
          storefront,
          lastRefreshAt: page.updatedAt,
        });
      } catch (error) {
        log(`Library cache metadata write failed: ${safeErrorMessage(error)}`);
      }
    } catch (error) {
      if (libraryRequests.get(section) !== requestId) return;
      const message = safeErrorMessage(error);
      const latest = getState().library.collections[section];
      setLibraryCollectionState(section, {
        status: latest.items.length > 0 ? "success" : "error",
        source: latest.items.length > 0 ? latest.source : "none",
        error: message,
        stale: latest.items.length > 0,
      });
      log(`Library refresh failed (${section}): ${message}`);
      if (latest.items.length === 0) throw error;
    }
  };

  const loadLibrarySection = async (
    section: LibrarySection,
    options: { refresh?: boolean; cursor?: string } = {},
  ): Promise<void> => {
    requireLibrary();
    if (options.cursor) {
      await loadMoreLibrarySection(section, options.cursor);
      return;
    }
    const current = getState().library.collections[section];
    let cached: CachedPage<LibraryEntity> | undefined;
    if (!options.refresh && current.items.length === 0) {
      cached = await hydrateLibrarySection(section);
    }
    if (options.refresh || !refreshedSections.has(section)) {
      refreshedSections.add(section);
      await refreshLibrarySection(section);
    } else if (!cached && current.items.length === 0) {
      await refreshLibrarySection(section);
    }
  };

  const loadMoreLibrarySection = async (
    section: LibrarySection,
    cursorOverride?: string,
  ): Promise<void> => {
    const client = requireLibrary();
    const current = getState().library.collections[section];
    const cursor = cursorOverride ?? current.next;
    if (!cursor) return;
    const requestId = (libraryRequests.get(section) ?? 0) + 1;
    libraryRequests.set(section, requestId);
    setLibraryCollectionState(section, {
      status: "loading",
      error: undefined,
    });
    try {
      const raw =
        section === "recent"
          ? await libraryMethod(client, "getRecentlyAdded")(cursor)
          : section === "history"
            ? await libraryMethod(client, "getRecentlyPlayedTracks")(cursor)
            : section === "artists"
              ? await libraryMethod(client, "getArtists")(cursor)
              : section === "albums"
                ? await libraryMethod(client, "getAlbums")(cursor)
                : section === "songs"
                  ? await libraryMethod(client, "getSongs")(cursor)
                  : await libraryMethod(client, "getPlaylists")(cursor);
      const page = asPage(raw, cursor, now());
      if (libraryRequests.get(section) !== requestId) return;
      await ensureLibraryCache();
      try {
        await libraryCache.writePage(LIBRARY_CACHE_SCOPE, section, page);
      } catch (error) {
        log(
          `Library cache write failed (${section}): ${safeErrorMessage(error)}`,
        );
      }
      appendLibraryCollectionItems(section, page.items, {
        source: "network",
        next: page.next,
        lastUpdatedAt: page.updatedAt,
      });
    } catch (error) {
      if (libraryRequests.get(section) !== requestId) return;
      const message = safeErrorMessage(error);
      const latest = getState().library.collections[section];
      setLibraryCollectionState(section, {
        status: latest.items.length > 0 ? "success" : "error",
        error: message,
        stale: latest.items.length > 0,
      });
      log(`Library page load failed (${section}): ${message}`);
      throw error;
    }
  };

  const loadAlbumTracks = async (
    client: AppleMusicLibraryClient,
    id: string,
  ): Promise<LibraryEntity[]> => {
    const method = (client as unknown as Record<string, unknown>)
      .getAlbumTracks;
    if (typeof method === "function") {
      return asLibraryEntities(
        await (method as LibraryMethod).call(client, id),
      );
    }
    // The current public client contract keeps album-track expansion optional.
    // Use the documented relationship path only when MusicKit exposes its
    // request adapter; preview/test instances simply render the album shell.
    const instance = music;
    if (!instance) return [];
    try {
      const raw = await resolveMusicKitMusicRequest(instance)(
        `/v1/me/library/albums/${encodeURIComponent(id)}/tracks`,
      );
      return normalizedLibraryEntities(raw);
    } catch {
      return [];
    }
  };

  const loadDetail = async (
    kind: "album" | "artist",
    id: string,
  ): Promise<void> => {
    const client = requireLibrary();
    const section = `${kind}:${id}`;
    setLibraryDetailState(
      kind,
      {
        status: "loading",
        error: undefined,
      },
      id,
    );
    try {
      const raw = await libraryMethod(
        client,
        `get${kind[0].toUpperCase()}${kind.slice(1)}`,
      )(id);
      const detail = detailFromResponse(raw);
      if (!detail.item && detail.items.length > 0) {
        detail.item = detail.items[0];
        detail.items = detail.items.slice(1);
      }
      if (kind === "album" && detail.items.length === 0) {
        detail.items = await loadAlbumTracks(client, id);
      }
      if (kind === "artist" && detail.items.length === 0) {
        try {
          await loadLibrarySection("albums");
          const artistName = detail.item?.name;
          detail.items = getState().library.collections.albums.items.filter(
            (album) => {
              const candidate = album as LibraryEntity;
              return (
                typeof candidate.artistName === "string" &&
                typeof artistName === "string" &&
                candidate.artistName.localeCompare(artistName, undefined, {
                  sensitivity: "base",
                }) === 0
              );
            },
          );
        } catch (error) {
          log(`Artist album expansion failed: ${safeErrorMessage(error)}`);
        }
      }
      const page: CachedPage<LibraryEntity> = {
        cursor: undefined,
        items: detail.item ? [detail.item, ...detail.items] : detail.items,
        next: detail.next,
        updatedAt: now(),
      };
      await ensureLibraryCache();
      try {
        await libraryCache.clearSection(LIBRARY_CACHE_SCOPE, section);
        await libraryCache.writePage(LIBRARY_CACHE_SCOPE, section, page);
      } catch (error) {
        log(
          `Library detail cache write failed (${kind}): ${safeErrorMessage(error)}`,
        );
      }
      setLibraryDetailState(
        kind,
        {
          status: "success",
          source: "network",
          item: detail.item,
          resource: detail.item,
          items: detail.items,
          tracks: kind === "album" ? detail.items : undefined,
          albums: kind === "artist" ? detail.items : undefined,
          next: detail.next,
          lastUpdatedAt: page.updatedAt,
          stale: false,
        },
        id,
      );
    } catch (error) {
      try {
        await ensureLibraryCache();
        const cached = await libraryCache.readSection<LibraryEntity>(
          LIBRARY_CACHE_SCOPE,
          section,
        );
        if (cached?.items.length) {
          setLibraryDetailState(
            kind,
            {
              status: "success",
              source: "cache",
              item: cached.items[0],
              resource: cached.items[0],
              items: cached.items.slice(1),
              tracks: kind === "album" ? cached.items.slice(1) : undefined,
              albums: kind === "artist" ? cached.items.slice(1) : undefined,
              next: cached.next,
              lastUpdatedAt: cached.updatedAt,
              stale: true,
              error: safeErrorMessage(error),
            },
            id,
          );
          return;
        }
      } catch (cacheError) {
        log(
          `Library detail cache read failed (${kind}): ${safeErrorMessage(cacheError)}`,
        );
      }
      const message = safeErrorMessage(error);
      setLibraryDetailState(
        kind,
        {
          status: "error",
          source: "none",
          error: message,
          stale: false,
        },
        id,
      );
      log(`Library detail load failed (${kind}): ${message}`);
      throw error;
    }
  };

  const loadPlaylist = async (id: string): Promise<void> => {
    const client = requireLibrary();
    setLibraryDetailState(
      "playlist",
      {
        status: "loading",
        error: undefined,
      },
      id,
    );
    try {
      const [playlistRaw, tracksRaw] = await Promise.all([
        libraryMethod(client, "getPlaylist")(id),
        libraryMethod(client, "getPlaylistTracks")(id),
      ]);
      const detail = detailFromResponse(playlistRaw);
      const tracks = asLibraryEntities(tracksRaw);
      if (!detail.item && detail.items.length > 0) {
        detail.item = detail.items[0];
      }
      const items = tracks.length > 0 ? tracks : detail.items.slice(1);
      const page: CachedPage<LibraryEntity> = {
        items: detail.item ? [detail.item, ...items] : items,
        next: asNext(tracksRaw) ?? detail.next,
        updatedAt: now(),
      };
      await ensureLibraryCache();
      try {
        await libraryCache.clearSection(LIBRARY_CACHE_SCOPE, `playlist:${id}`);
        await libraryCache.writePage(
          LIBRARY_CACHE_SCOPE,
          `playlist:${id}`,
          page,
        );
      } catch (error) {
        log(`Playlist cache write failed: ${safeErrorMessage(error)}`);
      }
      setLibraryDetailState(
        "playlist",
        {
          status: "success",
          source: "network",
          item: detail.item,
          resource: detail.item,
          items,
          tracks: items,
          next: page.next,
          lastUpdatedAt: page.updatedAt,
          stale: false,
        },
        id,
      );
    } catch (error) {
      try {
        await ensureLibraryCache();
        const cached = await libraryCache.readSection<LibraryEntity>(
          LIBRARY_CACHE_SCOPE,
          `playlist:${id}`,
        );
        if (cached?.items.length) {
          setLibraryDetailState(
            "playlist",
            {
              status: "success",
              source: "cache",
              item: cached.items[0],
              resource: cached.items[0],
              items: cached.items.slice(1),
              tracks: cached.items.slice(1),
              next: cached.next,
              lastUpdatedAt: cached.updatedAt,
              stale: true,
              error: safeErrorMessage(error),
            },
            id,
          );
          return;
        }
      } catch (cacheError) {
        log(`Playlist cache read failed: ${safeErrorMessage(cacheError)}`);
      }
      const message = safeErrorMessage(error);
      setLibraryDetailState(
        "playlist",
        {
          status: "error",
          source: "none",
          error: message,
          stale: false,
        },
        id,
      );
      log(`Playlist load failed: ${message}`);
      throw error;
    }
  };

  const loadPlaylistFolder = async (id?: string): Promise<void> => {
    const client = requireLibrary();
    const section = `playlist-folder:${id ?? "root"}`;
    setLibraryDetailState("playlistFolder", {
      status: "loading",
      error: undefined,
    });
    try {
      const raw = id
        ? await libraryMethod(client, "getPlaylistFolder")(id)
        : await libraryMethod(client, "getRootPlaylistFolder")();
      const detail = detailFromResponse(raw);
      const items = flattenFolderChildren(raw);
      const updatedAt = now();
      await ensureLibraryCache();
      try {
        await libraryCache.clearSection(LIBRARY_CACHE_SCOPE, section);
        await libraryCache.writePage(LIBRARY_CACHE_SCOPE, section, {
          items: detail.item ? [detail.item, ...items] : items,
          updatedAt,
        });
      } catch (cacheError) {
        log(
          `Playlist folder cache write failed: ${safeErrorMessage(cacheError)}`,
        );
      }
      setLibraryDetailState("playlistFolder", {
        status: "success",
        source: "network",
        item: detail.item,
        items,
        next: detail.next,
        lastUpdatedAt: updatedAt,
        stale: false,
      });
    } catch (error) {
      try {
        await ensureLibraryCache();
        const cached = await libraryCache.readSection<LibraryEntity>(
          LIBRARY_CACHE_SCOPE,
          section,
        );
        if (cached?.items.length) {
          setLibraryDetailState("playlistFolder", {
            status: "success",
            source: "cache",
            item: cached.items[0],
            items: cached.items.slice(1),
            lastUpdatedAt: cached.updatedAt,
            stale: true,
            error: safeErrorMessage(error),
          });
          return;
        }
      } catch (cacheError) {
        log(
          `Playlist folder cache read failed: ${safeErrorMessage(cacheError)}`,
        );
      }
      const message = safeErrorMessage(error);
      setLibraryDetailState("playlistFolder", {
        status: "error",
        source: "none",
        error: message,
        stale: false,
      });
      log(`Playlist folder load failed: ${message}`);
      throw error;
    }
  };

  const log = (message: string): void => {
    const line = redactSensitive(`[${timestamp(now)}] ${message}`);
    const failure = /failed|error|denied|unavailable|blocked|drm/i.test(
      message,
    );
    appendDiagnosticLog(line, failure);
    diagnosticsStore?.log(message, {
      level: failure ? "error" : "info",
      source: "app",
    });
    // Keep development diagnostics useful when the drawer is not mounted.
    if (import.meta.env.DEV) console.info(line);
  };

  const updater =
    dependencies.updater ??
    createUpdaterService({
      onStateChange: setUpdateState,
      onLog: log,
      now,
    });

  const applyCurrentEffect = async (): Promise<void> => {
    const settings = getState().settings;
    const dark = darkModeForTheme(settings.theme);
    const result = await applyWindowEffect(
      settings.windowEffect,
      dark,
      invokeFn,
    );
    setWindowEffectState(result);
    if (result.fallbackReason) {
      log(`Window effect fallback: ${result.fallbackReason}`);
    }
  };

  const syncPlaybackDiagnostics = (): void => {
    if (!diagnosticsStore) return;
    const snapshot = getState();
    const currentId = snapshot.playback.current?.id;
    const catalogTrack =
      snapshot.playback.queue.find((track) => track.id === currentId) ??
      lastSearchTracks.find((track) => track.id === currentId) ??
      snapshot.playback.current;
    diagnosticsStore.setMetadata({
      tracksPlayed: snapshot.tracksPlayed,
      playbackStatus: snapshot.playback.status,
      playbackKind: classifyPlaybackKind({
        catalogDurationSeconds:
          catalogTrack?.durationMs !== undefined
            ? catalogTrack.durationMs / 1000
            : undefined,
        playbackDurationSeconds: snapshot.playback.durationSeconds,
      }),
    });
  };

  const initializeController = async (): Promise<void> => {
    setInitializationState({ status: "loading" });
    log("Initializing MusicKit…");
    try {
      music = await initialize();
      try {
        libraryClient = createLibraryClient(music);
      } catch (error) {
        // Some preview/test instances intentionally omit the catalog API. Keep
        // playback and authorization usable; library actions will report the
        // narrower capability error when invoked.
        libraryClient = null;
        log(
          `Library API unavailable until MusicKit catalog is ready: ${safeErrorMessage(error)}`,
        );
      }
      stopMusicKitEvents?.();
      stopMusicKitEvents = undefined;
      if (typeof music.addEventListener === "function") {
        stopMusicKitEvents = registerMusicKitEvents(
          music,
          () => {
            syncPlaybackDiagnostics();
          },
          (message) => {
            log(`Media playback error: ${message}`);
          },
        );
      }
      restoreAuthProbe = installAuthPopupProbe(log);
      setInitializationState({ status: "ready" });
      log("MusicKit initialized successfully.");
      if (isAuthorized(music)) {
        setAuthState({ status: "authorized" });
        await ensureLibraryCache();
        const storefront = String(music.storefrontId ?? "").trim();
        if (storefront) setAccountSummary({ storefront });
        if (music.nowPlayingItem) {
          setCurrentTrack(normalizeTrack(music.nowPlayingItem));
        }
        log("Already authorized from previous session.");
      }
      syncPlaybackDiagnostics();
    } catch (error) {
      const message = safeErrorMessage(error);
      setInitializationState({ status: "error", message });
      log(`MusicKit init failed: ${message}`);
    }
  };

  const requireMusic = (): MusicKit.MusicKitInstance => {
    if (!music) throw new Error("MusicKit is still initializing.");
    return music;
  };

  const controller: AppController = {
    initialize: initializeController,

    async loadSettings(): Promise<void> {
      const settings = await loadPersistedSettings(invokeFn);
      setSettings(settings);
      updater.configure(settings);
      await applyCurrentEffect();
      stopThemeWatcher?.();
      stopThemeWatcher = watchSystemTheme((dark) => {
        if (getState().settings.theme === "system") {
          void applyWindowEffect(
            getState().settings.windowEffect,
            dark,
            invokeFn,
          ).then(setWindowEffectState);
        }
      });
    },

    async authorize(): Promise<void> {
      if (getState().auth.pending) return;
      let authorizationStarted = false;
      try {
        const instance = requireMusic();
        authorizationStarted = true;
        setAuthPending(true);
        // A fresh authorization may belong to a different Apple account. Drop
        // the previous session's metadata before MusicKit opens its popup.
        log("Authorizing… waiting for Apple Music sign-in window.");
        // Start both operations immediately: the in-memory library is cleared
        // synchronously, the persisted cache is purged, and MusicKit can open
        // its popup without an extra event-loop delay.
        await Promise.all([clearLibraryCache(), authorize(instance)]);
        // Keep the user token private to MusicKit; only expose auth status.
        setAuthState({ status: "authorized" });
        try {
          libraryClient ??= createLibraryClient(instance);
        } catch (error) {
          libraryClient = null;
          log(
            `Library API unavailable after authorization: ${safeErrorMessage(error)}`,
          );
        }
        await ensureLibraryCache();
        const storefront = String(instance.storefrontId ?? "").trim();
        if (storefront) setAccountSummary({ storefront, connectedAt: now() });
        log("Authorization successful.");
      } catch (error) {
        const message = safeErrorMessage(error);
        log(`Authorization failed: ${message}`);
        throw error;
      } finally {
        if (authorizationStarted) setAuthPending(false);
      }
    },

    async signOut(): Promise<void> {
      try {
        const instance = requireMusic();
        await unauthorize(instance);
        await clearLibraryCache();
        searchRequestId += 1;
        lastSearchTracks = [];
        resetState();
        setInitializationState({ status: "ready" });
        log("Signed out.");
      } catch (error) {
        const message = safeErrorMessage(error);
        log(`Sign out failed: ${message}`);
        throw error;
      }
    },

    loadLibrarySection,

    loadMoreLibrarySection,

    refreshLibrarySection,

    loadAlbum(id: string): Promise<void> {
      return loadDetail("album", id);
    },

    loadArtist(id: string): Promise<void> {
      return loadDetail("artist", id);
    },

    loadPlaylist,

    loadPlaylistFolder,

    async searchPlaylists(query: string): Promise<LibraryEntity[]> {
      const trimmed = query.trim();
      if (!trimmed) return [];
      const raw = await libraryMethod(
        requireLibrary(),
        "searchPlaylists",
      )(trimmed);
      return asLibraryEntities(raw);
    },

    async createPlaylist(
      name: string,
      description?: string,
    ): Promise<LibraryEntity | undefined> {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Playlist name is required.");
      const raw = await libraryMethod(
        requireLibrary(),
        "createPlaylist",
      )({
        name: trimmed,
        description:
          description && description.trim().length > 0
            ? description.trim()
            : undefined,
      });
      const items = asLibraryEntities(raw);
      refreshedSections.delete("playlists");
      try {
        await refreshLibrarySection("playlists");
        await loadPlaylistFolder();
        refreshedSections.add("playlists");
      } catch (error) {
        log(
          `Playlist list refresh failed after create: ${safeErrorMessage(error)}`,
        );
      }
      return items[0];
    },

    async createPlaylistFolder(
      name: string,
    ): Promise<LibraryEntity | undefined> {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Folder name is required.");
      const raw = await libraryMethod(
        requireLibrary(),
        "createPlaylistFolder",
      )({ name: trimmed });
      const items = asLibraryEntities(raw);
      refreshedSections.delete("playlists");
      try {
        await refreshLibrarySection("playlists");
        await loadPlaylistFolder();
        refreshedSections.add("playlists");
      } catch (error) {
        log(
          `Playlist list refresh failed after folder create: ${safeErrorMessage(error)}`,
        );
      }
      return items[0];
    },

    async addTracksToPlaylist(
      playlistId: string,
      tracks: readonly Track[] | readonly string[],
    ): Promise<void> {
      const ids = trackIds(tracks);
      if (!playlistId.trim()) throw new Error("Playlist id is required.");
      if (ids.length === 0) throw new Error("At least one track is required.");
      const detail = getState().library.details.playlist[playlistId];
      const listed = getState().library.collections.playlists.items.find(
        (item) => item.id === playlistId,
      );
      const playlist = asRecord(detail)?.item ?? listed;
      if (asRecord(playlist)?.canEdit === false) {
        throw new Error("This playlist cannot be edited.");
      }
      for (const track of tracks) {
        if (typeof track !== "string" && track.addable === false) {
          throw new Error(`Track cannot be added to playlist: ${track.title}`);
        }
      }
      await libraryMethod(requireLibrary(), "addTracksToPlaylist")(
        playlistId,
        trackRefs(tracks),
      );
      try {
        await loadPlaylist(playlistId);
      } catch (error) {
        log(
          `Playlist refresh failed after adding tracks: ${safeErrorMessage(error)}`,
        );
      }
    },

    async playNextTracks(
      tracks: readonly Track[] | readonly string[],
    ): Promise<void> {
      const ids = trackIds(tracks);
      if (ids.length === 0) throw new Error("At least one track is required.");
      const instance = requireMusic() as unknown as Record<string, unknown>;
      const playNext = instance.playNext;
      if (typeof playNext !== "function") {
        throw new Error("Play Next is not available in this MusicKit runtime.");
      }
      const options =
        typeof tracks[0] === "string"
          ? { songs: ids }
          : queueOptionsForTracks(tracks as readonly Track[]);
      await (
        playNext as (options: MusicKit.QueueOptions) => Promise<void>
      ).call(instance, options);
    },

    async playLaterTracks(
      tracks: readonly Track[] | readonly string[],
    ): Promise<void> {
      const ids = trackIds(tracks);
      if (ids.length === 0) throw new Error("At least one track is required.");
      const instance = requireMusic() as unknown as Record<string, unknown>;
      const playLater = instance.playLater;
      if (typeof playLater !== "function") {
        throw new Error(
          "Play Later is not available in this MusicKit runtime.",
        );
      }
      const options =
        typeof tracks[0] === "string"
          ? { songs: ids }
          : queueOptionsForTracks(tracks as readonly Track[]);
      await (
        playLater as (options: MusicKit.QueueOptions) => Promise<void>
      ).call(instance, options);
    },

    async refreshCurrentData(): Promise<void> {
      const route = getState().navigation;
      switch (route.kind) {
        case "library":
          await refreshLibrarySection(route.section as LibrarySection);
          return;
        case "album":
          await loadDetail("album", route.id);
          return;
        case "artist":
          await loadDetail("artist", route.id);
          return;
        case "playlist":
          await loadPlaylist(route.id);
          return;
        case "search":
          await controller.search(route.query);
          return;
        default:
          return;
      }
    },

    async search(term: string): Promise<Track[]> {
      const trimmed = term.trim();
      const requestId = ++searchRequestId;
      setSearchState({
        query: trimmed,
        status: trimmed ? "loading" : "idle",
        results: [],
        error: undefined,
        requestId,
      });
      if (!trimmed) {
        lastSearchTracks = [];
        return [];
      }
      try {
        const tracks = await searchCatalog(requireMusic(), trimmed, {
          limit: 25,
        });
        if (requestId !== searchRequestId) return tracks;
        lastSearchTracks = tracks;
        setSearchState({
          query: trimmed,
          status: "success",
          results: tracks,
          error: undefined,
          requestId,
        });
        log(`Found ${tracks.length} result${tracks.length === 1 ? "" : "s"}.`);
        return tracks;
      } catch (error) {
        if (requestId !== searchRequestId) return [];
        const message = safeErrorMessage(error);
        setSearchState({
          query: trimmed,
          status: "error",
          results: [],
          error: message,
          requestId,
        });
        log(`Search failed: ${message}`);
        return [];
      }
    },

    async playFromSearch(index: number): Promise<void> {
      const tracks = lastSearchTracks.length
        ? lastSearchTracks
        : getState().search.results;
      await controller.playTracks(tracks, index);
    },

    async playTracks(tracks: readonly Track[], startIndex = 0): Promise<void> {
      const instance = requireMusic();
      const queue = tracks.slice(Math.max(0, startIndex));
      if (queue.length === 0) throw new Error("Queue is empty");
      setQueue([...queue], 0);
      setPlaybackStatus("loading");
      try {
        await instance.setQueue(queueOptionsForTracks(queue));
        await instance.play();
      } catch (error) {
        const rawMessage = errorMessage(error);
        const message = safeErrorMessage(error);
        setPlaybackError(mapErrorToCode(rawMessage), message);
        log(`Play failed: ${message}`);
        throw error;
      }
    },

    async playConsecutive(): Promise<void> {
      const tracks = lastSearchTracks.length
        ? lastSearchTracks
        : getState().search.results;
      if (tracks.length < CONSECUTIVE_TRACK_TARGET) {
        throw new Error(
          `Need at least ${CONSECUTIVE_TRACK_TARGET} search results.`,
        );
      }
      await controller.playTracks(tracks.slice(0, CONSECUTIVE_TRACK_TARGET));
    },

    async togglePlayback(): Promise<void> {
      try {
        await toggle(requireMusic());
      } catch (error) {
        log(`Toggle failed: ${errorMessage(error)}`);
        throw error;
      }
    },

    async previous(): Promise<void> {
      try {
        await skipToPrevious(requireMusic());
      } catch (error) {
        log(`Previous failed: ${errorMessage(error)}`);
        throw error;
      }
    },

    async next(): Promise<void> {
      try {
        await skipToNext(requireMusic());
      } catch (error) {
        log(`Next failed: ${errorMessage(error)}`);
        throw error;
      }
    },

    async seek(seconds: number): Promise<void> {
      const safeSeconds = Math.max(0, seconds);
      try {
        await seekToTime(requireMusic(), safeSeconds);
        setPlaybackPosition(safeSeconds, getState().playback.durationSeconds);
      } catch (error) {
        log(`Seek failed: ${errorMessage(error)}`);
        throw error;
      }
    },

    setVolume(volume: number): void {
      const safeVolume = Math.max(0, Math.min(1, volume));
      setVolume(safeVolume);
      if (music) setMusicVolume(music, safeVolume);
    },

    async setTheme(theme: ThemePreference): Promise<void> {
      const settings: AppSettings = {
        ...getState().settings,
        theme,
      };
      setSettings(settings);
      try {
        await savePersistedSettings(settings, invokeFn);
      } catch (error) {
        log(`Settings save failed: ${errorMessage(error)}`);
      }
      await applyCurrentEffect();
    },

    async setWindowEffect(preference: WindowEffectPreference): Promise<void> {
      const settings: AppSettings = {
        ...getState().settings,
        windowEffect: preference,
      };
      setSettings(settings);
      try {
        await savePersistedSettings(settings, invokeFn);
      } catch (error) {
        log(`Settings save failed: ${errorMessage(error)}`);
      }
      await applyCurrentEffect();
    },

    async setAutoCheckUpdates(enabled: boolean): Promise<void> {
      const settings: AppSettings = {
        ...getState().settings,
        autoCheckUpdates: enabled,
      };
      setSettings(settings);
      updater.configure(settings);
      try {
        await savePersistedSettings(settings, invokeFn);
      } catch (error) {
        log(`Settings save failed: ${errorMessage(error)}`);
      }
    },

    async setUpdateChannel(channel: UpdateChannel): Promise<void> {
      const settings: AppSettings = {
        ...getState().settings,
        updateChannel: channel,
      };
      setSettings(settings);
      updater.configure(settings);
      try {
        await savePersistedSettings(settings, invokeFn);
      } catch (error) {
        log(`Settings save failed: ${errorMessage(error)}`);
      }
    },

    startupUpdateCheck(): Promise<void> {
      return updater.startupCheck();
    },

    checkForUpdates(): Promise<void> {
      return updater.checkNow();
    },

    dismissUpdate(): void {
      updater.dismissPending();
    },

    installUpdate(): Promise<void> {
      return updater.installPending();
    },

    toggleQueue(): void {
      setUiState({ queueOpen: !getState().ui.queueOpen });
    },

    toggleDiagnostics(): void {
      if (import.meta.env.DEV) {
        setUiState({ diagnosticsOpen: !getState().ui.diagnosticsOpen });
      }
    },

    closeDiagnostics(): void {
      setUiState({ diagnosticsOpen: false });
    },

    async openMusicDiagnostic(): Promise<string> {
      try {
        const result = await invokeFn<string>("open_music_diagnostic");
        log(`Diagnostic window ${result}.`);
        return result;
      } catch (error) {
        log(`Diagnostic window failed: ${errorMessage(error)}`);
        throw error;
      }
    },

    setDiagnosticsEnvironment(environment: GateEnvironment): void {
      diagnosticsStore?.setMetadata({ environment });
    },

    log,

    dispose(): void {
      stopMusicKitEvents?.();
      stopMusicKitEvents = undefined;
      restoreAuthProbe?.();
      restoreAuthProbe = undefined;
      stopThemeWatcher?.();
      stopThemeWatcher = undefined;
      updater.dispose();
    },

    consecutiveTrackTarget: CONSECUTIVE_TRACK_TARGET,
  };

  // The settings defaults are intentionally stable if load is delayed/fails.
  setSettings({ ...DEFAULT_SETTINGS });
  return controller;
}
