import { setNativeLogDebugMode } from "../diagnostics/native.ts";
import { reportActionError } from "../components/action-errors.ts";
import {
  readMusicKitBitrate,
  setAutoplayEnabled,
  writeMusicKitBitrate,
} from "../musickit/player.ts";
import {
  getState,
  setSettings,
  setWindowEffectState,
  type AppSettings,
  type AudioQuality,
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
import { errorMessage, type ControllerContext } from "./controller-support.ts";
import type { createPlayback } from "./playback.ts";
import type { createPlaybackSession } from "./playback-session.ts";

const VOLUME_SAVE_DELAY_MS = 300;

export interface ControllerSettingsDependencies {
  invokeFn: InvokeFunction;
  playback: ReturnType<typeof createPlayback>;
  playbackSession: ReturnType<typeof createPlaybackSession>;
  /** Hands the updater the settings whenever the update preferences change. */
  configureUpdater(settings: AppSettings): void;
  /** Reloads the saved pins after settings load. */
  loadPins(): Promise<void>;
}

/** Settings persistence, the debounced volume save, and settings setters. */
export function createControllerSettings(
  context: ControllerContext,
  deps: ControllerSettingsDependencies,
) {
  const { log } = context;
  const { invokeFn, playback, playbackSession, configureUpdater } = deps;
  let volumeSaveQueue: Promise<void> = Promise.resolve();
  let volumeSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let volumeSaveWaiters: Array<() => void> = [];
  let stopThemeWatcher: (() => void) | undefined;

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

  /**
   * Every settings save goes through one queue and reads the settings when it
   * runs, so an older snapshot can never land after a newer one.
   */
  const queueSettingsSave = (): Promise<void> => {
    const save = volumeSaveQueue.then(() =>
      savePersistedSettings(getState().settings, invokeFn),
    );
    volumeSaveQueue = save.then(
      () => undefined,
      (error: unknown) => {
        try {
          log(`Settings save failed: ${errorMessage(error)}`);
        } catch {
          return;
        }
      },
    );
    return save;
  };

  const persistSettings = async (settings: AppSettings): Promise<void> => {
    setSettings(settings);
    await queueSettingsSave();
  };

  /** Pushes the saved autoplay preference to MusicKit once it is available. */
  const applyAutoplaySetting = (instance: MusicKit.MusicKitInstance): void => {
    playback.syncPlaybackModes(instance);
    if (!getState().playback.modeCapabilities?.autoplay) return;
    if (!setAutoplayEnabled(instance, getState().settings.autoplay)) {
      log("Autoplay setting could not be applied in this MusicKit runtime.");
    }
    playback.syncPlaybackModes(instance);
  };

  /**
   * The bitrate MusicKit chose at construction from network speed. "automatic"
   * writes this value back. It is read once per instance, before Arlet writes.
   */
  let startupInstance: MusicKit.MusicKitInstance | undefined;
  let startupBitrate: number | undefined;

  const captureStartupBitrate = (instance: MusicKit.MusicKitInstance): void => {
    if (startupInstance === instance) return;
    startupInstance = instance;
    startupBitrate = readMusicKitBitrate(instance);
  };

  /** The kbps value a quality asks MusicKit for; undefined when there is nothing to write. */
  const bitrateForQuality = (quality: AudioQuality): number | undefined => {
    if (quality === "high") return MusicKit.PlaybackBitrate?.HIGH ?? 256;
    if (quality === "standard") return MusicKit.PlaybackBitrate?.STANDARD ?? 64;
    return startupBitrate;
  };

  /**
   * Pushes an audio quality to MusicKit. MusicKit applies it when the next song
   * is prepared. Returns false when the runtime rejects the write.
   */
  const applyAudioQuality = (
    instance: MusicKit.MusicKitInstance,
    quality: AudioQuality = getState().settings.audioQuality,
  ): boolean => {
    captureStartupBitrate(instance);
    const target = bitrateForQuality(quality);
    if (target === undefined || readMusicKitBitrate(instance) === target) {
      return true;
    }
    if (writeMusicKitBitrate(instance, target)) return true;
    log("Audio quality could not be applied in this MusicKit runtime.");
    return false;
  };

  /**
   * Saves the latest settings once a volume drag settles. During a drag the
   * live level is only in `playback.volume`, so it is copied into settings here.
   */
  const flushVolumeSave = (): void => {
    volumeSaveTimer = undefined;
    const waiters = volumeSaveWaiters;
    volumeSaveWaiters = [];
    const { volume } = getState().playback;
    if (getState().settings.volume !== volume) {
      setSettings({ ...getState().settings, volume });
    }
    void queueSettingsSave().then(
      () => {
        for (const resolve of waiters) resolve();
      },
      (error: unknown) => {
        try {
          reportActionError(error);
        } catch (reportError) {
          log(
            `Could not report volume save failure: ${errorMessage(reportError)}`,
          );
        } finally {
          for (const resolve of waiters) resolve();
        }
      },
    );
  };

  /** Restarts the debounce, so the save waits until the input settles. */
  const scheduleVolumeSave = (): void => {
    if (volumeSaveTimer !== undefined) clearTimeout(volumeSaveTimer);
    volumeSaveTimer = setTimeout(flushVolumeSave, VOLUME_SAVE_DELAY_MS);
  };

  /** Saves a debounced volume change now, instead of waiting for the timer. */
  const flushPendingVolume = (): void => {
    if (volumeSaveTimer !== undefined) {
      clearTimeout(volumeSaveTimer);
      flushVolumeSave();
    }
  };

  const loadSettings = async (): Promise<void> => {
    const settings = await loadPersistedSettings(invokeFn);
    setSettings(settings);
    setNativeLogDebugMode(settings.debugMode);
    playbackSession.markSettingsLoaded();
    playback.applyPlaybackVolume(settings.volume);
    const music = context.getMusic();
    if (music) {
      applyAutoplaySetting(music);
      applyAudioQuality(music);
    }
    configureUpdater(settings);
    const effectPromise = applyCurrentEffect();
    const pinsPromise = deps.loadPins();
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
  };

  const setVolume = async (volume: number): Promise<void> => {
    // Slider input fires many times a second. The audio and `playback.volume`
    // follow each one without touching settings, which are written once the
    // drag settles.
    playback.applyPlaybackVolume(volume);
    scheduleVolumeSave();
    await new Promise<void>((resolve) => volumeSaveWaiters.push(resolve));
  };

  const setTheme = async (theme: ThemePreference): Promise<void> => {
    await persistSettings({ ...getState().settings, theme });
    await applyCurrentEffect();
  };

  const setWindowEffect = async (
    preference: WindowEffectPreference,
  ): Promise<void> => {
    await persistSettings({
      ...getState().settings,
      windowEffect: preference,
    });
    await applyCurrentEffect();
  };

  const setAutoCheckUpdates = async (enabled: boolean): Promise<void> => {
    const settings: AppSettings = {
      ...getState().settings,
      autoCheckUpdates: enabled,
    };
    setSettings(settings);
    configureUpdater(settings);
    await persistSettings(settings);
  };

  const setAutoplay = async (enabled: boolean): Promise<void> => {
    const instance = context.requireMusic();
    if (!setAutoplayEnabled(instance, enabled)) {
      playback.syncPlaybackModes(instance);
      throw new Error("Autoplay is not available in this MusicKit runtime.");
    }
    playback.syncPlaybackModes(instance);
    await persistSettings({ ...getState().settings, autoplay: enabled });
  };

  const setAudioQuality = async (quality: AudioQuality): Promise<void> => {
    const instance = context.requireMusic();
    if (!applyAudioQuality(instance, quality)) {
      throw new Error(
        "Audio quality is not available in this MusicKit runtime.",
      );
    }
    await persistSettings({ ...getState().settings, audioQuality: quality });
  };

  const setTrayIcon = async (enabled: boolean): Promise<void> => {
    await persistSettings({ ...getState().settings, trayIcon: enabled });
  };

  const setLaunchAtStartup = async (enabled: boolean): Promise<void> => {
    await persistSettings({ ...getState().settings, launchAtStartup: enabled });
  };

  const setDebugMode = async (enabled: boolean): Promise<void> => {
    await persistSettings({ ...getState().settings, debugMode: enabled });
    setNativeLogDebugMode(enabled);
    log(enabled ? "Debug Mode turned on." : "Debug Mode turned off.");
  };

  const setRestoreSession = async (enabled: boolean): Promise<void> => {
    await persistSettings({
      ...getState().settings,
      restoreSession: enabled,
    });
    if (!enabled) await playbackSession.clear();
  };

  const setUpdateChannel = async (channel: UpdateChannel): Promise<void> => {
    const settings: AppSettings = {
      ...getState().settings,
      updateChannel: channel,
    };
    setSettings(settings);
    configureUpdater(settings);
    await persistSettings(settings);
  };

  const resetSettingsAndRestart = async (): Promise<void> => {
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
    // The restart exits without the quit handshake; save the queue first.
    await playbackSession.saveNow().catch(() => undefined);
    log("Resetting settings to defaults and restarting.");
    await resetPersistedSettings(invokeFn);
  };

  return {
    loadSettings,
    setVolume,
    setTheme,
    setWindowEffect,
    setAutoCheckUpdates,
    setAutoplay,
    setAudioQuality,
    setTrayIcon,
    setLaunchAtStartup,
    setDebugMode,
    setRestoreSession,
    setUpdateChannel,
    resetSettingsAndRestart,
    applyAutoplaySetting,
    applyAudioQuality,
    captureStartupBitrate,
    scheduleVolumeSave,
    flushPendingVolume,
    /** Settles when every queued settings write has finished. */
    saveQueue: (): Promise<void> => volumeSaveQueue,
    stopThemeWatching: (): void => {
      stopThemeWatcher?.();
      stopThemeWatcher = undefined;
    },
  };
}

export type ControllerSettings = ReturnType<typeof createControllerSettings>;
