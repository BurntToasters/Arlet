import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  authorize,
  installAuthPopupProbe,
  isAuthorized,
  unauthorize,
} from "../musickit/auth.ts";
import { initializeMusicKit } from "../musickit/bootstrap.ts";
import { developerTokenExpiry } from "../musickit/token.ts";
import type {
  loadBrowseCharts,
  loadRadioStations,
  searchMusicResources,
  searchCatalogSongs,
} from "../musickit/catalog.ts";
import { registerMusicKitEvents } from "../musickit/events.ts";
import {
  CONSECUTIVE_TRACK_TARGET,
  setAutoplayEnabled,
  syncMusicKitQueue,
} from "../musickit/player.ts";
import { createSleepTimer, type SleepTimerOption } from "./sleep-timer.ts";
import { normalizeTrack } from "../musickit/normalize.ts";
import { classifyPlaybackKind } from "../musickit/preview.ts";
import {
  appendDiagnosticLog,
  DEFAULT_SETTINGS,
  getState,
  resetState,
  setAccountSummary,
  setAuthState,
  setAuthPending,
  setCurrentTrack,
  setDeveloperTokenExpiry,
  setInitializationState,
  setPins,
  setSettings,
  setSleepTimer,
  setUpdateState,
  setUiState,
  setWindowEffectState,
  type AppSettings,
  type LibraryEntity,
  type LibrarySection,
  type ThemePreference,
  type UpdateChannel,
  type WindowEffectPreference,
} from "../state.ts";
import {
  applyWindowEffect,
  darkModeForTheme,
  loadSettings as loadPersistedSettings,
  resetSettings as resetPersistedSettings,
  saveSettings as savePersistedSettings,
  watchSystemTheme,
  type InvokeFunction,
} from "./settings.ts";
import {
  MAX_PINS,
  deletePins as deletePersistedPins,
  loadPins as loadPersistedPins,
  savePins as savePersistedPins,
} from "./pins.ts";
import type {
  MusicSource,
  PinnedPlaylist,
  RatingValue,
  Station,
  Track,
} from "../domain/music.ts";
import { isSameTrack } from "../domain/music.ts";
import type { DiagnosticsStore } from "../diagnostics/store.ts";
import { createSupportReport } from "../diagnostics/support-report.ts";
import type { GateEnvironment } from "../phase0/gate-session.ts";
import { redactSensitive, registerSensitiveValue } from "../platform/redact.ts";
import { createUpdaterService, type UpdaterService } from "../updater.ts";
import {
  createAppleMusicLibraryClient,
  type AppleMusicLibraryClient,
} from "../musickit/library.ts";
import { createLibraryCache, type LibraryCache } from "../library/cache.ts";
import {
  asLibraryEntities,
  asRecord,
  errorMessage,
  libraryMethod,
  safeErrorMessage,
  timestamp,
  trackIds,
  trackRefs,
  type ControllerContext,
} from "./controller-support.ts";
import { createDiscovery } from "./discovery.ts";
import {
  createLibraryLoader,
  type DetailLoadOptions,
} from "./library-loader.ts";
import {
  createCollectionPlayback,
  type CollectionPlayOptions,
} from "./collection-playback.ts";
import { createPlayback } from "./playback.ts";
import type { QueueEditTier } from "../musickit/queue-edit.ts";
import { createRatings, type RatingTarget } from "./ratings.ts";
import { createPlaybackSession } from "./playback-session.ts";
import {
  createTrackNavigationResolver,
  type TrackNavigation,
} from "../musickit/song-navigation.ts";
import { createLyricsLoader, type LyricsResult } from "../musickit/lyrics.ts";

export type { DetailLoadOptions } from "./library-loader.ts";

const VOLUME_SAVE_DELAY_MS = 300;

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
  writeClipboardText?: (text: string) => Promise<void>;
}

export interface AppController {
  initialize(): Promise<void>;
  loadSettings(): Promise<void>;
  loadPins(): Promise<void>;
  authorize(): Promise<void>;
  signOut(): Promise<void>;
  /** Restores default settings and restarts Arlet; sign-in and pins stay. */
  resetSettingsAndRestart(): Promise<void>;
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
  /** Optimistic; a failed request rolls back and reports a toast. */
  rate(target: RatingTarget, value: RatingValue): Promise<void>;
  loadRating(target: RatingTarget): Promise<void>;
  addToLibrary(target: RatingTarget): Promise<void>;
  playNextTracks(tracks: readonly Track[] | readonly string[]): Promise<void>;
  playLaterTracks(tracks: readonly Track[] | readonly string[]): Promise<void>;
  playQueueItem(index: number): Promise<void>;
  removeQueueItem(index: number): Promise<QueueEditTier>;
  moveQueueItem(from: number, to: number): Promise<QueueEditTier>;
  clearUpNext(): Promise<QueueEditTier>;
  saveQueueAsPlaylist(name: string): Promise<LibraryEntity | undefined>;
  refreshCurrentData(): Promise<void>;
  search(term: string): Promise<Track[]>;
  setSearchSource?(source: "catalog" | "library"): void;
  playFromSearch(index: number): Promise<void>;
  playTracks(tracks: readonly Track[], startIndex?: number): Promise<void>;
  playCollection?(
    kind: "playlist" | "album",
    id: string,
    source?: MusicSource,
    startIndex?: number,
    options?: CollectionPlayOptions,
  ): Promise<void>;
  playPlaylist?(
    id: string,
    source?: MusicSource,
    startIndex?: number,
  ): Promise<void>;
  playAlbum?(
    id: string,
    source?: MusicSource,
    startIndex?: number,
  ): Promise<void>;
  resolveTrackNavigation?(track: Track): Promise<TrackNavigation>;
  loadLyrics?(track: Track): Promise<LyricsResult>;
  playConsecutive(): Promise<void>;
  togglePlayback(): Promise<void>;
  play?(): Promise<void>;
  pause?(): Promise<void>;
  setShuffleMode?(mode: "off" | "songs"): Promise<void>;
  cycleRepeatMode?(): Promise<void>;
  setRepeatMode?(mode: "off" | "all" | "one"): Promise<void>;
  /** Pauses when the timer ends; in-memory only, cleared on sign-out. */
  startSleepTimer?(option: SleepTimerOption): void;
  cancelSleepTimer?(): void;
  previous(): Promise<void>;
  next(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  /** Mute silences output and keeps the unmuted level for unmute. */
  toggleMute(): void;
  seekBy(deltaSeconds: number): void;
  adjustVolume(delta: number): void;
  setTheme(theme: ThemePreference): Promise<void>;
  setWindowEffect(preference: WindowEffectPreference): Promise<void>;
  setAutoCheckUpdates(enabled: boolean): Promise<void>;
  /** Rejects when the runtime has no writable autoplay; saves only on success. */
  setAutoplay?(enabled: boolean): Promise<void>;
  setCloseToTray?(enabled: boolean): Promise<void>;
  /** Turning this off deletes the saved queue. */
  setRestoreSession(enabled: boolean): Promise<void>;
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
  /** Copies a redacted support report for bug reports (release builds). */
  copyDiagnosticsReport?(): Promise<void>;
  log(message: string): void;
  dispose(): void;
  readonly consecutiveTrackTarget: number;
}

export interface CreatePlaylistRequest {
  name: string;
  description?: string;
  tracks?: readonly Track[] | readonly string[];
}

/**
 * Composition root for the app: owns MusicKit initialization, auth,
 * settings, pins, playlist edits, and the updater. Library loading,
 * discovery/search, and playback live in their own modules.
 */
export function createAppController(
  dependencies: ControllerDependencies = {},
): AppController {
  const initialize = dependencies.initializeMusicKit ?? initializeMusicKit;
  const invokeFn = dependencies.invokeFn ?? (invoke as InvokeFunction);
  const now = dependencies.now ?? Date.now;
  const diagnosticsStore = dependencies.diagnosticsStore;
  const createLibraryClient =
    dependencies.createLibraryClient ?? createAppleMusicLibraryClient;
  let music: MusicKit.MusicKitInstance | null = null;
  let volumeSaveQueue: Promise<void> = Promise.resolve();
  let volumeSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let volumeSaveWaiters: Array<() => void> = [];
  let restoreAuthProbe: (() => void) | undefined;
  let stopMusicKitEvents: (() => void) | undefined;
  let stopThemeWatcher: (() => void) | undefined;

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

  const requireMusic = (): MusicKit.MusicKitInstance => {
    if (!music) throw new Error("MusicKit is still initializing.");
    return music;
  };

  const context: ControllerContext = {
    requireMusic,
    getMusic: () => music,
    now,
    log,
  };
  const library = createLibraryLoader(
    context,
    dependencies.libraryCache ?? createLibraryCache(),
  );
  const discovery = createDiscovery(context, dependencies);
  const playback = createPlayback(context);
  const ratings = createRatings(context);
  const trackNavigation = createTrackNavigationResolver(requireMusic);
  const lyrics = createLyricsLoader(requireMusic);
  const { requireLibrary, ensureLibraryCache, clearLibraryCache } = library;
  const collections = createCollectionPlayback({
    requireMusic,
    getMusic: () => music,
    requireLibrary,
    playTracks: playback.playTracks,
    setShuffleMode: playback.setShuffleMode,
  });
  const playTracks = (
    tracks: readonly Track[],
    startIndex = 0,
  ): Promise<void> => {
    collections.invalidate();
    return playback.playTracks(tracks, startIndex);
  };
  const playCollection = collections.play;
  const playbackSession = createPlaybackSession({
    invokeFn,
    now,
    log,
    playTracks,
    seek: playback.seek,
  });
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

  const persistSettings = async (settings: AppSettings): Promise<void> => {
    setSettings(settings);
    try {
      await savePersistedSettings(settings, invokeFn);
    } catch (error) {
      log(`Settings save failed: ${errorMessage(error)}`);
    }
  };

  const sleepTimer = createSleepTimer({
    pause: () => music?.pause(),
    setState: setSleepTimer,
    readPlayback: () => getState().playback,
  });

  /** Pushes the saved autoplay preference to MusicKit once it is available. */
  const applyAutoplaySetting = (instance: MusicKit.MusicKitInstance): void => {
    playback.syncPlaybackModes(instance);
    if (!getState().playback.modeCapabilities?.autoplay) return;
    if (!setAutoplayEnabled(instance, getState().settings.autoplay)) {
      log("Autoplay setting could not be applied in this MusicKit runtime.");
    }
    playback.syncPlaybackModes(instance);
  };

  /** Saves the latest settings once a volume drag settles. */
  const flushVolumeSave = (): void => {
    volumeSaveTimer = undefined;
    const waiters = volumeSaveWaiters;
    volumeSaveWaiters = [];
    const settings = getState().settings;
    volumeSaveQueue = volumeSaveQueue
      .then(() => savePersistedSettings(settings, invokeFn))
      .catch((error: unknown) => {
        log(`Settings save failed: ${errorMessage(error)}`);
      });
    void volumeSaveQueue.then(() => {
      for (const resolve of waiters) resolve();
    });
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
    const current = snapshot.playback.current;
    const catalogTrack =
      snapshot.playback.queue.find((track) => isSameTrack(track, current)) ??
      discovery
        .lastSearchTracks()
        .find((track) => isSameTrack(track, current)) ??
      current;
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
    playbackSession.start();
    setInitializationState({ status: "loading" });
    log("Initializing MusicKit…");
    try {
      const instance = await initialize();
      music = instance;
      registerSensitiveValue(instance.developerToken);
      setDeveloperTokenExpiry(developerTokenExpiry(instance.developerToken));
      registerSensitiveValue(instance.musicUserToken);
      playback.applyPlaybackVolume(getState().settings.volume);
      try {
        library.setClient(createLibraryClient(instance));
      } catch (error) {
        // Some preview/test instances intentionally omit the catalog API. Keep
        // playback and authorization usable; library actions will report the
        // narrower capability error when invoked.
        library.setClient(null);
        log(
          `Library API unavailable until MusicKit catalog is ready: ${safeErrorMessage(error)}`,
        );
      }
      stopMusicKitEvents?.();
      stopMusicKitEvents = undefined;
      if (typeof instance.addEventListener === "function") {
        stopMusicKitEvents = registerMusicKitEvents(
          instance,
          () => {
            sleepTimer.observe(getState().playback);
            syncPlaybackDiagnostics();
            // Loads ratings only when the now-playing track changes.
            ratings.syncCurrentTrack();
          },
          (message) => {
            log(`Media playback error: ${message}`);
          },
          undefined,
          () => playback.syncPlaybackModes(instance),
        );
        playback.syncPlaybackModes(instance);
      }
      syncMusicKitQueue(instance);
      applyAutoplaySetting(instance);
      restoreAuthProbe = installAuthPopupProbe(log);
      setInitializationState({ status: "ready" });
      log("MusicKit initialized successfully.");
      if (isAuthorized(instance)) {
        setAuthState({ status: "authorized" });
        const cachePromise = ensureLibraryCache();
        const storefront = String(instance.storefrontId ?? "").trim();
        const nowPlaying = instance.nowPlayingItem
          ? normalizeTrack(instance.nowPlayingItem)
          : undefined;
        if (nowPlaying) setCurrentTrack(nowPlaying);
        await cachePromise;
        if (storefront) setAccountSummary({ storefront });
        log("Already authorized from previous session.");
      }
      // Not awaited: a restored queue must never hold up the update check.
      playbackSession.tryRestore();
      syncPlaybackDiagnostics();
      ratings.syncCurrentTrack();
    } catch (error) {
      const message = safeErrorMessage(error);
      setInitializationState({ status: "error", message });
      log(`MusicKit init failed: ${message}`);
      if (await library.enterOfflineMode()) {
        log("Showing the cached library offline.");
      }
    }
  };

  const controller: AppController = {
    initialize: initializeController,

    async loadSettings(): Promise<void> {
      const settings = await loadPersistedSettings(invokeFn);
      setSettings(settings);
      playbackSession.markSettingsLoaded();
      playback.applyPlaybackVolume(settings.volume);
      if (music) applyAutoplaySetting(music);
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
        // The saved queue may belong to the previous account, so drop it too.
        const [, , userToken] = await Promise.all([
          clearLibraryCache(),
          playbackSession.clear(),
          authorize(instance),
        ]);
        registerSensitiveValue(userToken);
        // Keep the user token private to MusicKit; only expose auth status.
        setAuthState({ status: "authorized" });
        try {
          if (!library.client()) {
            library.setClient(createLibraryClient(instance));
          }
        } catch (error) {
          library.setClient(null);
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

    async resetSettingsAndRestart(): Promise<void> {
      // A debounced volume save would write the old settings back after the
      // reset, so drop it and let any save already running finish first.
      if (volumeSaveTimer !== undefined) {
        clearTimeout(volumeSaveTimer);
        volumeSaveTimer = undefined;
      }
      const waiters = volumeSaveWaiters;
      volumeSaveWaiters = [];
      for (const resolve of waiters) resolve();
      await volumeSaveQueue;
      log("Resetting settings to defaults and restarting.");
      await resetPersistedSettings(invokeFn);
    },

    async signOut(): Promise<void> {
      collections.invalidate();
      // A timer armed for this account must not pause the next sign-in.
      sleepTimer.cancel();
      try {
        const instance = requireMusic();
        // Sign-out resets the UI to idle; audio must not keep playing.
        try {
          instance.stop?.();
        } catch (error) {
          log(`Stop before sign-out failed: ${safeErrorMessage(error)}`);
        }
        await unauthorize(instance);
        trackNavigation.clear();
        lyrics.clear();
        await clearLibraryCache();
        // Pins are local and not tied to an Apple ID; the next account to
        // sign in on this PC must not see them.
        try {
          await deletePersistedPins(invokeFn);
        } catch (error) {
          log(`Pinned playlists clear failed: ${safeErrorMessage(error)}`);
        }
        await playbackSession.clear();
        discovery.resetSearch();
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

    loadLibrarySection: library.loadLibrarySection,

    loadMoreLibrarySection: library.loadMoreLibrarySection,

    refreshLibrarySection: library.refreshLibrarySection,

    loadHome: library.loadHome,

    loadBrowse: discovery.loadBrowse,

    loadRadio: discovery.loadRadio,

    playStation(station: Station): Promise<void> {
      collections.invalidate();
      return playback.playStation(station);
    },

    loadAlbum(
      id: string,
      source: MusicSource = "library",
      options: DetailLoadOptions = {},
    ): Promise<void> {
      return library.loadDetail("album", id, source, options);
    },

    loadArtist(
      id: string,
      source: MusicSource = "library",
      options: DetailLoadOptions = {},
    ): Promise<void> {
      return library.loadDetail("artist", id, source, options);
    },

    loadPlaylist: library.loadPlaylist,

    loadPlaylistFolder: library.loadPlaylistFolder,

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
      await library.refreshPlaylistsAfterMutation(
        "Playlist list refresh failed after create",
      );
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
      await library.refreshPlaylistsAfterMutation(
        "Playlist list refresh failed after folder create",
      );
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
        await library.loadPlaylist(playlistId, "library", { refresh: true });
      } catch (error) {
        log(
          `Playlist refresh failed after adding tracks: ${safeErrorMessage(error)}`,
        );
      }
    },

    rate(target: RatingTarget, value: RatingValue): Promise<void> {
      return ratings.rate(target, value);
    },

    loadRating(target: RatingTarget): Promise<void> {
      return ratings.loadRating(target);
    },

    addToLibrary(target: RatingTarget): Promise<void> {
      return ratings.addToLibrary(target);
    },

    playNextTracks(
      tracks: readonly Track[] | readonly string[],
    ): Promise<void> {
      collections.invalidate();
      return playback.playNextTracks(tracks);
    },

    playLaterTracks(
      tracks: readonly Track[] | readonly string[],
    ): Promise<void> {
      collections.invalidate();
      return playback.playLaterTracks(tracks);
    },

    playQueueItem(index: number): Promise<void> {
      collections.invalidate();
      return playback.playQueueItem(index);
    },

    removeQueueItem(index: number): Promise<QueueEditTier> {
      collections.invalidate();
      return playback.removeQueueItem(index);
    },

    moveQueueItem(from: number, to: number): Promise<QueueEditTier> {
      collections.invalidate();
      return playback.moveQueueItem(from, to);
    },

    clearUpNext(): Promise<QueueEditTier> {
      collections.invalidate();
      return playback.clearUpNext();
    },

    saveQueueAsPlaylist(name: string): Promise<LibraryEntity | undefined> {
      return controller.createPlaylist(
        name,
        undefined,
        getState().playback.queue,
      );
    },

    async refreshCurrentData(): Promise<void> {
      const route = getState().navigation;
      switch (route.kind) {
        case "home":
          await library.loadHome({ refresh: true });
          return;
        case "browse":
          await discovery.loadBrowse({ refresh: true });
          return;
        case "radio":
          await discovery.loadRadio({ refresh: true });
          return;
        case "library":
          await library.refreshLibrarySection(route.section as LibrarySection);
          return;
        case "album":
        case "artist":
          await library.loadDetail(
            route.kind,
            route.id,
            route.source ?? "library",
            { refresh: true },
          );
          return;
        case "playlist":
          await library.loadPlaylist(route.id, route.source ?? "library", {
            refresh: true,
          });
          return;
        case "search":
          await discovery.search(route.query);
          return;
        default:
          return;
      }
    },

    setSearchSource: discovery.setSearchSource,

    search: discovery.search,

    async playFromSearch(index: number): Promise<void> {
      await playTracks(discovery.searchTracks().slice(Math.max(0, index)));
    },

    playTracks,
    playCollection: (kind, id, source = "library", startIndex = 0, options) =>
      playCollection(kind, id, source, startIndex, options),
    playPlaylist: (id, source = "library", startIndex = 0) =>
      playCollection("playlist", id, source, startIndex),
    playAlbum: (id, source = "library", startIndex = 0) =>
      playCollection("album", id, source, startIndex),
    resolveTrackNavigation: trackNavigation.resolve,

    loadLyrics: lyrics.load,

    async playConsecutive(): Promise<void> {
      const lastTracks = discovery.lastSearchTracks();
      const tracks = lastTracks.length ? lastTracks : getState().search.results;
      if (tracks.length < CONSECUTIVE_TRACK_TARGET) {
        throw new Error(
          `Need at least ${CONSECUTIVE_TRACK_TARGET} search results.`,
        );
      }
      await playTracks(tracks.slice(0, CONSECUTIVE_TRACK_TARGET));
    },

    async togglePlayback(): Promise<void> {
      if (await playbackSession.resumePendingRestore()) return;
      return playback.togglePlayback();
    },

    async play(): Promise<void> {
      if (await playbackSession.resumePendingRestore()) return;
      return playback.play();
    },

    pause: playback.pause,

    setShuffleMode: playback.setShuffleMode,

    cycleRepeatMode: playback.cycleRepeatMode,

    setRepeatMode: playback.setRepeatMode,

    previous: playback.previous,

    next: playback.next,

    seek: playback.seek,

    toggleMute(): void {
      playback.toggleMute();
    },

    seekBy(deltaSeconds: number): void {
      const { current, positionSeconds, durationSeconds } = getState().playback;
      if (!current || durationSeconds <= 0) return;
      const target = Math.min(
        durationSeconds,
        Math.max(0, positionSeconds + deltaSeconds),
      );
      // seek() logs its own failure, so shortcuts stay silent.
      void playback.seek(target).catch(() => undefined);
    },

    adjustVolume(delta: number): void {
      const level = getState().playback.volume + delta;
      void controller
        .setVolume(Math.round(level * 100) / 100)
        .catch(() => undefined);
    },

    async setVolume(volume: number): Promise<void> {
      const safeVolume = playback.applyPlaybackVolume(volume);
      setSettings({ ...getState().settings, volume: safeVolume });
      // Slider input fires many times a second; the audio follows each one,
      // but settings are written once the drag settles.
      if (volumeSaveTimer !== undefined) clearTimeout(volumeSaveTimer);
      volumeSaveTimer = setTimeout(flushVolumeSave, VOLUME_SAVE_DELAY_MS);
      await new Promise<void>((resolve) => volumeSaveWaiters.push(resolve));
    },

    async setTheme(theme: ThemePreference): Promise<void> {
      await persistSettings({ ...getState().settings, theme });
      await applyCurrentEffect();
    },

    async setWindowEffect(preference: WindowEffectPreference): Promise<void> {
      await persistSettings({
        ...getState().settings,
        windowEffect: preference,
      });
      await applyCurrentEffect();
    },

    async setAutoCheckUpdates(enabled: boolean): Promise<void> {
      const settings: AppSettings = {
        ...getState().settings,
        autoCheckUpdates: enabled,
      };
      setSettings(settings);
      updater.configure(settings);
      await persistSettings(settings);
    },

    async setAutoplay(enabled: boolean): Promise<void> {
      const instance = requireMusic();
      if (!setAutoplayEnabled(instance, enabled)) {
        playback.syncPlaybackModes(instance);
        throw new Error("Autoplay is not available in this MusicKit runtime.");
      }
      playback.syncPlaybackModes(instance);
      await persistSettings({ ...getState().settings, autoplay: enabled });
    },

    async setCloseToTray(enabled: boolean): Promise<void> {
      await persistSettings({ ...getState().settings, closeToTray: enabled });
    },

    startSleepTimer(option: SleepTimerOption): void {
      sleepTimer.start(option);
      log(
        option.mode === "minutes"
          ? `Sleep timer set for ${option.minutes} minutes.`
          : "Sleep timer set for the end of the track.",
      );
    },

    cancelSleepTimer(): void {
      sleepTimer.cancel();
    },

    async setRestoreSession(enabled: boolean): Promise<void> {
      await persistSettings({
        ...getState().settings,
        restoreSession: enabled,
      });
      if (!enabled) await playbackSession.clear();
    },

    async setUpdateChannel(channel: UpdateChannel): Promise<void> {
      const settings: AppSettings = {
        ...getState().settings,
        updateChannel: channel,
      };
      setSettings(settings);
      updater.configure(settings);
      await persistSettings(settings);
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

    async copyDiagnosticsReport(): Promise<void> {
      if (!diagnosticsStore) {
        throw new Error("Diagnostics are unavailable in this session.");
      }
      const write = dependencies.writeClipboardText ?? writeText;
      await write(createSupportReport(diagnosticsStore.getSnapshot()));
      log("Diagnostics report copied to the clipboard.");
    },

    log,

    dispose(): void {
      playbackSession.stop();
      collections.invalidate();
      sleepTimer.cancel();
      trackNavigation.clear();
      lyrics.clear();
      if (volumeSaveTimer !== undefined) {
        clearTimeout(volumeSaveTimer);
        flushVolumeSave();
      }
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
