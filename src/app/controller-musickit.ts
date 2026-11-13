import { installAuthPopupProbe, isAuthorized } from "../musickit/auth.ts";
import type { initializeMusicKit } from "../musickit/bootstrap.ts";
import { developerTokenExpiry } from "../musickit/token.ts";
import { setUserTokenGuard } from "../musickit/catalog.ts";
import { normalizeTrack } from "../musickit/normalize.ts";
import { registerMusicKitEvents } from "../musickit/events.ts";
import { mapErrorToCode } from "../musickit/errors.ts";
import { syncMusicKitQueue } from "../musickit/player.ts";
import type { AppleMusicLibraryClient } from "../musickit/library.ts";
import { registerSensitiveValue } from "../platform/redact.ts";
import {
  clearRecentSearches,
  getState,
  setAccountSummary,
  setAuthState,
  setCurrentTrack,
  setDeveloperTokenExpiry,
  setInitializationState,
} from "../state.ts";
import {
  safeErrorMessage,
  type ControllerContext,
} from "./controller-support.ts";
import {
  isSessionExpired,
  type createControllerAccount,
} from "./controller-account.ts";
import type { createAutoSkip } from "./auto-skip.ts";
import type { createControllerPins } from "./controller-pins.ts";
import type { createControllerSettings } from "./controller-settings.ts";
import type { createLibraryLoader } from "./library-loader.ts";
import type { createPlayback } from "./playback.ts";
import type { createPlaybackSession } from "./playback-session.ts";
import type { createRatings } from "./ratings.ts";
import type { createSleepTimer } from "./sleep-timer.ts";

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

export interface MusicKitStartupDependencies {
  initialize: typeof initializeMusicKit;
  createLibraryClient(
    instance: MusicKit.MusicKitInstance,
  ): AppleMusicLibraryClient;
  setMusic(instance: MusicKit.MusicKitInstance): void;
  library: ReturnType<typeof createLibraryLoader>;
  preferences: ReturnType<typeof createControllerSettings>;
  playback: ReturnType<typeof createPlayback>;
  playbackSession: ReturnType<typeof createPlaybackSession>;
  accounts: ReturnType<typeof createControllerAccount>;
  pinning: ReturnType<typeof createControllerPins>;
  ratings: ReturnType<typeof createRatings>;
  autoSkip: ReturnType<typeof createAutoSkip>;
  sleepTimer: ReturnType<typeof createSleepTimer>;
  syncPlaybackDiagnostics(): void;
}

/** MusicKit startup, auth probe, and event wiring. The controller owns the instance. */
export function createMusicKitStartup(
  context: ControllerContext,
  deps: MusicKitStartupDependencies,
) {
  const { log, now } = context;
  const {
    initialize,
    createLibraryClient,
    setMusic,
    library,
    preferences,
    playback,
    playbackSession,
    accounts,
    pinning,
    ratings,
    autoSkip,
    sleepTimer,
    syncPlaybackDiagnostics,
  } = deps;
  const { ensureLibraryCache } = library;
  let restoreAuthProbe: (() => void) | undefined;
  let stopMusicKitEvents: (() => void) | undefined;
  let stopOnlineReload: (() => void) | undefined;

  const initializeController = async (): Promise<void> => {
    playbackSession.start();
    // Clears what a failed earlier clear left fenced. It runs before any local
    // read, so restore, pins, and library cache see the outcome.
    await accounts.retryBlockedAccountData();
    setInitializationState({ status: "loading" });
    log("Initializing MusicKit…");
    // Opens the SQLite cache during MusicKit configure. Nothing is shown from
    // it here: the account is unknown until configure finishes.
    void library.openLibraryCache();
    try {
      const instance = await initialize();
      setMusic(instance);
      // Records MusicKit's startup bitrate before any write below.
      preferences.captureStartupBitrate(instance);
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
            if (mapErrorToCode(error) === "SUBSCRIPTION_REQUIRED") {
              void accounts.refreshSubscription();
            }
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
            log,
          },
        );
        playback.syncPlaybackModes(instance);
      }
      syncMusicKitQueue(instance);
      preferences.applyAutoplaySetting(instance);
      preferences.applyAudioQuality(instance);
      restoreAuthProbe = installAuthPopupProbe(log);
      setInitializationState({ status: "ready" });
      log("MusicKit initialized successfully.");
      // Saved recents with no signed-in account belong to a session that
      // ended, so they are not carried into the next sign-in.
      if (!isAuthorized(instance)) clearRecentSearches();
      if (isAuthorized(instance)) {
        setAuthState({ status: "authorized" });
        void accounts.refreshSubscription();
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
      // An expired token is not a connection problem: show the expiry notice
      // (restarting Arlet refreshes the token) instead of an offline banner
      // whose Reconnect never works.
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

  return {
    initialize: initializeController,
    stopOnlineReloadListener: (): void => stopOnlineReload?.(),
    stopMusicKitListeners: (): void => {
      stopMusicKitEvents?.();
      stopMusicKitEvents = undefined;
      restoreAuthProbe?.();
      restoreAuthProbe = undefined;
    },
  };
}
