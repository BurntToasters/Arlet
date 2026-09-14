import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { h } from "preact";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnosticsController } from "../app/App.tsx";
import type { AppController } from "../app/controller.ts";
import { DiagnosticsDrawer } from "../components/diagnostics/DiagnosticsDrawer.tsx";
import { DiagnosticsStore } from "../diagnostics/store.ts";
import type { DiagnosticsDrawerProps } from "../diagnostics/types.ts";
import {
  appendDiagnosticLog,
  getState,
  resetApplicationState,
} from "../state.ts";

describe("DiagnosticsDrawer", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    sessionStorage.clear();
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    resetApplicationState();
  });

  function renderDrawer(
    overrides: Partial<DiagnosticsDrawerProps> = {},
  ): DiagnosticsDrawerProps {
    const props: DiagnosticsDrawerProps = {
      open: true,
      onClose: vi.fn(),
      appSnapshot: {
        tracksPlayed: 2,
        consecutiveQueueReady: true,
        checklist: {},
      },
      store: new DiagnosticsStore(),
      ...overrides,
    };
    render(h(DiagnosticsDrawer, props), root);
    return props;
  }

  it("renders semantic tabs, console controls, and redacted entries", () => {
    const store = new DiagnosticsStore();
    store.log("Authorization: Bearer eyJsecret");
    renderDrawer({ store });

    const drawer = root.querySelector("aside.diagnostics-drawer");
    expect(drawer).not.toBeNull();
    expect(drawer?.getAttribute("aria-labelledby")).toBe("diagnostics-title");
    expect(drawer?.getAttribute("aria-modal")).toBeNull();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(root.textContent).toContain("Console");
    expect(root.textContent).toContain("Copy console");
    expect(root.textContent).toContain("Clear session");
    expect(root.textContent).not.toContain("eyJsecret");
  });

  it("switches to feasibility and invokes checklist/report actions", async () => {
    const onToggleChecklist = vi.fn();
    const onCopyFeasibility = vi.fn();
    const onCopyNetwork = vi.fn();
    const onQueueConsecutive = vi.fn();
    const onOpenMusicDiagnostic = vi.fn();
    const props = renderDrawer({
      controller: {
        onToggleChecklist,
        onCopyFeasibility,
        onCopyNetwork,
        onQueueConsecutive,
        onOpenMusicDiagnostic,
      },
    });

    const feasibilityTab = root.querySelector(
      "#diagnostics-tab-feasibility",
    ) as HTMLButtonElement;
    feasibilityTab.click();
    await Promise.resolve();
    expect(root.querySelector('[role="tabpanel"]')?.textContent).toContain(
      "Authorization",
    );

    const checkbox = root.querySelector(
      ".diagnostics-check-item input",
    ) as HTMLInputElement;
    checkbox.click();
    expect(onToggleChecklist).toHaveBeenCalledWith("auth-init", true);

    const buttons = [...root.querySelectorAll("button")];
    const button = (label: string): HTMLButtonElement =>
      buttons.find((item) =>
        item.textContent?.includes(label),
      ) as HTMLButtonElement;
    button("Copy feasibility report").click();
    button("Copy network surface").click();
    button("Open music.apple.com diagnostic").click();
    button("Queue 20 consecutive").click();
    await Promise.resolve();

    expect(onCopyFeasibility).toHaveBeenCalledWith(
      expect.stringContaining("MusicKit + Tauri v2 Feasibility Report"),
    );
    expect(onCopyNetwork).toHaveBeenCalledWith(
      expect.stringContaining("MusicKit Network Surface"),
    );
    expect(onOpenMusicDiagnostic).toHaveBeenCalledTimes(1);
    expect(onQueueConsecutive).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("calls close and keeps release-safe absent callbacks disabled", async () => {
    const onClose = vi.fn();
    renderDrawer({ onClose, appSnapshot: { consecutiveQueueReady: false } });

    (root.querySelector(".diagnostics-close") as HTMLButtonElement).click();
    expect(onClose).toHaveBeenCalledTimes(1);
    const feasibilityTab = root.querySelector(
      "#diagnostics-tab-feasibility",
    ) as HTMLButtonElement;
    feasibilityTab.click();
    await Promise.resolve();
    const queueButton = [...root.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Queue 20"),
    ) as HTMLButtonElement;
    const diagnosticButton = [...root.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("music.apple.com"),
    ) as HTMLButtonElement;
    expect(queueButton.disabled).toBe(true);
    expect(diagnosticButton.disabled).toBe(true);
  });

  it("is styled as a bottom drawer above the player surface", () => {
    const styles = readFileSync(
      resolve(process.cwd(), "src/styles/base.css"),
      "utf8",
    );
    const drawerStart = styles.indexOf(".diagnostics-drawer {");
    const headerStart = styles.indexOf(".diagnostics-header {");
    const drawerRules = styles.slice(drawerStart, headerStart);
    expect(drawerRules).toContain("bottom: var(--player-height)");
    expect(drawerRules).toContain("left: var(--sidebar-width)");
    expect(drawerRules).toContain(
      "border-radius: var(--radius-md) var(--radius-md) 0 0",
    );
    expect(styles).toMatch(
      /\.diagnostics-drawer \{\s+right: 0;\s+left: 0;[\s\S]*?68vh/,
    );
  });

  it("clears store and legacy failures so the next report is clean", async () => {
    const store = new DiagnosticsStore();
    appendDiagnosticLog("[test] DRM failed", true);
    store.log("DRM failed", { level: "error" });
    const onCopyFeasibility = vi.fn();
    const controller = diagnosticsController({} as AppController);
    const props = renderDrawer({
      store,
      appSnapshot: {
        tracksPlayed: 0,
        failures: getState().diagnostics.failures,
      },
      controller: { ...controller, onCopyFeasibility },
    });

    expect(store.getSnapshot().failures).toHaveLength(1);
    const clearButton = [...root.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Clear session"),
    ) as HTMLButtonElement;
    clearButton.click();
    await Promise.resolve();
    expect(store.getSnapshot().entries).toEqual([]);
    expect(store.getSnapshot().failures).toEqual([]);
    expect(getState().diagnostics.failures).toEqual([]);

    render(
      h(DiagnosticsDrawer, {
        ...props,
        appSnapshot: {
          tracksPlayed: 0,
          failures: getState().diagnostics.failures,
        },
      }),
      root,
    );
    (
      root.querySelector("#diagnostics-tab-feasibility") as HTMLButtonElement
    ).click();
    await Promise.resolve();
    const copyButton = [...root.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Copy feasibility report"),
    ) as HTMLButtonElement;
    copyButton.click();
    await Promise.resolve();
    expect(onCopyFeasibility).toHaveBeenCalledWith(
      expect.not.stringContaining("DRM failed"),
    );
  });
});
