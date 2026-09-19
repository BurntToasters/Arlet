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
  loadBrowseCharts,
  loadRadioStations,
  resolveStorefront,
  searchMusicResources,
  searchCatalogSongs,
} from "../musickit/catalog.ts";
import { registerMusicKitEvents } from "../musickit/events.ts";
import {
  CONSECUTIVE_TRACK_TARGET,
  queueOptionsForTracks as musicKitQueueOptionsForTracks,
  seekToTime,
  readPlaybackModes,
  setShuffleMode as setMusicShuffleMode,
  setRepeatMode as setMusicRepeatMode,
  setVolume as setMusicVolume,
  skipToNext,
  skipToPrevious,
  syncMusicKitQueue,
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
  setHomeState,
  setInitializationState,
  setPlaybackError,
  setPlaybackPosition,
  setPlaybackStatus,
  setPins,
  setQueue,
  setQueueSnapshot,
  setSearchState,
  setBrowseState,
  setRadioState,
  setPlaybackModes,
  setSettings,
  setUpdateState,
  setUiState,
  setVolume,
  setWindowEffectState,
  type AppSettings,
  type HomeState,
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
import {
  MAX_PINS,
  loadPins as loadPersistedPins,
  savePins as savePersistedPins,
} from "./pins.ts";
import type { PinnedPlaylist, Track } from "../domain/music.ts";
import type {
  Station,
  MusicSource,
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
  clearHomeState,
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
  searchMusicResources?: typeof searchMusicResources;
  loadBrowseCharts?: typeof loadBrowseCharts;
  loadRadioStations?: typeof loadRadioStations;
}

export interface DetailLoadOptions {
  refresh?: boolean;
}

export interface AppController {
  initialize(): Promise<void>;
  loadSettings(): Promise<void>;
  loadPins(): Promise<void>;
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
  loadHome(options?: { refresh?: boolean }): Promise<void>;
  loadBrowse?(options?: { refresh?: boolean }): Promise<void>;
  loadRadio?(options?: { refresh?: boolean }): Promise<void>;
  playStation?(station: Station): Promise<void>;
  loadAlbum(
    id: string,
    source?: MusicSource,
    options?: DetailLoadOptions,
  ): Promise<void>;
  loadArtist(
    id: string,
    source?: MusicSource,
    options?: DetailLoadOptions,
  ): Promise<void>;
  loadPlaylist(
    id: string,
    source?: MusicSource,
    options?: DetailLoadOptions,
  ): Promise<void>;
  loadPlaylistFolder(id?: string): Promise<void>;
  togglePin(id: string, source?: MusicSource): Promise<void>;
  unpin(id: string): Promise<void>;
  isPinned(id: string): boolean;
  searchPlaylists(query: string): Promise<LibraryEntity[]>;
  createPlaylist(
    request: CreatePlaylistRequest,
  ): Promise<LibraryEntity | undefined>;
  createPlaylist(
    name: string,
    description?: string,
    tracks?: readonly Track[] | readonly string[],
  ): Promise<LibraryEntity | undefined>;
  createPlaylistFolder(name: string): Promise<LibraryEntity | undefined>;
  addTracksToPlaylist(
    playlistId: string,
    tracks: readonly Track[] | readonly string[],
  ): Promise<void>;
  playNextTracks(tracks: readonly Track[] | readonly string[]): Promise<void>;
  playLaterTracks(tracks: readonly Track[] | readonly string[]): Promise<void>;
  playQueueItem(index: number): Promise<void>;
  refreshCurrentData(): Promise<void>;
  search(term: string): Promise<Track[]>;
  setSearchSource?(source: "catalog" | "library"): void;
  playFromSearch(index: number): Promise<void>;
  playTracks(tracks: readonly Track[], startIndex?: number): Promise<void>;
  playConsecutive(): Promise<void>;
  togglePlayback(): Promise<void>;
  play?(): Promise<void>;
  pause?(): Promise<void>;
  setShuffleMode?(mode: "off" | "songs"): Promise<void>;
  cycleRepeatMode?(): Promise<void>;
  previous(): Promise<void>;
  next(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
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

export interface CreatePlaylistRequest {
  name: string;
  description?: string;
  tracks?: readonly Track[] | readonly string[];
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

function detailCacheSection(
  kind: "album" | "artist" | "playlist",
  id: string,
  source: MusicSource,
): string {
  const base = `${kind}:${id}`;
  return source === "catalog" ? `${kind}:catalog:${id}` : base;
}

function detailRequestKey(
  kind: "album" | "artist" | "playlist",
  id: string,
  source: MusicSource,
): string {
  return `${kind}:${source}:${id}`;
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
  return musicKitQueueOptionsForTracks(tracks);
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

function materializeTracks(
  tracks: readonly Track[] | readonly string[],
): Track[] {
  return tracks
    .map((track) =>
      typeof track === "string"
        ? {
            id: track.trim(),
            title: track.trim(),
            artistName: "Unknown Artist",
          }
        : track,
    )
    .filter((track) => track.id.trim().length > 0);
}

function sameTrackIds(
  left: readonly Track[],
  right: readonly Track[],
): boolean {
  return (
    left.length === right.length &&
    left.every((track, index) => track.id === right[index]?.id)
  );
}

export function createAppController(
  dependencies: ControllerDependencies = {},
): AppController {
  const initialize = dependencies.initializeMusicKit ?? initializeMusicKit;
  const searchCatalogOverride = dependencies.searchCatalogSongs;
  const searchResources =
    dependencies.searchMusicResources ?? searchMusicResources;
  const browseCharts = dependencies.loadBrowseCharts ?? loadBrowseCharts;
  const radioStations = dependencies.loadRadioStations ?? loadRadioStations;
  const invokeFn = dependencies.invokeFn ?? (invoke as InvokeFunction);
  const now = dependencies.now ?? Date.now;
  const diagnosticsStore = dependencies.diagnosticsStore;
  let music: MusicKit.MusicKitInstance | null = null;
  let volumeSaveQueue: Promise<void> = Promise.resolve();
  let searchRequestId = 0;
  let lastSearchTracks: Track[] = [];
  let lastSearchSource: "catalog" | "library" = "catalog";
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
  const detailRequests = new Map<string, number>();
  let homeRequestId = 0;
  let browseRequestId = 0;
  let radioRequestId = 0;

  const applyPlaybackVolume = (volume: number): number => {
    const safeVolume = Number.isFinite(volume)
      ? Math.max(0, Math.min(1, volume))
      : DEFAULT_SETTINGS.volume;
    setVolume(safeVolume);
    if (music) setMusicVolume(music, safeVolume);
    return safeVolume;
  };

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
    homeRequestId += 1;
    clearHomeState();
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

  const requireMusicClient = (): AppleMusicLibraryClient => {
    requireMusic();
    if (!libraryClient) {
      throw new Error("Apple Music catalog is still initializing.");
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
    if (storefront && storefront !== getState().library.account.storefront) {
      setAccountSummary({ storefront });
    }
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

  const loadHome = async (
    options: { refresh?: boolean } = {},
  ): Promise<void> => {
    requireLibrary();
    const current = getState().home;
    if (!options.refresh && current.status === "success") return;
    const requestId = ++homeRequestId;
    setHomeState({
      status:
        current.recentPlaylists.length ||
        current.heavyRotation.length ||
        current.recommendations.length
          ? "refreshing"
          : "loading",
      errors: {},
    });
    const client = requireLibrary();
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        libraryMethod(client, "getRecentlyPlayedPlaylists")(10),
      ),
      Promise.resolve().then(() =>
        libraryMethod(client, "getHeavyRotation")(10),
      ),
      Promise.resolve().then(() =>
        libraryMethod(client, "getRecommendations")(10),
      ),
    ]);
    if (homeRequestId !== requestId) return;

    const errors: HomeState["errors"] = {};
    let successful = 0;
    let recentPlaylists = current.recentPlaylists;
    let heavyRotation = current.heavyRotation;
    let recommendations = current.recommendations;
    const [recentResult, heavyResult, recommendationResult] = results;
    if (recentResult.status === "fulfilled") {
      successful += 1;
      recentPlaylists = asLibraryEntities(
        asRecord(recentResult.value)?.items ?? recentResult.value,
      ) as HomeState["recentPlaylists"];
    } else {
      errors.recentPlaylists = safeErrorMessage(recentResult.reason);
    }
    if (heavyResult.status === "fulfilled") {
      successful += 1;
      heavyRotation = asLibraryEntities(
        asRecord(heavyResult.value)?.items ?? heavyResult.value,
      ).filter((item) => {
        const type = String(item.type ?? item.resourceType ?? "");
        return type.includes("album") || type.includes("playlist");
      }) as HomeState["heavyRotation"];
    } else {
      errors.heavyRotation = safeErrorMessage(heavyResult.reason);
    }
    if (recommendationResult.status === "fulfilled") {
      successful += 1;
      recommendations = Array.isArray(recommendationResult.value)
        ? recommendationResult.value
        : [];
    } else {
      errors.recommendations = safeErrorMessage(recommendationResult.reason);
    }
    const hasData =
      recentPlaylists.length > 0 ||
      heavyRotation.length > 0 ||
      recommendations.length > 0;
    const updatedAt = now();
    setHomeState({
      status: successful > 0 ? "success" : "error",
      recentPlaylists,
      heavyRotation,
      recommendations,
      errors,
      lastUpdatedAt: successful > 0 ? updatedAt : current.lastUpdatedAt,
      stale: hasData && successful < 3,
    });
    if (successful === 0) {
      throw new Error(
        Object.values(errors).filter(Boolean).join("; ") ||
          "Apple Music Home is unavailable.",
      );
    }
  };

  const loadBrowse = async (
    options: { refresh?: boolean } = {},
  ): Promise<void> => {
    const current = getState().browse;
    if (!options.refresh && current.status === "success") return;
    const requestId = ++browseRequestId;
    setBrowseState({
      status:
        current.songs.length ||
        current.albums.length ||
        current.playlists.length
          ? "refreshing"
          : "loading",
      error: undefined,
    });
    try {
      const result = await browseCharts(requireMusic(), { limit: 20 });
      if (requestId !== browseRequestId) return;
      setBrowseState({
        status: "success",
        songs: result.songs,
        albums: result.albums,
        playlists: result.playlists,
        lastUpdatedAt: now(),
        error: undefined,
      });
    } catch (error) {
      if (requestId !== browseRequestId) return;
      const message = safeErrorMessage(error);
      setBrowseState({
        status: "error",
        error: message,
      });
      log(`Browse load failed: ${message}`);
      throw error;
    }
  };

  const loadRadio = async (
    options: { refresh?: boolean } = {},
  ): Promise<void> => {
    const current = getState().radio;
    if (!options.refresh && current.status === "success") return;
    const requestId = ++radioRequestId;
    const hadData =
      current.personal.items.length > 0 ||
      current.live.items.length > 0 ||
      current.recent.items.length > 0;
    setRadioState({
      status: hadData ? "refreshing" : "loading",
      personal: { ...current.personal, status: "loading", error: undefined },
      live: { ...current.live, status: "loading", error: undefined },
      recent: { ...current.recent, status: "loading", error: undefined },
      error: undefined,
    });
    const kinds = ["personal", "live", "recent"] as const;
    const results = await Promise.allSettled(
      kinds.map((kind) =>
        Promise.resolve().then(() => radioStations(requireMusic(), kind)),
      ),
    );
    if (requestId !== radioRequestId) return;
    let successCount = 0;
    const next = {
      personal: { ...current.personal },
      live: { ...current.live },
      recent: { ...current.recent },
    };
    results.forEach((result, index) => {
      const kind = kinds[index];
      if (result.status === "fulfilled") {
        successCount += 1;
        next[kind] = { status: "success", items: result.value };
      } else {
        next[kind] = {
          status: "error",
          items: current[kind].items,
          error: safeErrorMessage(result.reason),
        };
      }
    });
    const errors = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => safeErrorMessage(result.reason));
    setRadioState({
      ...next,
      status: successCount > 0 ? "success" : "error",
      error: errors.length ? errors.join("; ") : undefined,
      lastUpdatedAt: successCount > 0 ? now() : current.lastUpdatedAt,
    });
    if (successCount === 0)
      throw new Error(errors.join("; ") || "Radio unavailable.");
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
    source: MusicSource,
  ): Promise<LibraryEntity[]> => {
    const method = (client as unknown as Record<string, unknown>)
      .getAlbumTracks;
    if (typeof method === "function") {
      return asLibraryEntities(
        await (method as LibraryMethod).call(client, id, source),
      );
    }
    // The current public client contract keeps album-track expansion optional.
    // Use the documented relationship path only when MusicKit exposes its
    // request adapter; preview/test instances simply render the album shell.
    const instance = music;
    if (!instance) return [];
    try {
      const storefront = String(instance.storefrontId ?? "").trim();
      const prefix =
        source === "catalog" && storefront
          ? `/v1/catalog/${encodeURIComponent(storefront)}`
          : "/v1/me/library";
      const raw = await resolveMusicKitMusicRequest(instance)(
        `${prefix}/albums/${encodeURIComponent(id)}/tracks`,
      );
      return normalizedLibraryEntities(raw);
    } catch {
      return [];
    }
  };

  const loadDetail = async (
    kind: "album" | "artist",
    id: string,
    source: MusicSource = "library",
    options: DetailLoadOptions = {},
  ): Promise<void> => {
    const client =
      source === "library" ? requireLibrary() : requireMusicClient();
    const cacheSection = detailCacheSection(kind, id, source);
    const requestKey = detailRequestKey(kind, id, source);
    const requestId = (detailRequests.get(requestKey) ?? 0) + 1;
    detailRequests.set(requestKey, requestId);
    const isCurrent = (): boolean =>
      detailRequests.get(requestKey) === requestId;
    const explicit = options.refresh === true;
    let stalePage: CachedPage<LibraryEntity> | undefined;
    if (!explicit) {
      try {
        await ensureLibraryCache();
        const cached = await libraryCache.readSection<LibraryEntity>(
          LIBRARY_CACHE_SCOPE,
          cacheSection,
        );
        if (!isCurrent()) {
          stalePage = undefined;
        } else if (cached?.items.length) {
          stalePage = cached;
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
              error: undefined,
            },
            id,
            source,
          );
        } else {
          setLibraryDetailState(
            kind,
            { status: "loading", error: undefined },
            id,
            source,
          );
        }
      } catch (error) {
        log(
          `Library detail cache read failed (${kind}): ${safeErrorMessage(error)}`,
        );
        if (isCurrent()) {
          setLibraryDetailState(
            kind,
            { status: "loading", error: undefined },
            id,
            source,
          );
        }
      }
    } else {
      setLibraryDetailState(
        kind,
        { status: "loading", error: undefined },
        id,
        source,
      );
    }
    try {
      const raw = await libraryMethod(
        client,
        `get${kind[0].toUpperCase()}${kind.slice(1)}`,
      )(id, source);
      if (!isCurrent()) return;
      const detail = detailFromResponse(raw);
      if (!detail.item && detail.items.length > 0) {
        detail.item = detail.items[0];
        detail.items = detail.items.slice(1);
      }
      if (kind === "album" && detail.items.length === 0) {
        detail.items = await loadAlbumTracks(client, id, source);
        if (!isCurrent()) return;
      }
      if (kind === "artist" && detail.items.length === 0) {
        try {
          if (source === "catalog" && music) {
            const storefront = await resolveStorefront(music);
            const rawAlbums = await resolveMusicKitMusicRequest(music)(
              `/v1/catalog/${encodeURIComponent(storefront)}/artists/${encodeURIComponent(id)}/albums`,
            );
            detail.items = normalizedLibraryEntities(rawAlbums);
          } else {
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
          }
        } catch (error) {
          log(`Artist album expansion failed: ${safeErrorMessage(error)}`);
        }
        if (!isCurrent()) return;
      }
      const page: CachedPage<LibraryEntity> = {
        cursor: undefined,
        items: detail.item ? [detail.item, ...detail.items] : detail.items,
        next: detail.next,
        updatedAt: now(),
      };
      await ensureLibraryCache();
      try {
        await libraryCache.clearSection(LIBRARY_CACHE_SCOPE, cacheSection);
        await libraryCache.writePage(LIBRARY_CACHE_SCOPE, cacheSection, page);
      } catch (error) {
        log(
          `Library detail cache write failed (${kind}): ${safeErrorMessage(error)}`,
        );
      }
      if (!isCurrent()) return;
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
        source,
      );
    } catch (error) {
      if (!isCurrent()) return;
      if (stalePage?.items.length) {
        setLibraryDetailState(
          kind,
          {
            status: "success",
            source: "cache",
            item: stalePage.items[0],
            resource: stalePage.items[0],
            items: stalePage.items.slice(1),
            tracks: kind === "album" ? stalePage.items.slice(1) : undefined,
            albums: kind === "artist" ? stalePage.items.slice(1) : undefined,
            next: stalePage.next,
            lastUpdatedAt: stalePage.updatedAt,
            stale: true,
            error: safeErrorMessage(error),
          },
          id,
          source,
        );
        log(`Library detail load failed (${kind}): ${safeErrorMessage(error)}`);
        if (explicit) throw error;
        return;
      }
      try {
        await ensureLibraryCache();
        const cached = await libraryCache.readSection<LibraryEntity>(
          LIBRARY_CACHE_SCOPE,
          cacheSection,
        );
        if (!isCurrent()) return;
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
            source,
          );
          log(
            `Library detail load failed (${kind}): ${safeErrorMessage(error)}`,
          );
          if (explicit) throw error;
          return;
        }
      } catch (cacheError) {
        log(
          `Library detail cache read failed (${kind}): ${safeErrorMessage(cacheError)}`,
        );
      }
      if (!isCurrent()) return;
      const message = safeErrorMessage(error);
      setLibraryDetailState(
        kind,
        { status: "error", source: "none", error: message, stale: false },
        id,
        source,
      );
      log(`Library detail load failed (${kind}): ${message}`);
      throw error;
    }
  };

  const loadPlaylist = async (
    id: string,
    source: MusicSource = "library",
    options: DetailLoadOptions = {},
  ): Promise<void> => {
    const client =
      source === "library" ? requireLibrary() : requireMusicClient();
    const cacheSection = detailCacheSection("playlist", id, source);
    const requestKey = detailRequestKey("playlist", id, source);
    const requestId = (detailRequests.get(requestKey) ?? 0) + 1;
    detailRequests.set(requestKey, requestId);
    const isCurrent = (): boolean =>
      detailRequests.get(requestKey) === requestId;
    const explicit = options.refresh === true;
    let stalePage: CachedPage<LibraryEntity> | undefined;
    if (!explicit) {
      try {
        await ensureLibraryCache();
        const cached = await libraryCache.readSection<LibraryEntity>(
          LIBRARY_CACHE_SCOPE,
          cacheSection,
        );
        if (!isCurrent()) {
          stalePage = undefined;
        } else if (cached?.items.length) {
          stalePage = cached;
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
              error: undefined,
            },
            id,
            source,
          );
        } else {
          setLibraryDetailState(
            "playlist",
            { status: "loading", error: undefined },
            id,
            source,
          );
        }
      } catch (error) {
        log(`Playlist cache read failed: ${safeErrorMessage(error)}`);
        if (isCurrent()) {
          setLibraryDetailState(
            "playlist",
            { status: "loading", error: undefined },
            id,
            source,
          );
        }
      }
    } else {
      setLibraryDetailState(
        "playlist",
        { status: "loading", error: undefined },
        id,
        source,
      );
    }
    try {
      const [playlistRaw, tracksRaw] = await Promise.all([
        libraryMethod(client, "getPlaylist")(id, source),
        source === "catalog"
          ? libraryMethod(client, "getPlaylistTracks")(id, source)
          : libraryMethod(client, "getPlaylistTracks")(id),
      ]);
      if (!isCurrent()) return;
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
        await libraryCache.clearSection(LIBRARY_CACHE_SCOPE, cacheSection);
        await libraryCache.writePage(LIBRARY_CACHE_SCOPE, cacheSection, page);
      } catch (error) {
        log(`Playlist cache write failed: ${safeErrorMessage(error)}`);
      }
      if (!isCurrent()) return;
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
        source,
      );
    } catch (error) {
      if (!isCurrent()) return;
      if (stalePage?.items.length) {
        setLibraryDetailState(
          "playlist",
          {
            status: "success",
            source: "cache",
            item: stalePage.items[0],
            resource: stalePage.items[0],
            items: stalePage.items.slice(1),
            tracks: stalePage.items.slice(1),
            next: stalePage.next,
            lastUpdatedAt: stalePage.updatedAt,
            stale: true,
            error: safeErrorMessage(error),
          },
          id,
          source,
        );
        log(`Playlist load failed: ${safeErrorMessage(error)}`);
        if (explicit) throw error;
        return;
      }
      try {
        await ensureLibraryCache();
        const cached = await libraryCache.readSection<LibraryEntity>(
          LIBRARY_CACHE_SCOPE,
          cacheSection,
        );
        if (!isCurrent()) return;
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
            source,
          );
          log(`Playlist load failed: ${safeErrorMessage(error)}`);
          if (explicit) throw error;
          return;
        }
      } catch (cacheError) {
        log(`Playlist cache read failed: ${safeErrorMessage(cacheError)}`);
      }
      if (!isCurrent()) return;
      const message = safeErrorMessage(error);
      setLibraryDetailState(
        "playlist",
        { status: "error", source: "none", error: message, stale: false },
        id,
        source,
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

  const persistPins = async (
    pins: readonly PinnedPlaylist[],
  ): Promise<void> => {
    try {
      await savePersistedPins(pins, invokeFn);
    } catch (error) {
      log(`Pinned playlists save failed: ${safeErrorMessage(error)}`);
    }
  };

  const reloadPins = async (): Promise<void> => {
    setPins(await loadPersistedPins(invokeFn));
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
      applyPlaybackVolume(getState().settings.volume);
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
        const syncPlaybackModes = (): void => {
          const modes = readPlaybackModes(music as MusicKit.MusicKitInstance);
          setPlaybackModes({
            shuffleMode: modes.shuffleMode,
            repeatMode: modes.repeatMode,
            modeCapabilities: modes.capabilities,
          });
        };
        stopMusicKitEvents = registerMusicKitEvents(
          music,
          () => {
            syncPlaybackDiagnostics();
          },
          (message) => {
            log(`Media playback error: ${message}`);
          },
          undefined,
          syncPlaybackModes,
        );
        syncPlaybackModes();
      }
      syncMusicKitQueue(music);
      const initialModes = readPlaybackModes(music);
      setPlaybackModes({
        shuffleMode: initialModes.shuffleMode,
        repeatMode: initialModes.repeatMode,
        modeCapabilities: initialModes.capabilities,
      });
      restoreAuthProbe = installAuthPopupProbe(log);
      setInitializationState({ status: "ready" });
      log("MusicKit initialized successfully.");
      if (isAuthorized(music)) {
        setAuthState({ status: "authorized" });
        const cachePromise = ensureLibraryCache();
        const storefront = String(music.storefrontId ?? "").trim();
        const nowPlaying = music.nowPlayingItem
          ? normalizeTrack(music.nowPlayingItem)
          : undefined;
        if (nowPlaying) setCurrentTrack(nowPlaying);
        await cachePromise;
        if (storefront) setAccountSummary({ storefront });
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
      applyPlaybackVolume(settings.volume);
      updater.configure(settings);
      const effectPromise = applyCurrentEffect();
      const pinsPromise = reloadPins();
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
      await Promise.all([effectPromise, pinsPromise]);
    },

    async loadPins(): Promise<void> {
      await reloadPins();
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
        await Promise.all([ensureLibraryCache(), reloadPins()]);
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
        setPins([]);
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

    loadHome,

    loadBrowse,

    loadRadio,

    async playStation(station: Station): Promise<void> {
      const url = station.url?.trim();
      if (!url) throw new Error("This station cannot be played.");
      const instance = requireMusic();
      setPlaybackStatus("loading");
      try {
        await instance.setQueue({ url });
        await instance.play();
      } catch (error) {
        const rawMessage = errorMessage(error);
        const message = safeErrorMessage(error);
        setPlaybackError(mapErrorToCode(rawMessage), message);
        log(`Station play failed: ${message}`);
        throw error;
      }
    },

    loadAlbum(
      id: string,
      source: MusicSource = "library",
      options: DetailLoadOptions = {},
    ): Promise<void> {
      return loadDetail("album", id, source, options);
    },

    loadArtist(
      id: string,
      source: MusicSource = "library",
      options: DetailLoadOptions = {},
    ): Promise<void> {
      return loadDetail("artist", id, source, options);
    },

    loadPlaylist,

    loadPlaylistFolder,

    async togglePin(
      id: string,
      source: MusicSource = "library",
    ): Promise<void> {
      const trimmed = id.trim();
      if (!trimmed) return;
      const current = getState().pins;
      const next = current.some((pin) => pin.id === trimmed)
        ? current.filter((pin) => pin.id !== trimmed)
        : [...current, { id: trimmed, source }].slice(0, MAX_PINS);
      setPins(next);
      await persistPins(next);
    },

    async unpin(id: string): Promise<void> {
      const current = getState().pins;
      if (!current.some((pin) => pin.id === id)) return;
      const next = current.filter((pin) => pin.id !== id);
      setPins(next);
      await persistPins(next);
    },

    isPinned(id: string): boolean {
      return getState().pins.some((pin) => pin.id === id);
    },

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
      requestOrName: CreatePlaylistRequest | string,
      legacyDescription?: string,
      legacyTracks?: readonly Track[] | readonly string[],
    ): Promise<LibraryEntity | undefined> {
      const request: CreatePlaylistRequest =
        typeof requestOrName === "string"
          ? {
              name: requestOrName,
              description: legacyDescription,
              tracks: legacyTracks,
            }
          : requestOrName;
      const trimmed = request.name.trim();
      if (!trimmed) throw new Error("Playlist name is required.");
      const raw = await libraryMethod(
        requireLibrary(),
        "createPlaylist",
      )({
        name: trimmed,
        description:
          request.description && request.description.trim().length > 0
            ? request.description.trim()
            : undefined,
        ...(request.tracks && request.tracks.length > 0
          ? { tracks: trackRefs(request.tracks) }
          : {}),
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
        await loadPlaylist(playlistId, "library", { refresh: true });
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
      const normalizedTracks = materializeTracks(tracks);
      const currentQueue = getState().playback.queue;
      const currentIndex = getState().playback.queueIndex;
      if (currentQueue.length === 0) {
        await controller.playTracks(normalizedTracks);
        return;
      }
      // Capture the local snapshot before crossing the provider boundary. A
      // queue event can replace app state while playNext is awaiting, so a
      // post-await read would lose the index that the insertion is relative
      // to when MusicKit does not expose its queue yet.
      const beforeQueue = [...currentQueue];
      const snapshotIndex = Math.max(
        0,
        Math.min(currentIndex, beforeQueue.length - 1),
      );
      const expectedQueue = [...beforeQueue];
      expectedQueue.splice(snapshotIndex + 1, 0, ...normalizedTracks);
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
      const synced = syncMusicKitQueue(
        instance as unknown as MusicKit.MusicKitInstance,
      );
      // MusicKit can acknowledge the operation before publishing its updated
      // queue. Keep the provider snapshot when it contains the requested
      // mutation; otherwise use the captured local snapshot deterministically
      // until queueItemsDidChange reports the authoritative queue.
      if (synced && sameTrackIds(getState().playback.queue, expectedQueue)) {
        return;
      }
      setQueueSnapshot(expectedQueue, snapshotIndex);
    },

    async playLaterTracks(
      tracks: readonly Track[] | readonly string[],
    ): Promise<void> {
      const ids = trackIds(tracks);
      if (ids.length === 0) throw new Error("At least one track is required.");
      const normalizedTracks = materializeTracks(tracks);
      const currentQueue = getState().playback.queue;
      const currentIndex = getState().playback.queueIndex;
      if (currentQueue.length === 0) {
        await controller.playTracks(normalizedTracks);
        return;
      }
      const beforeQueue = [...currentQueue];
      const snapshotIndex = Math.max(
        0,
        Math.min(currentIndex, beforeQueue.length - 1),
      );
      const expectedQueue = [...beforeQueue, ...normalizedTracks];
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
      const synced = syncMusicKitQueue(
        instance as unknown as MusicKit.MusicKitInstance,
      );
      if (synced && sameTrackIds(getState().playback.queue, expectedQueue)) {
        return;
      }
      setQueueSnapshot(expectedQueue, snapshotIndex);
    },

    async playQueueItem(index: number): Promise<void> {
      const instance = requireMusic();
      syncMusicKitQueue(instance);
      const snapshot = getState().playback;
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= snapshot.queue.length
      ) {
        throw new Error("Queue item is unavailable.");
      }
      const queue = snapshot.queue.slice(index);
      setPlaybackStatus("loading");
      try {
        await instance.setQueue(queueOptionsForTracks(queue));
        await instance.play();
        setQueue(queue, 0);
        setCurrentTrack(queue[0], 0);
      } catch (error) {
        const rawMessage = errorMessage(error);
        const message = safeErrorMessage(error);
        setPlaybackError(mapErrorToCode(rawMessage), message);
        log(`Queue item play failed: ${message}`);
        throw error;
      }
    },

    async refreshCurrentData(): Promise<void> {
      const route = getState().navigation;
      switch (route.kind) {
        case "home":
          await loadHome({ refresh: true });
          return;
        case "browse":
          await loadBrowse({ refresh: true });
          return;
        case "radio":
          await loadRadio({ refresh: true });
          return;
        case "library":
          await refreshLibrarySection(route.section as LibrarySection);
          return;
        case "album":
          await loadDetail("album", route.id, route.source ?? "library", {
            refresh: true,
          });
          return;
        case "artist":
          await loadDetail("artist", route.id, route.source ?? "library", {
            refresh: true,
          });
          return;
        case "playlist":
          await loadPlaylist(route.id, route.source ?? "library", {
            refresh: true,
          });
          return;
        case "search":
          await controller.search(route.query);
          return;
        default:
          return;
      }
    },

    setSearchSource(source: "catalog" | "library"): void {
      const search = getState().search;
      const groups = source === "catalog" ? search.catalog : search.library;
      lastSearchSource = source;
      lastSearchTracks = groups.songs;
      setSearchState({
        activeSource: source,
        results: groups.songs,
      });
    },

    async search(term: string): Promise<Track[]> {
      const trimmed = term.trim();
      const requestId = ++searchRequestId;
      setSearchState({
        query: trimmed,
        status: trimmed ? "loading" : "idle",
        results: [],
        catalog: trimmed
          ? {
              ...getState().search.catalog,
              status: "loading",
              error: undefined,
            }
          : {
              songs: [],
              albums: [],
              artists: [],
              playlists: [],
              status: "idle",
            },
        library: trimmed
          ? {
              ...getState().search.library,
              status: "loading",
              error: undefined,
            }
          : {
              songs: [],
              albums: [],
              artists: [],
              playlists: [],
              status: "idle",
            },
        error: undefined,
        requestId,
      });
      if (!trimmed) {
        lastSearchTracks = [];
        return [];
      }
      try {
        const instance = requireMusic();
        const catalogSearch = searchCatalogOverride
          ? searchCatalogOverride(instance, trimmed, { limit: 10 }).then(
              (songs) => ({
                songs,
                albums: [],
                artists: [],
                playlists: [],
              }),
            )
          : searchResources(instance, trimmed, "catalog", { limit: 10 });
        const results = await Promise.allSettled([
          catalogSearch,
          searchResources(instance, trimmed, "library", { limit: 10 }),
        ]);
        if (requestId !== searchRequestId) return [];
        const currentSearch = getState().search;
        // A user can switch source tabs while both requests are in flight.
        // Preserve that selection when the response settles instead of
        // restoring the tab that started the request.
        const selectedSource = currentSearch.activeSource;
        const catalog =
          results[0].status === "fulfilled"
            ? { ...results[0].value, status: "success" as const }
            : {
                ...currentSearch.catalog,
                status: "error" as const,
                error: safeErrorMessage(results[0].reason),
              };
        const library =
          results[1].status === "fulfilled"
            ? { ...results[1].value, status: "success" as const }
            : {
                ...currentSearch.library,
                status: "error" as const,
                error: safeErrorMessage(results[1].reason),
              };
        const groups = selectedSource === "catalog" ? catalog : library;
        const tracks = groups.songs;
        const successful = results.some(
          (result) => result.status === "fulfilled",
        );
        const providerErrors = results
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          .map((result) => safeErrorMessage(result.reason));
        lastSearchSource = selectedSource;
        lastSearchTracks = tracks;
        setSearchState({
          query: trimmed,
          status: successful ? "success" : "error",
          results: tracks,
          catalog,
          library,
          activeSource: selectedSource,
          error: successful ? undefined : providerErrors.join("; "),
          requestId,
        });
        log(`Found ${tracks.length} song${tracks.length === 1 ? "" : "s"}.`);
        return tracks;
      } catch (error) {
        if (requestId !== searchRequestId) return [];
        const message = safeErrorMessage(error);
        const currentSearch = getState().search;
        setSearchState({
          query: trimmed,
          status: "error",
          results: [],
          catalog: {
            ...currentSearch.catalog,
            status: "error",
            error: message,
          },
          library: {
            ...currentSearch.library,
            status: "error",
            error: message,
          },
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
        : lastSearchSource === "catalog"
          ? getState().search.catalog.songs
          : getState().search.library.songs;
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

    async play(): Promise<void> {
      await requireMusic().play();
    },

    async pause(): Promise<void> {
      requireMusic().pause();
    },

    async setShuffleMode(mode: "off" | "songs"): Promise<void> {
      const instance = requireMusic();
      if (!setMusicShuffleMode(instance, mode === "songs")) {
        const modes = readPlaybackModes(instance);
        setPlaybackModes({
          modeCapabilities: { ...modes.capabilities, shuffle: false },
        });
        throw new Error("Shuffle is not available in this MusicKit runtime.");
      }
      const modes = readPlaybackModes(instance);
      setPlaybackModes({
        shuffleMode: modes.shuffleMode,
        repeatMode: modes.repeatMode,
        modeCapabilities: modes.capabilities,
      });
    },

    async cycleRepeatMode(): Promise<void> {
      const instance = requireMusic();
      const current = readPlaybackModes(instance);
      if (!current.capabilities.repeat) {
        throw new Error("Repeat is not available in this MusicKit runtime.");
      }
      const next =
        current.repeatMode === "off"
          ? "all"
          : current.repeatMode === "all"
            ? "one"
            : "off";
      if (!setMusicRepeatMode(instance, next)) {
        setPlaybackModes({
          modeCapabilities: { ...current.capabilities, repeat: false },
        });
        throw new Error(
          "Repeat could not be changed in this MusicKit runtime.",
        );
      }
      const modes = readPlaybackModes(instance);
      setPlaybackModes({
        shuffleMode: modes.shuffleMode,
        repeatMode: modes.repeatMode,
        modeCapabilities: modes.capabilities,
      });
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

    async setVolume(volume: number): Promise<void> {
      const safeVolume = applyPlaybackVolume(volume);
      const settings: AppSettings = {
        ...getState().settings,
        volume: safeVolume,
      };
      setSettings(settings);
      volumeSaveQueue = volumeSaveQueue
        .catch(() => undefined)
        .then(() => savePersistedSettings(settings, invokeFn));
      const save = volumeSaveQueue;
      try {
        await save;
      } catch (error) {
        log(`Settings save failed: ${errorMessage(error)}`);
      }
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
