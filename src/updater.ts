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

export interface UpdateCheckOptions {
  target?: string;
  timeout?: number;
}

/** The small portion of the Tauri Update resource used by the app. */
export interface UpdaterUpdate {
  version: string;
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
  let inFlightCheckIsInteractive = false;
  let generation = 0;
  let disposed = false;

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
    const update = pendingUpdate;
    pendingUpdate = null;
    pendingTarget = undefined;
    pendingResolvedChannel = STABLE_CHANNEL;
    if (update) closeUpdate(update);
  };

  const discardPending = (): void => {
    // Incrementing the generation also makes a currently downloading update
    // close itself as soon as the Tauri resource settles.
    generation += 1;
    clearPending();
    emit({
      status: "idle",
      target: undefined,
      version: undefined,
      progress: undefined,
      downloadedBytes: undefined,
      contentLength: undefined,
      error: undefined,
      message: undefined,
      promptOpen: false,
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

  const resolveFeed = async (): Promise<{
    target: string | undefined;
    resolvedChannel: "stable" | "beta";
  }> => {
    if (settings.updateChannel === "stable") {
      return { target: undefined, resolvedChannel: STABLE_CHANNEL };
    }
    if (settings.updateChannel === "beta") {
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

  const runCheck = async (interactive: boolean): Promise<void> => {
    let checkedUpdate: UpdaterUpdate | null = null;
    const checkGeneration = generation;
    try {
      if (disposed || isDevelopment) return;
      const feed = await resolveFeed();
      if (disposed || checkGeneration !== generation) return;

      emit({
        resolvedChannel: feed.resolvedChannel,
        target: feed.target,
        ...(interactive
          ? {
              status: "checking" as const,
              message: undefined,
              error: undefined,
              promptOpen: false,
            }
          : {}),
      });

      if (
        pendingUpdate &&
        (pendingTarget !== feed.target ||
          pendingResolvedChannel !== feed.resolvedChannel)
      ) {
        clearPending();
      }
      if (pendingUpdate) {
        if (interactive) {
          emit({
            status: "ready",
            promptOpen: true,
            error: undefined,
            message: "Update downloaded and ready to install.",
          });
        }
        return;
      }

      if (!interactive) {
        emit({
          status: "checking",
          message: "Checking for updates…",
          error: undefined,
          promptOpen: false,
        });
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
        message: `Downloading version ${checkedUpdate.version}…`,
        error: undefined,
        promptOpen: false,
      });
      await checkedUpdate.download(
        (event: DownloadEvent): void => {
          if (disposed || checkGeneration !== generation) return;
          if (event.event === "Started") {
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
        { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS },
      );
      if (disposed || checkGeneration !== generation) {
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
    if (disposed || isDevelopment) return Promise.resolve();
    if (checkInFlight) {
      if (interactive && !inFlightCheckIsInteractive) {
        return checkInFlight.then(() => startCheck(true));
      }
      return checkInFlight;
    }
    inFlightCheckIsInteractive = interactive;
    checkInFlight = runCheck(interactive).finally(() => {
      checkInFlight = null;
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
        if (disposed || installGeneration !== generation) return;
        pendingUpdate = null;
        pendingTarget = undefined;
        pendingResolvedChannel = STABLE_CHANNEL;
        emit({
          status: "idle",
          version: undefined,
          progress: undefined,
          downloadedBytes: undefined,
          contentLength: undefined,
          promptOpen: false,
          message: "Update installed. Restarting Arlet…",
          error: undefined,
        });
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
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
      clearPending();
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
