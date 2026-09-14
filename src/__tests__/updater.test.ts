import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUpdaterService,
  isBetaVersion,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
  type UpdaterUpdate,
} from "../updater.ts";
import {
  DEFAULT_SETTINGS,
  getState,
  resetApplicationState,
  setUpdateState,
  type AppSettings,
} from "../state.ts";

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

function updateResource(patch: Partial<UpdaterUpdate> = {}): UpdaterUpdate {
  return {
    version: "0.2.0",
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...patch,
  };
}

describe("updater", () => {
  beforeEach(() => {
    resetApplicationState();
  });

  it("recognizes published beta versions for auto channel selection", () => {
    expect(isBetaVersion("0.2.0-beta.3")).toBe(true);
    expect(isBetaVersion("0.2.0-beta.3+build.5")).toBe(true);
    expect(isBetaVersion("0.2.0")).toBe(false);
    expect(isBetaVersion("0.2.0-rc.1")).toBe(false);
    expect(isBetaVersion("0.2.0-beta")).toBe(false);
    expect(isBetaVersion("0.2.0-beta.03")).toBe(false);
    expect(isBetaVersion("0.2.0-beta.3.extra")).toBe(false);
    expect(isBetaVersion(" 0.2.0-beta.3")).toBe(false);
    expect(isBetaVersion("0.2.0-beta.3 ")).toBe(false);
  });

  it("does not access updater APIs in development builds", async () => {
    const check = vi.fn().mockResolvedValue(null);
    const getVersion = vi.fn().mockResolvedValue("0.1.0-beta.1");
    const invoke = vi.fn().mockResolvedValue("windows-beta-x86_64-nsis");
    const service = createUpdaterService({
      isDevelopment: true,
      checkFn: check,
      getVersionFn: getVersion,
      invokeFn: invoke,
      onStateChange: setUpdateState,
    });

    await service.startupCheck();
    await service.checkNow();

    expect(check).not.toHaveBeenCalled();
    expect(getVersion).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    service.dispose();
  });

  it("resolves explicit beta and auto beta feeds to the native target", async () => {
    const check = vi.fn().mockResolvedValue(null);
    const invoke = vi.fn().mockResolvedValue("windows-beta-x86_64-nsis");
    const getVersion = vi.fn().mockResolvedValue("0.1.0-beta.1");
    const service = createUpdaterService({
      isDevelopment: false,
      checkFn: check,
      getVersionFn: getVersion,
      invokeFn: invoke,
      onStateChange: setUpdateState,
    });

    service.configure(settings({ updateChannel: "beta" }));
    await service.checkNow();
    expect(check).toHaveBeenLastCalledWith({
      target: "windows-beta-x86_64-nsis",
      timeout: UPDATE_CHECK_TIMEOUT_MS,
    });

    service.configure(settings({ updateChannel: "auto" }));
    await service.checkNow();
    expect(getVersion).toHaveBeenCalledOnce();
    expect(check).toHaveBeenLastCalledWith({
      target: "windows-beta-x86_64-nsis",
      timeout: UPDATE_CHECK_TIMEOUT_MS,
    });
    service.dispose();
  });

  it("uses the stable feed for explicit stable checks", async () => {
    const check = vi.fn().mockResolvedValue(null);
    const getVersion = vi.fn().mockResolvedValue("0.1.0-beta.1");
    const service = createUpdaterService({
      isDevelopment: false,
      checkFn: check,
      getVersionFn: getVersion,
      onStateChange: setUpdateState,
    });

    service.configure(settings({ updateChannel: "stable" }));
    await service.checkNow();

    expect(check).toHaveBeenCalledWith({ timeout: UPDATE_CHECK_TIMEOUT_MS });
    expect(getVersion).not.toHaveBeenCalled();
    expect(getState().updates.resolvedChannel).toBe("stable");
    service.dispose();
  });

  it("uses the stable feed for auto checks on stable versions", async () => {
    const check = vi.fn().mockResolvedValue(null);
    const getVersion = vi.fn().mockResolvedValue("0.1.0");
    const service = createUpdaterService({
      isDevelopment: false,
      checkFn: check,
      getVersionFn: getVersion,
      onStateChange: setUpdateState,
    });

    await service.checkNow();

    expect(getVersion).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledWith({ timeout: UPDATE_CHECK_TIMEOUT_MS });
    expect(getState().updates.resolvedChannel).toBe("stable");
    service.dispose();
  });

  it("retries beta checks after a null result and after a feed error", async () => {
    const invoke = vi.fn().mockResolvedValue("windows-beta-x86_64-nsis");
    const check = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const service = createUpdaterService({
      isDevelopment: false,
      checkFn: check,
      invokeFn: invoke,
      onStateChange: setUpdateState,
    });

    service.configure(settings({ updateChannel: "beta" }));
    await service.checkNow();
    expect(check).toHaveBeenCalledTimes(2);

    check.mockReset();
    check
      .mockRejectedValueOnce(new Error("feed swap"))
      .mockResolvedValueOnce(null);
    await service.checkNow();
    expect(check).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it("coalesces overlapping checks", async () => {
    let resolveCheck: (update: UpdaterUpdate | null) => void = () => undefined;
    const check = vi.fn(
      () =>
        new Promise<UpdaterUpdate | null>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const service = createUpdaterService({
      isDevelopment: false,
      checkFn: check,
      getVersionFn: vi.fn().mockResolvedValue("0.1.0"),
      onStateChange: setUpdateState,
    });

    const first = service.checkNow();
    const second = service.checkNow();
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
    resolveCheck(null);
    await Promise.all([first, second]);
    service.dispose();
  });

  it("downloads with progress, keeps Later pending, then installs without relaunch", async () => {
    let downloadEvent: ((event: never) => void) | undefined;
    const install = vi.fn().mockResolvedValue(undefined);
    const resource = updateResource({
      install,
      download: vi.fn((onEvent?: (event: never) => void) => {
        downloadEvent = onEvent;
        onEvent?.({
          event: "Started",
          data: { contentLength: 100 },
        } as never);
        onEvent?.({
          event: "Progress",
          data: { chunkLength: 25 },
        } as never);
        return Promise.resolve();
      }),
    });
    const check = vi.fn().mockResolvedValue(resource);
    const service = createUpdaterService({
      isDevelopment: false,
      checkFn: check,
      getVersionFn: vi.fn().mockResolvedValue("0.1.0"),
      onStateChange: setUpdateState,
    });

    const checking = service.checkNow();
    await vi.waitFor(() => expect(downloadEvent).toBeDefined());
    await checking;

    expect(resource.download).toHaveBeenCalledWith(expect.any(Function), {
      timeout: UPDATE_DOWNLOAD_TIMEOUT_MS,
    });
    expect(getState().updates.progress).toBe(1);
    expect(getState().updates.status).toBe("ready");
    expect(getState().updates.promptOpen).toBe(true);

    service.dismissPending();
    expect(getState().updates.promptOpen).toBe(false);
    await service.checkNow();
    expect(getState().updates.promptOpen).toBe(true);

    await service.installPending();
    expect(install).toHaveBeenCalledOnce();
    expect(getState().updates.status).toBe("idle");
    service.dispose();
  });

  it("closes a pending resource when the channel changes", async () => {
    const resource = updateResource();
    const service = createUpdaterService({
      isDevelopment: false,
      checkFn: vi.fn().mockResolvedValue(resource),
      getVersionFn: vi.fn().mockResolvedValue("0.1.0"),
      onStateChange: setUpdateState,
    });
    await service.checkNow();

    service.configure(settings({ updateChannel: "beta" }));
    await Promise.resolve();
    expect(resource.close).toHaveBeenCalledOnce();
    expect(getState().updates.status).toBe("idle");
    service.dispose();
  });

  it("retains the downloaded resource when install fails", async () => {
    const install = vi.fn().mockRejectedValue(new Error("installer failed"));
    const resource = updateResource({ install });
    const service = createUpdaterService({
      isDevelopment: false,
      checkFn: vi.fn().mockResolvedValue(resource),
      getVersionFn: vi.fn().mockResolvedValue("0.1.0"),
      onStateChange: setUpdateState,
    });

    await service.checkNow();
    await expect(service.installPending()).rejects.toThrow("installer failed");

    expect(install).toHaveBeenCalledOnce();
    expect(resource.close).not.toHaveBeenCalled();
    expect(getState().updates.status).toBe("ready");
    expect(getState().updates.promptOpen).toBe(true);
    service.dismissPending();
    await service.checkNow();
    expect(getState().updates.promptOpen).toBe(true);
    service.dispose();
  });

  it("reports check failures without throwing into startup", async () => {
    const check = vi.fn().mockRejectedValue(new Error("network down"));
    const logs: string[] = [];
    const service = createUpdaterService({
      isDevelopment: false,
      checkFn: check,
      getVersionFn: vi.fn().mockResolvedValue("0.1.0"),
      onStateChange: setUpdateState,
      onLog: (message) => logs.push(message),
    });

    await expect(service.startupCheck()).resolves.toBeUndefined();
    expect(getState().updates.status).toBe("error");
    expect(getState().updates.error).toBe("network down");
    expect(logs).toContain("Update check failed: network down");
    service.dispose();
  });
});
