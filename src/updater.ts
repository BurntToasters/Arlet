import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { redactSensitive } from "./platform/redact.ts";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type UpdateChannel,
  type UpdateState,
} from "./state.ts";

export const UPDATE_CHECK_TIMEOUT_MS = 30_000;
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 120_000;
/**
 * Public beta manifests can briefly point at an asset while GitHub finishes
 * publishing it. Keep the retry window finite so a real download failure is
 * still surfaced to the user.
 */
export const UPDATE_DOWNLOAD_RETRY_DELAYS_MS = [1_000, 3_000, 7_000] as const;
/** Keep release-note parsing bounded even when a feed contains an oversized body. */
export const MAX_RELEASE_NOTES_BYTES = 64 * 1024;

export interface UpdateCheckOptions {
  target?: string;
  timeout?: number;
}

/** The small portion of the Tauri Update resource used by the app. */
export interface UpdaterUpdate {
  version: string;
  body?: string;
  download(
    onEvent?: (event: DownloadEvent) => void,
    options?: { timeout?: number },
  ): Promise<void>;
  install(options?: { restartAfterInstall?: boolean }): Promise<void>;
  close?(): Promise<void>;
}

export type UpdateCheck = (
  options?: UpdateCheckOptions,
) => Promise<UpdaterUpdate | null>;
export type UpdateVersion = () => Promise<string>;
export type UpdateInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export interface UpdaterServiceOptions {
  checkFn?: UpdateCheck;
  getVersionFn?: UpdateVersion;
  invokeFn?: UpdateInvoke;
  now?: () => number;
  /** Test hook for advancing the bounded beta-download retry backoff. */
  waitForRetry?: (delayMs: number) => Promise<void>;
  isDevelopment?: boolean;
  onStateChange?: (state: UpdateState) => void;
  onLog?: (message: string) => void;
}

export interface UpdaterService {
  configure(settings: AppSettings): void;
  startupCheck(): Promise<void>;
  checkNow(): Promise<void>;
  dismissPending(): void;
  installPending(): Promise<void>;
  dispose(): void;
}

const STABLE_CHANNEL = "stable" as const;
const BETA_CHANNEL = "beta" as const;
const BETA_TARGET_PATTERN = /^windows-beta-(x86_64|aarch64)-nsis$/u;
const PUBLISHED_BETA_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-beta\.(?:0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeErrorMessage(error: unknown): string {
  return redactSensitive(errorMessage(error))
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, 500);
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Release notes are optional metadata. Invalid metadata should never prevent a
 * signed update from downloading or installing, so unusable bodies are
 * represented as `undefined` and the UI supplies its generic fallback.
 */
export function normalizeReleaseNotes(body: unknown): string | undefined {
  if (typeof body !== "string" || !body.trim()) return undefined;
  if (!isWellFormedUtf16(body)) return undefined;
  try {
    if (new TextEncoder().encode(body).byteLength > MAX_RELEASE_NOTES_BYTES) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return body;
}

function releaseNotesForUpdate(
  update: UpdaterUpdate | null,
): string | undefined {
  if (!update) return undefined;
  try {
    return normalizeReleaseNotes(update.body);
  } catch {
    // A malformed resource getter is optional metadata, never a check error.
    return undefined;
  }
}

/** Auto follows the beta feed only for the beta versions Arlet publishes. */
export function isBetaVersion(version: string): boolean {
  return PUBLISHED_BETA_VERSION_PATTERN.test(version);
}

export function createUpdaterService(
  options: UpdaterServiceOptions = {},
): UpdaterService {
  const checkFn = options.checkFn ?? (check as unknown as UpdateCheck);
  const getVersionFn = options.getVersionFn ?? getVersion;
  const invokeFn = options.invokeFn ?? (invoke as unknown as UpdateInvoke);
  const now = options.now ?? Date.now;
  const waitForRetry = options.waitForRetry;
  const isDevelopment = options.isDevelopment ?? import.meta.env.DEV;
  const onStateChange = options.onStateChange ?? (() => undefined);
  const onLog = options.onLog ?? (() => undefined);

  let settings: AppSettings = { ...DEFAULT_SETTINGS };
  let state: UpdateState = {
    status: "idle",
    channel: settings.updateChannel,
    resolvedChannel: STABLE_CHANNEL,
    promptOpen: false,
  };
  let pendingUpdate: UpdaterUpdate | null = null;
  let pendingTarget: string | undefined;
  let pendingResolvedChannel: "stable" | "beta" = STABLE_CHANNEL;
  let checkInFlight: Promise<void> | null = null;
  let checkInFlightGeneration: number | null = null;
  let inFlightCheckIsInteractive = false;
  /** Native install must own the Update resource until its promise settles. */
  let installInFlight = false;
  let discardPendingAfterInstall = false;
  let generation = 0;
  let disposed = false;
  const retryWaiters = new Set<() => void>();

  const advanceGeneration = (): void => {
    generation += 1;
    // A channel change/dispose should wake a retry immediately. The stale
    // operation then closes its resource after its current native call settles.
    const waiters = [...retryWaiters];
    for (const cancel of waiters) cancel();
  };

  const emit = (patch: Partial<UpdateState>): void => {
    state = { ...state, ...patch, channel: settings.updateChannel };
    onStateChange({ ...state });
  };

  const closeUpdate = (update: UpdaterUpdate | null): void => {
    if (!update?.close) return;
    void update.close().catch((error: unknown) => {
      onLog(
        `Failed to release pending update resources: ${safeErrorMessage(error)}`,
      );
    });
  };

  const clearPending = (): void => {
    if (installInFlight) {
      // Closing an Update while install() is live races the native updater.
      // Defer cleanup until install() has settled instead.
      discardPendingAfterInstall = true;
      return;
    }
    const update = pendingUpdate;
    pendingUpdate = null;
    pendingTarget = undefined;
    pendingResolvedChannel = STABLE_CHANNEL;
    if (update) closeUpdate(update);
  };

  const discardPending = (): void => {
    if (installInFlight) {
      // Keep the native resource alive until install() resolves/rejects. A
      // failed install will be discarded once it is safe to close it.
      discardPendingAfterInstall = true;
      emit({ releaseNotes: undefined });
      return;
    }
    // Incrementing the generation also makes a currently downloading update
    // close itself as soon as the Tauri resource settles.
    advanceGeneration();
    clearPending();
    emit({
      status: "idle",
      target: undefined,
      version: undefined,
      progress: undefined,
      downloadedBytes: undefined,
      contentLength: undefined,
      releaseNotes: undefined,
      error: undefined,
      message: undefined,
      promptOpen: false,
    });
  };

  const isNotFoundError = (error: unknown): boolean => {
    if (typeof error === "object" && error !== null) {
      const candidate = error as {
        status?: unknown;
        statusCode?: unknown;
        code?: unknown;
      };
      if (
        candidate.status === 404 ||
        candidate.statusCode === 404 ||
        candidate.code === 404 ||
        candidate.code === "404"
      ) {
        return true;
      }
    }
    return /\b404\b|not[ -]?found/iu.test(errorMessage(error));
  };

  const waitForDownloadRetry = (
    delayMs: number,
    expectedGeneration: number,
  ): Promise<boolean> => {
    if (disposed || expectedGeneration !== generation) {
      return Promise.resolve(false);
    }
    if (waitForRetry) {
      return waitForRetry(delayMs).then(
        () => !disposed && expectedGeneration === generation,
      );
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (active: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        retryWaiters.delete(cancel);
        resolve(active && !disposed && expectedGeneration === generation);
      };
      const cancel = (): void => finish(false);
      retryWaiters.add(cancel);
      timer = setTimeout(() => finish(true), delayMs);
      if (disposed || expectedGeneration !== generation) finish(false);
    });
  };

  const betaTarget = async (): Promise<string> => {
    const target = await invokeFn<string>("get_beta_updater_target");
    if (!BETA_TARGET_PATTERN.test(target)) {
      throw new Error(
        `Native updater returned an invalid beta target: ${target}`,
      );
    }
    return target;
  };

  const resolveFeed = async (
    channel: UpdateChannel,
  ): Promise<{
    target: string | undefined;
    resolvedChannel: "stable" | "beta";
  }> => {
    if (channel === "stable") {
      return { target: undefined, resolvedChannel: STABLE_CHANNEL };
    }
    if (channel === "beta") {
      return { target: await betaTarget(), resolvedChannel: BETA_CHANNEL };
    }
    const version = await getVersionFn();
    if (!isBetaVersion(version)) {
      return { target: undefined, resolvedChannel: STABLE_CHANNEL };
    }
    return { target: await betaTarget(), resolvedChannel: BETA_CHANNEL };
  };

  const checkFeed = async (
    target: string | undefined,
  ): Promise<UpdaterUpdate | null> => {
    const checkOptions: UpdateCheckOptions = {
      timeout: UPDATE_CHECK_TIMEOUT_MS,
      ...(target ? { target } : {}),
    };
    try {
      const update = await checkFn(checkOptions);
      // Beta manifests are synchronized onto the latest stable release. A
      // second lookup masks the short window while GitHub assets are renamed.
      if (!update && target) return await checkFn(checkOptions);
      return update;
    } catch (error) {
      if (!target) throw error;
      return await checkFn(checkOptions);
    }
  };

  const downloadUpdate = async (
    update: UpdaterUpdate,
    target: string | undefined,
    checkGeneration: number,
    onEvent: (event: DownloadEvent) => void,
  ): Promise<boolean> => {
    let retryIndex = 0;
    while (true) {
      try {
        await update.download(onEvent, { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS });
        return true;
      } catch (error) {
        if (
          !target ||
          !isNotFoundError(error) ||
          retryIndex >= UPDATE_DOWNLOAD_RETRY_DELAYS_MS.length
        ) {
          throw error;
        }
        if (disposed || checkGeneration !== generation) return false;
        const delayMs = UPDATE_DOWNLOAD_RETRY_DELAYS_MS[retryIndex];
        retryIndex += 1;
        onLog(
          `Beta update download returned 404; retrying in ${delayMs}ms (${retryIndex}/${UPDATE_DOWNLOAD_RETRY_DELAYS_MS.length}).`,
        );
        if (!(await waitForDownloadRetry(delayMs, checkGeneration))) {
          return false;
        }
      }
    }
  };

  const runCheck = async (interactive: boolean): Promise<void> => {
    let checkedUpdate: UpdaterUpdate | null = null;
    const checkGeneration = generation;
    const checkChannel = settings.updateChannel;
    try {
      if (disposed || isDevelopment) return;
      // Mark the whole operation busy, including target/version resolution, so
      // settings controls cannot change underneath an in-flight check.
      emit({
        status: "checking",
        releaseNotes: pendingUpdate
          ? releaseNotesForUpdate(pendingUpdate)
          : undefined,
        message: interactive ? undefined : "Checking for updates…",
        error: undefined,
        promptOpen: false,
      });
      const feed = await resolveFeed(checkChannel);
      if (disposed || checkGeneration !== generation) return;

      emit({
        resolvedChannel: feed.resolvedChannel,
        target: feed.target,
      });

      if (
        pendingUpdate &&
        (pendingTarget !== feed.target ||
          pendingResolvedChannel !== feed.resolvedChannel)
      ) {
        clearPending();
        emit({ releaseNotes: undefined });
      }
      if (pendingUpdate) {
        emit({
          status: "ready",
          releaseNotes: releaseNotesForUpdate(pendingUpdate),
          promptOpen: interactive || state.promptOpen,
          error: undefined,
          message: "Update downloaded and ready to install.",
        });
        return;
      }

      onLog(
        `Update check started (interactive=${interactive}, target=${feed.target ?? "default"}).`,
      );
      checkedUpdate = await checkFeed(feed.target);
      if (disposed || checkGeneration !== generation) {
        closeUpdate(checkedUpdate);
        checkedUpdate = null;
        return;
      }
      if (!checkedUpdate) {
        onLog(
          interactive
            ? "No updates available."
            : "Auto-update check: no updates available.",
        );
        emit({
          status: "up-to-date",
          version: undefined,
          progress: undefined,
          downloadedBytes: undefined,
          contentLength: undefined,
          releaseNotes: undefined,
          message: "You are running the latest version.",
          error: undefined,
          promptOpen: false,
          lastCheckedAt: now(),
        });
        return;
      }

      onLog(`Update available: ${checkedUpdate.version}`);
      let downloadedBytes = 0;
      let contentLength: number | undefined;
      emit({
        status: "downloading",
        version: checkedUpdate.version,
        progress: 0,
        downloadedBytes: 0,
        contentLength: undefined,
        releaseNotes: undefined,
        message: `Downloading version ${checkedUpdate.version}…`,
        error: undefined,
        promptOpen: false,
      });
      const downloaded = await downloadUpdate(
        checkedUpdate,
        feed.target,
        checkGeneration,
        (event: DownloadEvent): void => {
          if (disposed || checkGeneration !== generation) return;
          if (event.event === "Started") {
            downloadedBytes = 0;
            contentLength = event.data.contentLength;
          } else if (event.event === "Progress") {
            downloadedBytes += event.data.chunkLength;
          } else if (
            event.event === "Finished" &&
            contentLength !== undefined
          ) {
            downloadedBytes = contentLength;
          }
          emit({
            status: "downloading",
            progress:
              contentLength && contentLength > 0
                ? Math.min(1, downloadedBytes / contentLength)
                : undefined,
            downloadedBytes,
            contentLength,
          });
        },
      );
      if (!downloaded || disposed || checkGeneration !== generation) {
        closeUpdate(checkedUpdate);
        checkedUpdate = null;
        return;
      }

      pendingUpdate = checkedUpdate;
      pendingTarget = feed.target;
      pendingResolvedChannel = feed.resolvedChannel;
      checkedUpdate = null;
      onLog(`Update ${pendingUpdate.version} downloaded and ready to install.`);
      emit({
        status: "ready",
        version: pendingUpdate.version,
        progress: 1,
        downloadedBytes,
        contentLength,
        releaseNotes: releaseNotesForUpdate(pendingUpdate),
        message: "Update downloaded and ready to install.",
        error: undefined,
        promptOpen: true,
        lastCheckedAt: now(),
      });
    } catch (error) {
      if (disposed || checkGeneration !== generation) return;
      const message = safeErrorMessage(error);
      onLog(
        `${interactive ? "Updater error" : "Update check failed"}: ${message}`,
      );
      emit({
        status: "error",
        message: interactive
          ? `Failed to check for updates. ${message}`
          : "Unable to check for updates.",
        error: message,
        releaseNotes: pendingUpdate
          ? releaseNotesForUpdate(pendingUpdate)
          : undefined,
        promptOpen: false,
        lastCheckedAt: now(),
      });
    } finally {
      if (checkedUpdate && checkedUpdate !== pendingUpdate) {
        closeUpdate(checkedUpdate);
      }
    }
  };

  const startCheck = (interactive: boolean): Promise<void> => {
    if (disposed || isDevelopment || installInFlight) return Promise.resolve();
    if (checkInFlight) {
      const checkIsStale = checkInFlightGeneration !== generation;
      if (checkIsStale || (interactive && !inFlightCheckIsInteractive)) {
        // A channel change invalidates the existing promise. Always queue a
        // fresh check for the current generation instead of handing the
        // caller the stale promise and swallowing its manual request.
        return checkInFlight.then(() => startCheck(interactive));
      }
      return checkInFlight;
    }
    checkInFlightGeneration = generation;
    inFlightCheckIsInteractive = interactive;
    checkInFlight = runCheck(interactive).finally(() => {
      checkInFlight = null;
      checkInFlightGeneration = null;
      inFlightCheckIsInteractive = false;
    });
    return checkInFlight;
  };

  return {
    configure(nextSettings: AppSettings): void {
      const channelChanged =
        settings.updateChannel !== nextSettings.updateChannel;
      settings = { ...nextSettings };
      emit({ channel: settings.updateChannel });
      if (channelChanged) discardPending();
    },

    startupCheck(): Promise<void> {
      if (settings.autoCheckUpdates !== true) return Promise.resolve();
      return startCheck(false);
    },

    checkNow(): Promise<void> {
      return startCheck(true);
    },

    dismissPending(): void {
      if (!pendingUpdate || state.status === "installing") return;
      emit({
        status: "ready",
        promptOpen: false,
        error: undefined,
        message: "Update downloaded and ready to install.",
      });
    },

    async installPending(): Promise<void> {
      const update = pendingUpdate;
      if (!update || state.status === "installing") return;
      const installGeneration = generation;
      installInFlight = true;
      emit({
        status: "installing",
        promptOpen: false,
        error: undefined,
        message: `Installing version ${update.version}…`,
      });
      try {
        // On Windows the passive NSIS updater exits and starts Arlet again.
        // Do not invoke a second process restart; it would race that handoff.
        await update.install();
        // install() has settled, so it is now safe to detach the resource.
        if (pendingUpdate === update) {
          pendingUpdate = null;
          pendingTarget = undefined;
          pendingResolvedChannel = STABLE_CHANNEL;
        }
        if (!disposed && installGeneration === generation) {
          emit({
            status: "idle",
            version: undefined,
            progress: undefined,
            downloadedBytes: undefined,
            contentLength: undefined,
            releaseNotes: undefined,
            promptOpen: false,
            message: "Update installed. Restarting Arlet…",
            error: undefined,
          });
        }
      } catch (error) {
        if (disposed || installGeneration !== generation) return;
        const message = safeErrorMessage(error);
        onLog(`Update install failed: ${message}`);
        emit({
          status: "ready",
          promptOpen: true,
          message: "Update is ready to install.",
          error: `Failed to install update. ${message}`,
        });
        throw error;
      } finally {
        installInFlight = false;
        if (discardPendingAfterInstall) {
          discardPendingAfterInstall = false;
          if (pendingUpdate) {
            advanceGeneration();
            clearPending();
            if (!disposed) {
              emit({
                status: "idle",
                target: undefined,
                version: undefined,
                progress: undefined,
                downloadedBytes: undefined,
                contentLength: undefined,
                releaseNotes: undefined,
                error: undefined,
                message: undefined,
                promptOpen: false,
              });
            }
          }
        }
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      advanceGeneration();
      clearPending();
      emit({ releaseNotes: undefined });
    },
  };
}

export function updateChannelLabel(channel: UpdateChannel): string {
  switch (channel) {
    case "stable":
      return "Stable releases";
    case "beta":
      return "Beta releases";
    case "auto":
      return "Follow installed version";
  }
}
