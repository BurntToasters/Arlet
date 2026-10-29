import { httpStatusOf, musicKitReasonOf } from "../musickit/errors.ts";

/** Least time between two verification probes. */
export const PROBE_COOLDOWN_MS = 30_000;

/** MusicKit reasons that can mean the user token is dead. */
const SUSPECT_REASONS = new Set([
  "AUTHORIZATION_ERROR",
  "UNAUTHORIZED_ERROR",
  "ACCESS_DENIED",
  "TOKEN_EXPIRED",
  "MEDIA_LICENSE",
]);
const REJECTED_REASONS = new Set(["UNAUTHORIZED_ERROR", "ACCESS_DENIED"]);

export interface SessionHealthDependencies {
  /** One cheap user-scoped request, sent past the expiry guard. */
  probe(): Promise<unknown>;
  /** The probe was refused with 401 or 403. */
  onExpired(reason: string): void;
  /** False when expiry is already known or sign-in is in flux. */
  active(): boolean;
  /** Account ownership for probes and deferred checks. */
  epoch(): number;
  /** MusicKit's own `isAuthorized`; false means it holds no user token. */
  musicKitAuthorized(): boolean;
  now(): number;
  log(message: string): void;
}

export interface SessionHealth {
  /** Flags an error that may mean an expired sign-in, then verifies once. */
  suspect(error: unknown, path?: string): void;
  verify(): Promise<void>;
  /**
   * Runs the check a sign-in in progress deferred. Errors from requests sent
   * while it finished would otherwise never be looked at again.
   */
  afterTransition(): Promise<void>;
}

/**
 * A single forbidden resource or a dropped connection must not read as an
 * expired sign-in, so a suspect error only triggers one rate-limited probe,
 * and only a 401 or 403 from that probe counts.
 */
export function createSessionHealth(
  dependencies: SessionHealthDependencies,
): SessionHealth {
  let inFlight: { epoch: number; promise: Promise<void> } | undefined;
  let lastProbeAt = Number.NEGATIVE_INFINITY;
  let lastProbeEpoch = dependencies.epoch();
  /** A suspect error arrived while a sign-in was still in progress. */
  let deferredEpoch: number | undefined;

  const syncEpoch = (epoch: number): void => {
    if (lastProbeEpoch !== epoch) {
      lastProbeEpoch = epoch;
      lastProbeAt = Number.NEGATIVE_INFINITY;
    }
    if (deferredEpoch !== undefined && deferredEpoch !== epoch) {
      deferredEpoch = undefined;
    }
  };

  const verify = (): Promise<void> => {
    const epoch = dependencies.epoch();
    syncEpoch(epoch);
    if (inFlight?.epoch === epoch) return inFlight.promise;
    if (!dependencies.active()) {
      deferredEpoch = epoch;
      return Promise.resolve();
    }
    deferredEpoch = undefined;
    if (!dependencies.musicKitAuthorized()) {
      // MusicKit already dropped the token, so no probe can succeed.
      if (dependencies.epoch() === epoch && dependencies.active()) {
        dependencies.onExpired("MusicKit no longer holds a user token");
      }
      return Promise.resolve();
    }
    const at = dependencies.now();
    if (at - lastProbeAt < PROBE_COOLDOWN_MS) return Promise.resolve();
    lastProbeAt = at;
    const flight = { epoch, promise: Promise.resolve() };
    inFlight = flight;
    flight.promise = (async () => {
      try {
        await dependencies.probe();
        if (dependencies.epoch() === epoch && dependencies.active()) {
          dependencies.log("Sign-in check passed.");
        }
      } catch (error) {
        if (dependencies.epoch() !== epoch || !dependencies.active()) return;
        const status = httpStatusOf(error);
        const reason = musicKitReasonOf(error);
        if (
          status === 401 ||
          status === 403 ||
          (reason !== undefined && REJECTED_REASONS.has(reason))
        ) {
          dependencies.onExpired(
            `Apple rejected the sign-in (${status ?? reason})`,
          );
        } else {
          dependencies.log("Sign-in check inconclusive; keeping the session.");
        }
      } finally {
        // An older request must not clear a newer epoch's deduplication slot.
        if (inFlight === flight) inFlight = undefined;
      }
    })();
    return flight.promise;
  };

  return {
    suspect(error, path) {
      const reason = musicKitReasonOf(error);
      const status = httpStatusOf(error);
      const suspicious =
        (reason !== undefined && SUSPECT_REASONS.has(reason)) ||
        (path?.startsWith("/v1/me") === true &&
          (status === 401 || status === 403));
      if (suspicious) void verify();
    },
    verify,
    afterTransition(): Promise<void> {
      const epoch = dependencies.epoch();
      syncEpoch(epoch);
      if (deferredEpoch !== epoch) return Promise.resolve();
      // The deferred errors came from the new sign-in; an older probe's
      // cooldown must not hide them.
      lastProbeAt = Number.NEGATIVE_INFINITY;
      deferredEpoch = undefined;
      return verify();
    },
  };
}
