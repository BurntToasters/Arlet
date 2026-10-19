import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { installAuthPopupProbe, isAuthorized } from "../musickit/auth.ts";
import { initializeMusicKit } from "../musickit/bootstrap.ts";
import { developerTokenExpiry } from "../musickit/token.ts";
import {
  setUserTokenGuard,
  type loadRadioStations,
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
import {
  reportActionError,
  reportNotice,
} from "../components/action-errors.ts";
import { createIdleGuard } from "./idle-guard.ts";
import { normalizeTrack } from "../musickit/normalize.ts";
import { classifyPlaybackKind } from "../musickit/preview.ts";
import {
  appendDiagnosticLog,
  clearRecentSearches,
  DEFAULT_SETTINGS,
  getState,
  setAccountSummary,
  setAuthState,
  setCurrentTrack,
  setDeveloperTokenExpiry,
  setInitializationState,
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
import type { PlayOptions } from "./queue-window.ts";
import { createStreamRelease } from "./stream-release.ts";
import {
  createControllerAccount,
  isSessionExpired,
} from "./controller-account.ts";
import { createControllerPins } from "./controller-pins.ts";
import { createControllerSettings } from "./controller-settings.ts";
import {
  createTrackNavigationResolver,
  type TrackNavigation,
} from "../musickit/song-navigation.ts";

export type { DetailLoadOptions } from "./library-loader.ts";

/** A clipboard write still pending after this falls through to the next path. */
const CLIPBOARD_PLUGIN_TIMEOUT_MS = 2_000;
const CLIPBOARD_BROWSER_TIMEOUT_MS = 2_000;
/** Commands that count as user activity for the unattended playback cap. */
const ACTIVITY_COMMANDS = [
  "togglePlayback",
  "play",
  "pause",
  "next",
  "previous",
  "seek",
  "seekBy",
  "setShuffleMode",
  "cycleRepeatMode",
  "setRepeatMode",
  "playCollection",
  "playPlaylist",
  "playAlbum",
  "playStation",
  "startStation",
  "playNextTracks",
  "playLaterTracks",
  "playQueueItem",
  "removeQueueItem",
  "moveQueueItem",
  "clearUpNext",
  "playTracksShuffled",
  "queueCollection",
] as const;
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
  /** Signs in again after the Apple sign-in expired; local data is kept. */
  reauthorize(): Promise<void>;
  /** Clears a stuck sign-in at once; a late Apple success still signs in. */
  cancelSignIn(): void;
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

/** Reloads at most this often when the connection returns after a failed init. */
const ONLINE_RELOAD_DEBOUNCE_MS = 30_000;

/**
 * Reloads the app when the window comes back online, so a MusicKit init that
 * failed for a network reason retries. Returns a function that stops listening.
 */
function reloadWhenOnline(
  now: () => number,
  log: (message: string) => void,
): () => void {
  let lastReload: number | undefined;
  const onOnline = (): void => {
    const at = now();
    if (
      lastReload !== undefined &&
      at - lastReload < ONLINE_RELOAD_DEBOUNCE_MS
    ) {
      return;
    }
    lastReload = at;
    log("Connection restored. Reloading to retry Apple Music.");
    window.location.reload();
  };
  window.addEventListener("online", onOnline);
  return () => window.removeEventListener("online", onOnline);
}

/** Rejects with `message` if `pending` has not settled after `ms`. */
async function withClipboardTimeout(
  pending: Promise<void>,
  ms: number,
  message: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Writes to the clipboard: the Tauri plugin first, then the browser clipboard,
 * each with its own timeout, because another app holding the clipboard can
 * leave a write pending. Only when both fail does it throw `busyMessage`.
 * Logs which path succeeded or failed.
 */
async function writeClipboardWithFallback(
  pluginWrite: (text: string) => Promise<void>,
  text: string,
  busyMessage: string,
  log: (message: string) => void,
): Promise<void> {
  try {
    await withClipboardTimeout(
      pluginWrite(text),
      CLIPBOARD_PLUGIN_TIMEOUT_MS,
      "Clipboard plugin timed out.",
    );
    log("Clipboard write succeeded via the Tauri clipboard plugin.");
    return;
  } catch (error) {
    log(
      `Clipboard plugin write failed: ${safeErrorMessage(error)}. Trying the browser clipboard.`,
    );
  }
  try {
    await withClipboardTimeout(
      navigator.clipboard.writeText(text),
      CLIPBOARD_BROWSER_TIMEOUT_MS,
      "Browser clipboard timed out.",
    );
    log("Clipboard write succeeded via navigator.clipboard.");
    return;
  } catch (error) {
    log(`Browser clipboard write failed: ${safeErrorMessage(error)}.`);
  }
  throw new Error(busyMessage);
}

/** Calls a controller command, counting it as user activity first. */
function withActivity<A extends unknown[], R>(
  noteActivity: () => void,
  command: (...args: A) => R,
): (...args: A) => R {
  return (...args: A): R => {
    noteActivity();
    return command(...args);
  };
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
  let stopOnlineReload: (() => void) | undefined;

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

  /** Play starts fail fast while the Apple sign-in is known expired. */
  const requirePlayableMusic = (): MusicKit.MusicKitInstance => {
    if (isSessionExpired()) {
      throw new Error("Sign in again to play Apple Music.");
    }
    return requireMusic();
  };

  const context: ControllerContext = {
    requireMusic,
    getMusic: () => music,
    now,
    log,
    suspectSession: (error, path) => accounts.suspectSession(error, path),
  };
  const library = createLibraryLoader(
    context,
    dependencies.libraryCache ?? createLibraryCache(),
  );
  const discovery = createDiscovery(context, dependencies);
  const playback = createPlayback({
    ...context,
    requireMusic: requirePlayableMusic,
  });
  // Unattended playback cap: playing with no activity for hours is paused.
  const idle = createIdleGuard(() => {
    if (getState().playback.status !== "playing") return;
    void playback.pause();
    reportNotice("Paused after 4 hours without activity.");
  });
  const ratings = createRatings(context);
  const playlists = createPlaylistEditing(context, library);
  const pinning = createControllerPins(context, {
    invokeFn,
    libraryClient: () => library.client(),
  });
  const trackNavigation = createTrackNavigationResolver(requireMusic);
  const { requireLibrary, ensureLibraryCache } = library;
  const collections = createCollectionPlayback({
    requireMusic: requirePlayableMusic,
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
    options?: PlayOptions,
  ): Promise<void> => {
    collections.invalidate();
    return playback
      .playTracks(tracks, startIndex, undefined, options)
      .then(() => undefined);
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
    playStation: playback.playStation,
    // Play waits for a handoff's stop() still in flight.
    beforeResume: () => streamRelease.settled(),
    playIntent: playback.playIntent,
    fullQueue: playback.fullQueue,
  });
  const streamRelease = createStreamRelease({
    getMusic: () => music ?? undefined,
    fullQueue: playback.fullQueue,
    currentStation: playback.currentStation,
    log,
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

  /**
   * Sign-in, re-auth, sign-out, session expiry, and MusicKit authorization
   * changes. Created after the domain modules it resets.
   */
  const accounts = createControllerAccount(context, {
    createLibraryClient,
    library,
    pinning,
    playbackSession,
    ratings,
    discovery,
    playback,
    collections,
    sleepTimer,
    streamRelease,
    trackNavigation,
    resetStations: () => {
      // Library artist mappings belong to the previous account.
      stationResolver = undefined;
    },
    refreshCurrentData: () => controller.refreshCurrentData(),
  });

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
      setUserTokenGuard(instance, {
        blocked: isSessionExpired,
        onRejected: (error, path) => accounts.suspectSession(error, path),
      });
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
            accounts.suspectSession(error);
          },
          undefined,
          () => playback.syncPlaybackModes(instance),
          {
            ignoreProviderPlayback: () =>
              getState().playback.pendingRestore?.released === true,
            onAuthorizationChange: () =>
              accounts.onMusicKitAuthorizationChange(instance),
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
      stopOnlineReload?.();
      stopOnlineReload = reloadWhenOnline(now, log);
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

    authorize: accounts.authorize,

    reauthorize: accounts.reauthorize,

    cancelSignIn: accounts.cancelSignIn,

    signOut: accounts.signOut,

    resetSettingsAndRestart: preferences.resetSettingsAndRestart,

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
      const account = accounts.generation();
      const playsBefore = collections.generation();
      // Sign-out keeps the MusicKit instance, so the account generation is
      // what stops a load from queueing the previous account's songs.
      const stale = (): boolean =>
        instance !== music || account !== accounts.generation();
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
      await writeClipboardWithFallback(
        dependencies.writeClipboardText ?? writeText,
        createSupportReport(diagnosticsStore.getSnapshot()),
        "Couldn't copy the report: the clipboard is busy. Try again.",
        log,
      );
      log("Diagnostics report copied to the clipboard.");
    },

    async copyText(text: string): Promise<void> {
      await writeClipboardWithFallback(
        dependencies.writeClipboardText ?? writeText,
        text,
        "Couldn't copy: the clipboard is busy. Try again.",
        log,
      );
    },

    log,

    dispose(): void {
      idle.dispose();
      stopOnlineReload?.();
      playbackSession.stop();
      stopPauseListener();
      collections.invalidate();
      stopSleepTimerPositions();
      sleepTimer.cancel();
      streamRelease.dispose();
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

  for (const name of ACTIVITY_COMMANDS) {
    controller[name] = withActivity(
      idle.noteActivity,
      controller[name] as (...args: unknown[]) => unknown,
    ) as never;
  }

  // The settings defaults are intentionally stable if load is delayed/fails.
  setSettings({ ...DEFAULT_SETTINGS });
  return controller;
}
