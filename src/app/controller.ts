import { invoke } from "@tauri-apps/api/core";
import { initializeMusicKit } from "../musickit/bootstrap.ts";
import {
  type loadRadioStations,
  searchMusicResources,
  searchCatalogSongs,
} from "../musickit/catalog.ts";
import type { BrowseShelfKind, loadBrowseCharts } from "../musickit/browse.ts";
import { safeNextPath } from "../musickit/response.ts";
import type { SearchGroupKind } from "../musickit/search.ts";
import type {
  CuratorPage,
  CuratorPlaylistsPage,
  PlaylistCuratorRef,
} from "../musickit/curators.ts";
import type { CuratorKind } from "../routing/router.ts";
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
import {
  DEFAULT_SETTINGS,
  getState,
  setSettings,
  setSleepTimer,
  setUiState,
  setUpdateState,
  subscribePlaybackPosition,
  type AudioQuality,
  type LibraryEntity,
  type LibrarySection,
  type ThemePreference,
  type UpdateChannel,
  type WindowEffectPreference,
} from "../state.ts";
import type { InvokeFunction } from "./settings.ts";
import type {
  Activity,
  MusicSource,
  RatingValue,
  RecordLabel,
  SongInfo,
  Station,
  Track,
} from "../domain/music.ts";
import type { DiagnosticsStore } from "../diagnostics/store.ts";
import type { GateEnvironment } from "../phase0/gate-session.ts";
import { openAppleMusicLink, openSubscribeLink } from "../platform/support.ts";
import { createUpdaterService, type UpdaterService } from "../updater.ts";
import {
  createAppleMusicLibraryClient,
  type AppleMusicLibraryClient,
} from "../musickit/library.ts";
import { createLibraryCache, type LibraryCache } from "../library/cache.ts";
import {
  safeErrorMessage,
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
import {
  ACTIVITY_COMMANDS,
  createPlaybackWrappers,
  withActivity,
} from "./controller-playback.ts";
import { createCatalogLoaders } from "./controller-catalog.ts";
import { createMusicKitStartup } from "./controller-musickit.ts";
import { createControllerDiagnostics } from "./controller-diagnostics.ts";

export type { DetailLoadOptions } from "./library-loader.ts";

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
  loadAllLibrarySection(section: LibrarySection): Promise<void>;
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
  /** Resolves undefined when a newer label load has superseded this one. */
  loadRecordLabel(id: string): Promise<RecordLabel | undefined>;
  /** Resolves undefined when a newer activity load has superseded this one. */
  loadActivity(id: string): Promise<Activity | undefined>;
  /** Get Info for a song. Resolves undefined when a newer request superseded it. */
  loadSongInfo(track: Track): Promise<SongInfo | undefined>;
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
  /** `parentFolderId` puts the new folder inside an existing one. */
  createPlaylistFolder(
    name: string,
    parentFolderId?: string,
  ): Promise<LibraryEntity | undefined>;
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
  /** Writes the MusicKit bitrate for the quality; saves only on success. */
  setAudioQuality(quality: AudioQuality): Promise<void>;
  /** Opens Apple's subscribe page; throws when MusicKit has no link. */
  openSubscribe(): Promise<void>;
  /**
   * Opens a library playlist on music.apple.com, where Apple's web editor can
   * edit it. Rejects an id that is not a plain Apple library ID.
   */
  openPlaylistInAppleMusic(id: string): Promise<void>;
  setTrayIcon(enabled: boolean): Promise<void>;
  /** Writes or removes the Windows sign-in entry; the Rust side owns the registry write. */
  setLaunchAtStartup(enabled: boolean): Promise<void>;
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
 * Composition root for the app: owns MusicKit initialization, auth,
 * settings, pins, playlist edits, and the updater. Library loading,
 * discovery/search, and playback live in their own modules.
 */
export function createAppController(
  dependencies: ControllerDependencies = {},
): AppController {
  const invokeFn = dependencies.invokeFn ?? (invoke as InvokeFunction);
  const now = dependencies.now ?? Date.now;
  const diagnosticsStore = dependencies.diagnosticsStore;
  const createLibraryClient =
    dependencies.createLibraryClient ?? createAppleMusicLibraryClient;
  let music: MusicKit.MusicKitInstance | null = null;

  const diagnostics = createControllerDiagnostics({
    now,
    diagnosticsStore,
    invokeFn,
    writeClipboardText: dependencies.writeClipboardText,
    lastSearchTracks: () => discovery.lastSearchTracks(),
  });
  const { log } = diagnostics;

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
  const { requireLibrary } = library;
  const { cancelAutoplayCheck, playSongs, playStationAndCheck } =
    createPlaybackWrappers({ playback, log });
  const collections = createCollectionPlayback({
    requireMusic: requirePlayableMusic,
    getMusic: () => music,
    requireLibrary,
    playTracks: playSongs,
    setShuffleMode: playback.setShuffleModeForPlay,
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
    return playSongs(tracks, startIndex, undefined, options).then(
      () => undefined,
    );
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
    playStation: playStationAndCheck,
    // Play waits for a handoff's stop() still in flight.
    beforeResume: () => streamRelease.settled(),
    playIntent: playback.playIntent,
    pauseCount: playback.pauseCount,
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

  const musicKit = createMusicKitStartup(context, {
    initialize: dependencies.initializeMusicKit ?? initializeMusicKit,
    createLibraryClient,
    setMusic: (instance) => {
      music = instance;
    },
    library,
    preferences,
    playback,
    playbackSession,
    accounts,
    pinning,
    ratings,
    autoSkip,
    sleepTimer,
    syncPlaybackDiagnostics: diagnostics.syncPlaybackDiagnostics,
  });

  const catalog = createCatalogLoaders({
    requireMusic,
    accountGeneration: () => accounts.generation(),
  });

  const controller: AppController = {
    initialize: musicKit.initialize,

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

    loadAllLibrarySection: library.loadAllLibrarySection,

    refreshLibrarySection: library.refreshLibrarySection,

    loadHome: library.loadHome,

    loadBrowse: discovery.loadBrowse,

    loadMoreBrowseShelf: discovery.loadMoreBrowseShelf,

    loadRadio: discovery.loadRadio,

    loadRadioGenre: discovery.loadRadioGenre,
    loadCurator: catalog.loadCurator,
    loadMoreCuratorPlaylists: catalog.loadMoreCuratorPlaylists,
    loadPlaylistCurator: catalog.loadPlaylistCurator,
    loadRecordLabel: catalog.loadRecordLabel,
    loadActivity: catalog.loadActivity,
    loadSongInfo: catalog.loadSongInfo,

    playStation(station: Station): Promise<void> {
      collections.invalidate();
      return playStationAndCheck(station);
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
      await playStationAndCheck(station);
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

    setAudioQuality: preferences.setAudioQuality,

    async openSubscribe(): Promise<void> {
      const url = requireMusic().subscribeURL;
      if (!url) throw new Error("Subscribe link is not available.");
      await openSubscribeLink(url);
    },

    async openPlaylistInAppleMusic(id: string): Promise<void> {
      if (!/^[A-Za-z0-9._-]{1,256}$/.test(id)) {
        throw new Error("This playlist can't be opened in Apple Music.");
      }
      await openAppleMusicLink(
        `https://music.apple.com/library/playlist/${encodeURIComponent(id)}`,
      );
    },

    setTrayIcon: preferences.setTrayIcon,

    setLaunchAtStartup: preferences.setLaunchAtStartup,

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

    openMusicDiagnostic: diagnostics.openMusicDiagnostic,
    setDiagnosticsEnvironment: diagnostics.setDiagnosticsEnvironment,
    copyDiagnosticsReport: diagnostics.copyDiagnosticsReport,
    copyText: diagnostics.copyText,
    log,

    dispose(): void {
      idle.dispose();
      musicKit.stopOnlineReloadListener();
      playbackSession.stop();
      stopPauseListener();
      cancelAutoplayCheck();
      collections.invalidate();
      stopSleepTimerPositions();
      sleepTimer.cancel();
      streamRelease.dispose();
      trackNavigation.clear();
      preferences.flushPendingVolume();
      musicKit.stopMusicKitListeners();
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
