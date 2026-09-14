import { invoke } from "@tauri-apps/api/core";
import {
  authorize,
  installAuthPopupProbe,
  isAuthorized,
  unauthorize,
} from "../musickit/auth.ts";
import { initializeMusicKit } from "../musickit/bootstrap.ts";
import { searchCatalogSongs } from "../musickit/catalog.ts";
import { registerMusicKitEvents } from "../musickit/events.ts";
import {
  CONSECUTIVE_TRACK_TARGET,
  playQueue,
  seekToTime,
  setVolume as setMusicVolume,
  skipToNext,
  skipToPrevious,
  toggle,
} from "../musickit/player.ts";
import { mapErrorToCode } from "../musickit/errors.ts";
import { normalizeTrack } from "../musickit/normalize.ts";
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
import type { DiagnosticsStore } from "../diagnostics/store.ts";
import type { GateEnvironment } from "../phase0/gate-session.ts";
import { redactSensitive } from "../platform/redact.ts";
import { createUpdaterService, type UpdaterService } from "../updater.ts";

export interface ControllerDependencies {
  initializeMusicKit?: typeof initializeMusicKit;
  searchCatalogSongs?: typeof searchCatalogSongs;
  invokeFn?: InvokeFunction;
  now?: () => number;
  diagnosticsStore?: DiagnosticsStore;
  updater?: UpdaterService;
}

export interface AppController {
  initialize(): Promise<void>;
  loadSettings(): Promise<void>;
  authorize(): Promise<void>;
  signOut(): Promise<void>;
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
        log("Authorizing… waiting for Apple Music sign-in window.");
        await authorize(instance);
        // Keep the user token private to MusicKit; only expose auth status.
        setAuthState({ status: "authorized" });
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
        await playQueue(
          instance,
          queue.map((track) => track.id),
        );
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
