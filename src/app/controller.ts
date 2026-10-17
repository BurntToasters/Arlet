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
  loadRadioStations,
  searchMusicResources,
  searchCatalogSongs,
} from "../musickit/catalog.ts";
import type { BrowseShelfKind, loadBrowseCharts } from "../musickit/browse.ts";
import { safeNextPath } from "../musickit/response.ts";
import { registerMusicKitEvents } from "../musickit/events.ts";
import type { SearchGroupKind } from "../musickit/search.ts";
import {
  loadCuratorPage,
  loadCuratorPlaylistsPage,
  loadPlaylistCurator,
  type CuratorPage,
  type CuratorPlaylistsPage,
  type PlaylistCuratorRef,
} from "../musickit/curators.ts";
import type { CuratorKind } from "../routing/router.ts";
import { syncMusicKitQueue } from "../musickit/player.ts";
import {
  createStationResolver,
  type StationTarget,
} from "../musickit/stations.ts";
import { createSleepTimer, type SleepTimerOption } from "./sleep-timer.ts";
import { createAutoSkip } from "./auto-skip.ts";
import { reportActionError } from "../components/action-errors.ts";
import { normalizeTrack } from "../musickit/normalize.ts";
import { classifyPlaybackKind } from "../musickit/preview.ts";
import {
  appendDiagnosticLog,
  clearRecentSearches,
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
  subscribePlaybackPosition,
  type LibraryEntity,
  type LibrarySection,
  type ThemePreference,
  type UpdateChannel,
  type WindowEffectPreference,
} from "../state.ts";
import type { InvokeFunction } from "./settings.ts";
import type {
  MusicSource,
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
  errorMessage,
  safeErrorMessage,
  timestamp,
  type ControllerContext,
} from "./controller-support.ts";
import { createDiscovery } from "./discovery.ts";
import {
  createLibraryLoader,
  type DetailLoadOptions,
} from "./library-loader.ts";
import {
  createCollectionPlayback,
  loadAllTracks,
  type CollectionPlayOptions,
} from "./collection-playback.ts";
import { createPlayback } from "./playback.ts";
import type { QueueEditTier } from "../musickit/queue-edit.ts";
import { createRatings, type RatingTarget } from "./ratings.ts";
import {
  createPlaylistEditing,
  type CreatePlaylistRequest,
} from "./playlist-editing.ts";
import { createPlaybackSession } from "./playback-session.ts";
import { createControllerPins } from "./controller-pins.ts";
import { createControllerSettings } from "./controller-settings.ts";
import {
  createTrackNavigationResolver,
  type TrackNavigation,
} from "../musickit/song-navigation.ts";

export type { DetailLoadOptions } from "./library-loader.ts";

/** A clipboard write still pending after this is reported as failed. */
const CLIPBOARD_WRITE_TIMEOUT_MS = 5_000;
/** Longest wait for the queue save before an update installs (as tray.rs). */
const QUIT_SAVE_TIMEOUT_MS = 1_500;

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
  loadBrowse(options?: { refresh?: boolean; genreId?: string }): Promise<void>;
  loadMoreBrowseShelf(kind: BrowseShelfKind): Promise<void>;
  loadRadio(options?: { refresh?: boolean }): Promise<void>;
  loadRadioGenre(genreId: string): Promise<void>;
  loadCurator(id: string, kind: CuratorKind): Promise<CuratorPage>;
  loadMoreCuratorPlaylists(next: string): Promise<CuratorPlaylistsPage>;
  loadPlaylistCurator(
    playlistId: string,
  ): Promise<PlaylistCuratorRef | undefined>;
  playStation(station: Station): Promise<void>;
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
  /** `trackId` guards against the queue shifting before the remove runs. */
  removeQueueItem(index: number, trackId?: string): Promise<QueueEditTier>;
  /** `trackId` guards against the queue shifting before the move runs. */
  moveQueueItem(
    from: number,
    to: number,
    trackId?: string,
  ): Promise<QueueEditTier>;
  clearUpNext(): Promise<QueueEditTier>;
  refreshCurrentData(): Promise<void>;
  search(term: string): Promise<Track[]>;
  /** Typeahead for the Search field; terms under two characters clear it. */
  suggestSearch(term: string): Promise<void>;
  /** Appends the next "See all" page of one catalog group. */
  loadMoreSearch(kind: SearchGroupKind): Promise<void>;
  setSearchSource(source: "catalog" | "library"): void;
  playFromSearch(index: number): Promise<void>;
  playTracks(tracks: readonly Track[], startIndex?: number): Promise<void>;
  /** Plays the tracks in shuffled order. */
  playTracksShuffled(tracks: readonly Track[]): Promise<void>;
  /** Looks up the song or artist station and plays it; throws if none. */
  startStation(target: StationTarget): Promise<void>;
  /** Loads every page, then inserts after the current song or at the end. */
  queueCollection(
    kind: "playlist" | "album",
    id: string,
    source: MusicSource,
    where: "next" | "later",
  ): Promise<void>;
  loadArtistTopSongs(
    id: string,
    source: MusicSource,
    catalogId?: string,
  ): Promise<Track[]>;
  playCollection(
    kind: "playlist" | "album",
    id: string,
    source?: MusicSource,
    startIndex?: number,
    options?: CollectionPlayOptions,
  ): Promise<void>;
  /** `trackId` is the song at `startIndex` when the user picked it. */
  playPlaylist(
    id: string,
    source?: MusicSource,
    startIndex?: number,
    trackId?: string,
  ): Promise<void>;
  playAlbum(
    id: string,
    source?: MusicSource,
    startIndex?: number,
    trackId?: string,
  ): Promise<void>;
  resolveTrackNavigation(track: Track): Promise<TrackNavigation>;
  /** Saves the queue position and pending settings before Arlet quits. */
  prepareToQuit(): Promise<void>;
  /** Every queued song, including the rest of a long playlist still to come. */
  fullQueue(): Track[];
  togglePlayback(): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  setShuffleMode(mode: "off" | "songs"): Promise<void>;
  cycleRepeatMode(): Promise<void>;
  setRepeatMode(mode: "off" | "all" | "one"): Promise<void>;
  /** Pauses when the timer ends; in-memory only, cleared on sign-out. */
  startSleepTimer(option: SleepTimerOption): void;
  cancelSleepTimer(): void;
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
  setAutoplay(enabled: boolean): Promise<void>;
  setTrayIcon(enabled: boolean): Promise<void>;
  /** Saving it switches the native log file on or off at once. */
  setDebugMode(enabled: boolean): Promise<void>;
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
  copyDiagnosticsReport(): Promise<void>;
  /** Copies plain text through the same writer and timeout as the report. */
  copyText(text: string): Promise<void>;
  log(message: string): void;
  dispose(): void;
}

export type { CreatePlaylistRequest } from "./playlist-editing.ts";

/**
 * Writes to the clipboard. Another app holding the clipboard can leave the
 * write pending with no error, so a write still pending after the timeout
 * fails with `busyMessage` instead of never settling.
 */
async function writeClipboardWithTimeout(
  write: (text: string) => Promise<void>,
  text: string,
  busyMessage: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      write(text),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(busyMessage)),
          CLIPBOARD_WRITE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  let restoreAuthProbe: (() => void) | undefined;
  let stopMusicKitEvents: (() => void) | undefined;

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
  const playlists = createPlaylistEditing(context, library);
  const pinning = createControllerPins(context, {
    invokeFn,
    libraryClient: () => library.client(),
  });
  const trackNavigation = createTrackNavigationResolver(requireMusic);
  const { requireLibrary, ensureLibraryCache, clearLibraryCache } = library;
  const collections = createCollectionPlayback({
    requireMusic,
    getMusic: () => music,
    requireLibrary,
    playTracks: playback.playTracks,
    setShuffleMode: playback.setShuffleMode,
    continuationToken: playback.continuationToken,
    appendContinuation: playback.appendContinuation,
    log,
  });
  // A pause, including toggling a playing queue to pause, stops any playlist
  // or station still loading so it cannot start after the pause.
  const stopPauseListener = playback.onPause(() => collections.invalidate());
  const playTracks = (
    tracks: readonly Track[],
    startIndex = 0,
  ): Promise<void> => {
    collections.invalidate();
    return playback.playTracks(tracks, startIndex).then(() => undefined);
  };
  const playCollection = collections.play;
  let stationResolver:
    | {
        instance: MusicKit.MusicKitInstance;
        resolver: ReturnType<typeof createStationResolver>;
      }
    | undefined;
  /** Lookups are cached per MusicKit instance and dropped on sign-out. */
  const stations = (): ReturnType<typeof createStationResolver> => {
    const instance = requireMusic();
    if (stationResolver?.instance !== instance) {
      stationResolver = { instance, resolver: createStationResolver(instance) };
    }
    return stationResolver.resolver;
  };
  const playbackSession = createPlaybackSession({
    invokeFn,
    now,
    log,
    playTracks,
    seek: playback.seek,
    playIntent: playback.playIntent,
    fullQueue: playback.fullQueue,
  });
  const updater =
    dependencies.updater ??
    createUpdaterService({
      onStateChange: setUpdateState,
      onLog: log,
      now,
    });

  const preferences = createControllerSettings(context, {
    invokeFn,
    playback,
    playbackSession,
    configureUpdater: (settings) => {
      updater.configure(settings);
    },
    loadPins: () => pinning.reload(),
  });

  const autoSkip = createAutoSkip({
    readPlayback: () => getState().playback,
    skipToNext: () => playback.next(),
    notify: (message) => reportActionError(new Error(message)),
    log,
  });

  const sleepTimer = createSleepTimer({
    pause: () => {
      if (!music) return;
      void playback.pause().catch((error: unknown) => {
        log(`Sleep timer pause failed: ${safeErrorMessage(error)}`);
      });
    },
    setState: setSleepTimer,
    readPlayback: () => getState().playback,
  });
  // Position ticks do not reach the MusicKit state callback, so the timer also
  // checks on each tick to catch a same-track restart and a late minutes timer.
  const stopSleepTimerPositions = subscribePlaybackPosition(() =>
    sleepTimer.observe(getState().playback),
  );

  /** Bumped on sign-in and sign-out; work started earlier must not land. */
  let accountGeneration = 0;
  /** Sign-out work in progress, whose MusicKit auth events are our own. */
  let accountTransitions = 0;

  /**
   * Cancels everything tied to the current account. Sign-in runs it too,
   * because the popup may sign in a different Apple ID.
   */
  const resetAccountScope = (): void => {
    accountGeneration += 1;
    collections.invalidate();
    ratings.reset();
    discovery.resetAccount();
    playback.cancelPendingPlayback();
    // A timer armed for this account must not pause the next sign-in.
    sleepTimer.cancel();
    playback.clearContinuation();
    // Library artist mappings belong to the previous account.
    stationResolver = undefined;
    trackNavigation.clear();
  };

  /**
   * Local sign-out: drops the account's cached library, pins, and saved queue.
   * It never calls Apple, so it also serves a session Apple already ended.
   */
  const clearSignedInData = async (): Promise<void> => {
    await clearLibraryCache();
    // Pins are local and not tied to an Apple ID; the next account to
    // sign in on this PC must not see them.
    await pinning.clearStored();
    await playbackSession.clear();
    // Recent searches belong to the signed-in account, so sign-out (and a
    // revoked session) is what clears them; sign-in does not.
    clearRecentSearches();
    discovery.resetAccount();
    resetState();
    setPins([]);
    setInitializationState({ status: "ready" });
  };

  /**
   * Runs the local sign-out for a session MusicKit no longer authorizes. No
   * request goes to Apple, since the session is already gone.
   */
  const endSessionFromMusicKit = async (
    instance: MusicKit.MusicKitInstance,
  ): Promise<void> => {
    accountTransitions += 1;
    try {
      resetAccountScope();
      try {
        instance.stop?.();
      } catch (error) {
        log(`Stop after revoked session failed: ${safeErrorMessage(error)}`);
      }
      await clearSignedInData();
      log("Apple Music reports the session is no longer authorized.");
    } catch (error) {
      log(`Local sign-out failed: ${safeErrorMessage(error)}`);
    } finally {
      accountTransitions -= 1;
    }
  };

  /**
   * MusicKit reports a revoked token or a sign-out from elsewhere. The app
   * then runs its local sign-out and shows the signed-out UI. Our own sign-in
   * and sign-out are ignored here because they update the state themselves.
   * A sign-in from elsewhere is left to the sign-in flow.
   */
  const onMusicKitAuthorizationChange = (
    instance: MusicKit.MusicKitInstance,
  ): void => {
    if (accountTransitions > 0 || getState().auth.pending) return;
    if (typeof instance.isAuthorized !== "boolean") return;
    if (isAuthorized(instance)) return;
    if (getState().auth.status !== "authorized") return;
    void endSessionFromMusicKit(instance);
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
    // Opens the SQLite cache during MusicKit configure. Nothing is shown from
    // it here: the account is unknown until configure finishes.
    void library.openLibraryCache();
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
            if (getState().playback.status === "playing") autoSkip.onPlaying();
            playback.maybeRefillQueue();
            sleepTimer.observe(getState().playback);
            syncPlaybackDiagnostics();
            // Loads ratings only when the now-playing track changes.
            ratings.syncCurrentTrack();
          },
          (message, error) => {
            log(`Media playback error: ${message}`);
            autoSkip.onPlaybackError(error);
          },
          undefined,
          () => playback.syncPlaybackModes(instance),
          {
            onAuthorizationChange: () =>
              onMusicKitAuthorizationChange(instance),
            onMusicVolumeChange: (volume) => {
              if (!playback.reflectMusicVolume(volume)) return;
              // Saved on the same debounce as a drag, so it survives a restart.
              preferences.scheduleVolumeSave();
            },
          },
        );
        playback.syncPlaybackModes(instance);
      }
      syncMusicKitQueue(instance);
      preferences.applyAutoplaySetting(instance);
      restoreAuthProbe = installAuthPopupProbe(log);
      setInitializationState({ status: "ready" });
      log("MusicKit initialized successfully.");
      // Saved recents with no signed-in account belong to a session that
      // ended, so they are not carried into the next sign-in.
      if (!isAuthorized(instance)) clearRecentSearches();
      if (isAuthorized(instance)) {
        setAuthState({ status: "authorized" });
        const cachePromise = ensureLibraryCache();
        const storefront = String(instance.storefrontId ?? "").trim();
        const nowPlaying = instance.nowPlayingItem
          ? normalizeTrack(instance.nowPlayingItem)
          : undefined;
        if (nowPlaying) setCurrentTrack(nowPlaying);
        // The saved queue restores now rather than after the cache metadata
        // read; it is applied only to this authorized account.
        playbackSession.tryRestore();
        await cachePromise;
        if (storefront) setAccountSummary({ storefront });
        log("Already authorized from previous session.");
        void pinning.resolveDetails();
      }
      // Not awaited: a restored queue must never hold up the update check.
      playbackSession.tryRestore();
      syncPlaybackDiagnostics();
      ratings.syncCurrentTrack();
    } catch (error) {
      const message = safeErrorMessage(error);
      setInitializationState({ status: "error", message });
      log(`MusicKit init failed: ${message}`);
      // An expired embedded token is not a connection problem: show the
      // update notice instead of an offline banner whose Reconnect never works.
      if ((error as { code?: unknown } | null)?.code === "TOKEN_EXPIRED") {
        setDeveloperTokenExpiry(now());
        return;
      }
      if (await library.enterOfflineMode()) {
        log("Showing the cached library offline.");
      }
    }
  };

  const controller: AppController = {
    initialize: initializeController,

    loadSettings: preferences.loadSettings,

    async loadPins(): Promise<void> {
      await pinning.reload();
    },

    async authorize(): Promise<void> {
      if (getState().auth.pending) return;
      let authorizationStarted = false;
      try {
        const instance = requireMusic();
        authorizationStarted = true;
        setAuthPending(true);
        resetAccountScope();
        // A fresh authorization may belong to a different Apple account. Drop
        // the previous session's metadata before MusicKit opens its popup.
        log("Authorizing… waiting for Apple Music sign-in window.");
        const userToken = await authorize(instance);
        registerSensitiveValue(userToken);
        // The cached library and saved queue may belong to the previous
        // account. They are dropped only once sign-in succeeds, so closing
        // the sign-in window keeps them; the new account's data loads after
        // this, once auth is marked authorized below.
        await Promise.all([clearLibraryCache(), playbackSession.clear()]);
        // Keep the user token private to MusicKit; only expose auth status.
        setAuthState({ status: "authorized" });
        // A lookup made while the popup was open used the old sign-in; look
        // the playing song's rating up again for the new one.
        ratings.reset();
        ratings.syncCurrentTrack();
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
        await Promise.all([ensureLibraryCache(), pinning.reload()]);
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

    resetSettingsAndRestart: preferences.resetSettingsAndRestart,

    async signOut(): Promise<void> {
      accountTransitions += 1;
      try {
        // Late responses from this account must not land after sign-out.
        resetAccountScope();
        try {
          const instance = requireMusic();
          // Sign-out resets the UI to idle; audio must not keep playing.
          try {
            instance.stop?.();
          } catch (error) {
            log(`Stop before sign-out failed: ${safeErrorMessage(error)}`);
          }
          await unauthorize(instance);
          await clearSignedInData();
          log("Signed out.");
        } catch (error) {
          const message = safeErrorMessage(error);
          log(`Sign out failed: ${message}`);
          throw error;
        }
      } finally {
        accountTransitions -= 1;
      }
    },

    // An invalid cursor is treated as no more pages, so nothing is requested.
    loadLibrarySection: (section, options) => {
      if (options?.cursor === undefined) {
        return library.loadLibrarySection(section, options);
      }
      const cursor = safeNextPath(options.cursor, ["/v1/me/"]);
      return cursor
        ? library.loadLibrarySection(section, { ...options, cursor })
        : Promise.resolve();
    },

    loadMoreLibrarySection: (section, cursor) => {
      if (cursor === undefined) return library.loadMoreLibrarySection(section);
      const next = safeNextPath(cursor, ["/v1/me/"]);
      return next
        ? library.loadMoreLibrarySection(section, next)
        : Promise.resolve();
    },

    refreshLibrarySection: library.refreshLibrarySection,

    loadHome: library.loadHome,

    loadBrowse: discovery.loadBrowse,

    loadMoreBrowseShelf: discovery.loadMoreBrowseShelf,

    loadRadio: discovery.loadRadio,

    loadRadioGenre: discovery.loadRadioGenre,
    loadCurator: (id, kind) => loadCuratorPage(requireMusic(), id, kind),
    loadMoreCuratorPlaylists: (next) => {
      const cursor = safeNextPath(next, ["/v1/catalog/"]);
      return cursor
        ? loadCuratorPlaylistsPage(requireMusic(), cursor)
        : Promise.resolve({ playlists: [] });
    },
    loadPlaylistCurator: (playlistId) =>
      loadPlaylistCurator(requireMusic(), playlistId),

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

    togglePin: pinning.togglePin,

    unpin: pinning.unpin,

    isPinned(id: string): boolean {
      return getState().pins.some((pin) => pin.id === id);
    },

    searchPlaylists: playlists.searchPlaylists,

    createPlaylist: playlists.createPlaylist,

    createPlaylistFolder: playlists.createPlaylistFolder,

    addTracksToPlaylist: playlists.addTracksToPlaylist,

    rate(target: RatingTarget, value: RatingValue): Promise<void> {
      return ratings.rate(target, value);
    },

    loadRating(target: RatingTarget): Promise<void> {
      return ratings.loadRating(target);
    },

    async addToLibrary(target: RatingTarget): Promise<void> {
      const section = await ratings.addToLibrary(target);
      // Show the new item in Library without waiting for a manual refresh.
      if (section) {
        void library.refreshLibrarySection(section).catch((error: unknown) => {
          log(`Library refresh after add failed: ${safeErrorMessage(error)}`);
        });
      }
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

    removeQueueItem(index: number, trackId?: string): Promise<QueueEditTier> {
      collections.invalidate();
      return playback.removeQueueItem(index, trackId);
    },

    moveQueueItem(
      from: number,
      to: number,
      trackId?: string,
    ): Promise<QueueEditTier> {
      collections.invalidate();
      return playback.moveQueueItem(from, to, trackId);
    },

    clearUpNext(): Promise<QueueEditTier> {
      collections.invalidate();
      return playback.clearUpNext();
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
    suggestSearch: discovery.suggestSearch,
    loadMoreSearch: discovery.loadMoreSearch,

    async playFromSearch(index: number): Promise<void> {
      await playTracks(discovery.searchTracks().slice(Math.max(0, index)));
    },

    playTracks,
    playTracksShuffled: collections.playShuffled,
    async startStation(target: StationTarget): Promise<void> {
      collections.invalidate();
      const mine = collections.generation();
      const instance = requireMusic();
      const superseded = (): boolean =>
        collections.generation() !== mine || instance !== music;
      let station: Station | undefined;
      try {
        station = await stations().stationFor(target);
      } catch (error) {
        // A lookup the user already replaced must not surface its failure.
        if (superseded()) return;
        throw error;
      }
      // Other playback may have started while the lookup was pending.
      if (superseded()) return;
      if (!station) {
        throw new Error(`No station is available for this ${target.kind}.`);
      }
      await playback.playStation(station);
    },
    async queueCollection(kind, id, source, where): Promise<void> {
      const instance = requireMusic();
      const account = accountGeneration;
      const playsBefore = collections.generation();
      // Sign-out keeps the MusicKit instance, so the account generation is
      // what stops a load from queueing the previous account's songs.
      const stale = (): boolean =>
        instance !== music || account !== accountGeneration;
      const tracks = await loadAllTracks(
        kind,
        id,
        source,
        requireLibrary(),
        stale,
      );
      if (!tracks || stale()) return;
      // An older play still loading would replace the queue and drop these
      // songs, so it is cancelled. A play started while this load ran is
      // newer than the queue action and keeps going.
      if (collections.generation() === playsBefore) collections.invalidate();
      await (where === "next"
        ? playback.playNextTracks(tracks)
        : playback.playLaterTracks(tracks));
    },
    loadArtistTopSongs: (id, source, catalogId) =>
      stations().topSongs(id, catalogId, source),
    playCollection: (kind, id, source = "library", startIndex = 0, options) =>
      playCollection(kind, id, source, startIndex, options),
    playPlaylist: (id, source = "library", startIndex = 0, trackId) =>
      playCollection("playlist", id, source, startIndex, { trackId }),
    playAlbum: (id, source = "library", startIndex = 0, trackId) =>
      playCollection("album", id, source, startIndex, { trackId }),
    resolveTrackNavigation: trackNavigation.resolve,

    fullQueue: (): Track[] => playback.fullQueue().tracks,

    async prepareToQuit(): Promise<void> {
      // A volume change still waiting on its debounce is saved too.
      preferences.flushPendingVolume();
      await Promise.allSettled([
        playbackSession.saveNow(),
        preferences.saveQueue(),
      ]);
    },

    async togglePlayback(): Promise<void> {
      // A second press while the restored queue starts means pause.
      if (playbackSession.isResuming()) return playback.pause();
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

    setVolume: preferences.setVolume,

    setTheme: preferences.setTheme,

    setWindowEffect: preferences.setWindowEffect,

    setAutoCheckUpdates: preferences.setAutoCheckUpdates,

    setAutoplay: preferences.setAutoplay,

    setTrayIcon: preferences.setTrayIcon,

    setDebugMode: preferences.setDebugMode,

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

    setRestoreSession: preferences.setRestoreSession,

    setUpdateChannel: preferences.setUpdateChannel,

    startupUpdateCheck(): Promise<void> {
      return updater.startupCheck();
    },

    checkForUpdates(): Promise<void> {
      return updater.checkNow();
    },

    dismissUpdate(): void {
      updater.dismissPending();
    },

    async installUpdate(): Promise<void> {
      // The Windows installer exits Arlet at once, without the quit
      // handshake; save the queue and settings first, briefly.
      await Promise.race([
        controller.prepareToQuit(),
        new Promise<void>((resolve) =>
          setTimeout(resolve, QUIT_SAVE_TIMEOUT_MS),
        ),
      ]);
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
      await writeClipboardWithTimeout(
        dependencies.writeClipboardText ?? writeText,
        createSupportReport(diagnosticsStore.getSnapshot()),
        "Couldn't copy the report: the clipboard is busy. Try again.",
      );
      log("Diagnostics report copied to the clipboard.");
    },

    async copyText(text: string): Promise<void> {
      await writeClipboardWithTimeout(
        dependencies.writeClipboardText ?? writeText,
        text,
        "Couldn't copy: the clipboard is busy. Try again.",
      );
    },

    log,

    dispose(): void {
      playbackSession.stop();
      stopPauseListener();
      collections.invalidate();
      stopSleepTimerPositions();
      sleepTimer.cancel();
      trackNavigation.clear();
      preferences.flushPendingVolume();
      stopMusicKitEvents?.();
      stopMusicKitEvents = undefined;
      restoreAuthProbe?.();
      restoreAuthProbe = undefined;
      preferences.stopThemeWatching();
      updater.dispose();
    },
  };

  // The settings defaults are intentionally stable if load is delayed/fails.
  setSettings({ ...DEFAULT_SETTINGS });
  return controller;
}
