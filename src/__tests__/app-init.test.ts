import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../app/controller.ts";
import { disposeApplication, initializeApplication } from "../app-init.ts";
import { DiagnosticsStore } from "../diagnostics/store.ts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("native shell unavailable")),
}));

function controllerFor(order: string[]): AppController {
  return {
    loadSettings: vi.fn(async () => {
      order.push("loadSettings");
    }),
    initialize: vi.fn(async () => {
      order.push("initialize");
    }),
    startupUpdateCheck: vi.fn(async () => {
      order.push("startupUpdateCheck");
    }),
    log: vi.fn((message: string) => {
      order.push(`log:${message}`);
    }),
    setDiagnosticsEnvironment: vi.fn(),
  } as unknown as AppController;
}

afterEach(() => {
  disposeApplication();
});

describe("application startup wiring", () => {
  it("loads settings and initializes MusicKit before a production update check", async () => {
    const order: string[] = [];
    const controller = controllerFor(order);

    await initializeApplication(controller, new DiagnosticsStore(), {
      isDevelopment: false,
    });

    expect(order.slice(0, 3)).toEqual([
      "log:Running outside the Tauri shell; native diagnostics unavailable.",
      "loadSettings",
      "initialize",
    ]);
    expect(order.indexOf("startupUpdateCheck")).toBeGreaterThan(
      order.indexOf("initialize"),
    );
    expect(controller.startupUpdateCheck).toHaveBeenCalledOnce();
  });

  it("contains startup update failures without rejecting application startup", async () => {
    const order: string[] = [];
    const controller = controllerFor(order);
    vi.mocked(controller.startupUpdateCheck).mockRejectedValueOnce(
      new Error("offline feed"),
    );

    await expect(
      initializeApplication(controller, new DiagnosticsStore(), {
        isDevelopment: false,
      }),
    ).resolves.toBe(controller);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(order).toContain("initialize");
    expect(order).toContain("log:Startup update check failed: offline feed");
  });
});
