import { authorize, isAuthorized, unauthorize } from "../musickit/auth.ts";
import { probeUserToken } from "../musickit/catalog.ts";
import type { AppleMusicLibraryClient } from "../musickit/library.ts";
import {
  beginAccountDataInvalidation,
  cancelAccountDataInvalidation,
  completeAccountDataClear,
} from "../platform/account-data.ts";
import { registerSensitiveValue } from "../platform/redact.ts";
import {
  clearRecentSearches,
  getState,
  resetState,
  setAccountSummary,
  setAuthPending,
  setAuthState,
  setInitializationState,
  setPins,
  setSessionExpired,
} from "../state.ts";
import {
  safeErrorMessage,
  type ControllerContext,
} from "./controller-support.ts";
import { createSessionHealth } from "./session-health.ts";
import type { createCollectionPlayback } from "./collection-playback.ts";
import type { createControllerPins } from "./controller-pins.ts";
import type { createDiscovery } from "./discovery.ts";
import type { LibraryLoader } from "./library-loader.ts";
import type { createPlayback } from "./playback.ts";
import type { createPlaybackSession } from "./playback-session.ts";
import type { createRatings } from "./ratings.ts";
import type { createSleepTimer } from "./sleep-timer.ts";
import type { createStreamRelease } from "./stream-release.ts";
import type { createTrackNavigationResolver } from "../musickit/song-navigation.ts";

/** True when Apple rejected the signed-in session and the user must sign in again. */
export function isSessionExpired(): boolean {
  return (
    getState().auth.status === "authorized" &&
    getState().auth.sessionExpired === true
  );
}

export interface ControllerAccountDependencies {
  createLibraryClient(
    instance: MusicKit.MusicKitInstance,
  ): AppleMusicLibraryClient;
  library: Pick<
    LibraryLoader,
    "client" | "setClient" | "clearLibraryCache" | "ensureLibraryCache"
  >;
  pinning: Pick<
    ReturnType<typeof createControllerPins>,
    "reload" | "clearStored"
  >;
  playbackSession: Pick<ReturnType<typeof createPlaybackSession>, "clear">;
  ratings: Pick<ReturnType<typeof createRatings>, "reset" | "syncCurrentTrack">;
  discovery: Pick<ReturnType<typeof createDiscovery>, "resetAccount">;
  playback: Pick<
    ReturnType<typeof createPlayback>,
    "cancelPendingPlayback" | "clearContinuation"
  >;
  collections: Pick<ReturnType<typeof createCollectionPlayback>, "invalidate">;
  sleepTimer: Pick<ReturnType<typeof createSleepTimer>, "cancel">;
  streamRelease: Pick<
    ReturnType<typeof createStreamRelease>,
    "cancel" | "releaseNow"
  >;
  trackNavigation: Pick<
    ReturnType<typeof createTrackNavigationResolver>,
    "clear"
  >;
  /** Drops the per-account station lookups. */
  resetStations(): void;
  /** Reloads the current view after a successful re-auth. */
  refreshCurrentData(): Promise<void>;
}

export interface ControllerAccount {
  authorize(): Promise<void>;
  /** Signs in again after the Apple sign-in expired; local data is kept. */
  reauthorize(): Promise<void>;
  signOut(): Promise<void>;
  /** Clears the pending sign-in at once; a late success still signs in. */
  cancelSignIn(): void;
  /** MusicKit reported an authorization change; a revoked session expires. */
  onMusicKitAuthorizationChange(instance: MusicKit.MusicKitInstance): void;
  /** Reports an error that may mean the Apple sign-in expired. */
  suspectSession(error: unknown, path?: string): void;
  /** Bumped on sign-in and sign-out; work started earlier must not land. */
  generation(): number;
}

/**
 * Sign-in, re-auth, sign-out, session expiry, and MusicKit authorization
 * changes. Local data is cleared only by a sign-out or a new account's
 * sign-in; an expired session keeps everything until the user signs in again.
 */
export function createControllerAccount(
  context: ControllerContext,
  deps: ControllerAccountDependencies,
): ControllerAccount {
  const { requireMusic, now, log } = context;
  const {
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
  } = deps;

  /** Bumped on sign-in and sign-out; work started earlier must not land. */
  let accountGeneration = 0;
  /** Sign-out work in progress, whose MusicKit auth events are our own. */
  let accountTransitions = 0;
  /** The attempt the user is waiting on; cancelSignIn abandons it. */
  let signInAttempt: { abandoned: boolean } | undefined;

  /**
   * True while Arlet itself is signing in, out, or re-authorizing. An
   * abandoned attempt is no longer the current one, so it does not count.
   */
  const transitioning = (): boolean =>
    accountTransitions > 0 ||
    signInAttempt !== undefined ||
    getState().auth.pending === true;

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
    streamRelease.cancel();
    playback.clearContinuation();
    // Library artist mappings belong to the previous account.
    deps.resetStations();
    trackNavigation.clear();
  };

  /** Clears each persisted category independently and releases its fence only on success. */
  const clearPersistedAccountData = async (): Promise<void> => {
    const failures: string[] = [];
    const clearCategory = async (
      category: "library" | "pins" | "queue",
      label: string,
      clear: () => Promise<void>,
    ): Promise<void> => {
      try {
        await clear();
        completeAccountDataClear(category);
      } catch (error) {
        const message = safeErrorMessage(error);
        log(`${label}: ${message}`);
        failures.push(`${label}: ${message}`);
      }
    };
    await Promise.all([
      clearCategory("library", "Library cache clear failed", () =>
        library.clearLibraryCache(),
      ),
      clearCategory("pins", "Pinned playlists clear failed", () =>
        pinning.clearStored(),
      ),
      clearCategory("queue", "Playback session clear failed", () =>
        playbackSession.clear(),
      ),
    ]);
    if (failures.length > 0) {
      throw new Error(`Account data clear failed: ${failures.join("; ")}`);
    }
  };

  /**
   * Local sign-out: drops the account's cached library, pins, and saved queue.
   * It never calls Apple, so it also serves a session Apple already ended.
   */
  const clearSignedInData = async (
    persistedClear: Promise<void>,
  ): Promise<void> => {
    let clearError: unknown;
    try {
      await persistedClear;
    } catch (error) {
      clearError = error;
    } finally {
      discovery.resetAccount();
      resetState();
      setPins([]);
      setInitializationState({ status: "ready" });
    }
    if (clearError) throw clearError;
  };

  /**
   * Apple rejected the sign-in (password change, revoked token). Playback is
   * handed back and the UI asks for a new sign-in. Nothing local is deleted.
   */
  /** Marks the session expired. Callers decide whether a transition blocks it. */
  const markSessionExpired = (reason: string): void => {
    const { auth } = getState();
    if (auth.status !== "authorized" || auth.sessionExpired) return;
    collections.invalidate();
    playback.cancelPendingPlayback();
    sleepTimer.cancel();
    streamRelease.releaseNow("sign-in expired");
    setSessionExpired(true);
    log(`Apple Music sign-in expired: ${reason}`);
  };

  const handleSessionExpired = (reason: string): void => {
    if (transitioning()) return;
    markSessionExpired(reason);
  };

  /**
   * MusicKit's own view of the user token. An unknown value or a MusicKit that
   * is not configured yet counts as authorized, so it never expires a session.
   */
  const musicKitAuthorized = (): boolean => {
    try {
      const value = isAuthorized(requireMusic());
      return typeof value !== "boolean" || value;
    } catch {
      return true;
    }
  };

  /**
   * A re-auth or cancelled sign-in that left MusicKit without a token. A
   * sign-in still in flight decides its own outcome, so it is skipped here.
   */
  const expireUnlessAuthorized = (reason: string): void => {
    if (getState().auth.pending === true) return;
    if (getState().auth.status !== "authorized") return;
    if (musicKitAuthorized()) return;
    markSessionExpired(reason);
  };

  const sessionHealth = createSessionHealth({
    probe: () => probeUserToken(requireMusic()),
    onExpired: handleSessionExpired,
    active: () => {
      const { auth } = getState();
      return (
        auth.status === "authorized" && !auth.sessionExpired && !transitioning()
      );
    },
    musicKitAuthorized,
    now,
    log,
  });

  const onMusicKitAuthorizationChange = (
    instance: MusicKit.MusicKitInstance,
  ): void => {
    if (transitioning()) return;
    if (typeof instance.isAuthorized !== "boolean") return;
    if (isAuthorized(instance)) return;
    if (getState().auth.status !== "authorized") return;
    handleSessionExpired("MusicKit no longer authorizes the session");
  };

  const signIn = async (options: { reauth: boolean }): Promise<void> => {
    if (
      getState().auth.pending ||
      signInAttempt !== undefined ||
      accountTransitions > 0
    ) {
      return;
    }
    const attempt = { abandoned: false };
    let authorizationStarted = false;
    let authorized = false;
    let invalidation:
      ReturnType<typeof beginAccountDataInvalidation> | undefined;
    try {
      const instance = requireMusic();
      // A fresh authorization may select another Apple ID. Fence old data
      // before opening the popup; re-auth is the same account and keeps its
      // saved queue by design.
      if (!options.reauth) invalidation = beginAccountDataInvalidation();
      authorizationStarted = true;
      signInAttempt = attempt;
      setAuthPending(true);
      resetAccountScope();
      log("Authorizing… waiting for Apple Music sign-in window.");
      const userToken = await authorize(instance);
      authorized = true;
      registerSensitiveValue(userToken);
      if (options.reauth) {
        try {
          await library.clearLibraryCache();
        } catch (error) {
          log(
            `Library cache clear after re-auth failed: ${safeErrorMessage(error)}`,
          );
        }
      } else {
        // MusicKit may have switched accounts while the popup was open. Drop
        // the old in-memory view before any new account data can load.
        const initialization = getState().initialization;
        resetState();
        setPins([]);
        setAuthPending(true);
        setInitializationState(initialization);
        try {
          await clearPersistedAccountData();
        } catch (error) {
          // Categories whose clear failed stay fenced, while the new sign-in
          // can continue without reading or writing those files.
          log(
            `Account data clear after authorization failed: ${safeErrorMessage(error)}`,
          );
        }
        setInitializationState({ status: "ready" });
      }
      // Keep the user token private to MusicKit; only expose auth status.
      setAuthState({ status: "authorized" });
      // A lookup made while the popup was open used the old sign-in; look
      // the playing song's rating up again for the new one.
      ratings.reset();
      ratings.syncCurrentTrack();
      try {
        if (!library.client()) {
          library.setClient(deps.createLibraryClient(instance));
        }
      } catch (error) {
        library.setClient(null);
        log(
          `Library API unavailable after authorization: ${safeErrorMessage(error)}`,
        );
      }
      await Promise.all([library.ensureLibraryCache(), pinning.reload()]);
      const storefront = String(instance.storefrontId ?? "").trim();
      if (storefront) setAccountSummary({ storefront, connectedAt: now() });
      log("Authorization successful.");
    } catch (error) {
      if (!authorized && invalidation) {
        try {
          cancelAccountDataInvalidation(invalidation);
        } catch (fenceError) {
          log(
            `Account data remains fenced after sign-in ended: ${safeErrorMessage(fenceError)}`,
          );
        }
      }
      if (attempt.abandoned) {
        // The user moved on; a rejection from the old popup is not an error.
        log(`Abandoned sign-in ended: ${safeErrorMessage(error)}`);
        return;
      }
      const message = safeErrorMessage(error);
      log(`Authorization failed: ${message}`);
      throw error;
    } finally {
      // A newer attempt may own the pending flag now; only the current one
      // clears it.
      if (authorizationStarted && signInAttempt === attempt) {
        signInAttempt = undefined;
        setAuthPending(false);
        void sessionHealth.afterTransition();
      }
    }
  };

  const authorizeAccount = (): Promise<void> => signIn({ reauth: false });

  const reauthorize = async (): Promise<void> => {
    if (getState().auth.pending) return;
    const instance = requireMusic();
    // MusicKit hands back the stale token without a popup while it still
    // looks valid, so it is dropped first; its own event is not a revocation.
    accountTransitions += 1;
    try {
      await unauthorize(instance);
    } finally {
      accountTransitions -= 1;
    }
    try {
      await signIn({ reauth: true });
    } finally {
      // A closed, cancelled, or rejected re-auth leaves MusicKit without a
      // token while Arlet still says "Connected". Expire it even mid-transition.
      expireUnlessAuthorized("re-auth did not finish with a user token");
    }
    // A cancelled or failed re-auth leaves the session expired; refresh only
    // once it is healthy again.
    const { auth } = getState();
    if (auth.status !== "authorized" || auth.sessionExpired) return;
    try {
      await deps.refreshCurrentData();
    } catch (error) {
      log(`Refresh after sign-in failed: ${safeErrorMessage(error)}`);
    }
  };

  const signOut = async (): Promise<void> => {
    // Establish the durable fence before resetting state or dropping Apple's
    // token. If storage cannot verify it, no destructive transition proceeds.
    beginAccountDataInvalidation();
    accountTransitions += 1;
    try {
      // Late responses from this account must not land after sign-out.
      resetAccountScope();
      // Recents are synchronous local storage. Clear them before publishing
      // the signed-out state, even while native data clears are still pending.
      clearRecentSearches();
      resetState();
      setPins([]);
      const persistedClear = clearPersistedAccountData();
      // The clear is also awaited below; this handler prevents an early
      // rejection from becoming unhandled while MusicKit is unauthorizing.
      void persistedClear.catch(() => undefined);
      const failures: unknown[] = [];
      let unauthorizeFailed = false;
      let instance: MusicKit.MusicKitInstance | undefined;
      try {
        instance = requireMusic();
        // Sign-out resets the UI to idle; audio must not keep playing.
        try {
          instance.stop?.();
        } catch (error) {
          log(`Stop before sign-out failed: ${safeErrorMessage(error)}`);
        }
        await unauthorize(instance);
      } catch (error) {
        unauthorizeFailed = true;
        failures.push(error);
      }
      try {
        await clearSignedInData(persistedClear);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        // MusicKit may still have the old account if unauthorize failed. Its
        // persisted data is empty or remains fenced, so restoring auth state
        // cannot reveal an old cache, pin list, or saved queue.
        let stillAuthorized = false;
        try {
          stillAuthorized =
            unauthorizeFailed &&
            instance !== undefined &&
            isAuthorized(instance);
        } catch {
          // An unreadable MusicKit state stays signed out in the UI.
        }
        if (stillAuthorized) {
          setAuthState({ status: "authorized" });
        }
        throw new Error(failures.map(safeErrorMessage).join("; "));
      }
      log("Signed out.");
    } catch (error) {
      const message = safeErrorMessage(error);
      log(`Sign out failed: ${message}`);
      throw error;
    } finally {
      accountTransitions -= 1;
    }
  };

  const cancelSignIn = (): void => {
    const attempt = signInAttempt;
    if (!attempt && getState().auth.pending !== true) return;
    if (attempt) {
      attempt.abandoned = true;
      signInAttempt = undefined;
      log("Sign-in cancelled; the Apple Music window may still finish.");
    }
    setAuthPending(false);
    if (attempt) expireUnlessAuthorized("sign-in cancelled");
  };

  return {
    authorize: authorizeAccount,
    reauthorize,
    signOut,
    cancelSignIn,
    onMusicKitAuthorizationChange,
    suspectSession: (error, path) => sessionHealth.suspect(error, path),
    generation: () => accountGeneration,
  };
}
