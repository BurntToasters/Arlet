import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "preact/test-utils";
import { h, render } from "preact";
import { createAppController } from "../app/controller.ts";
import {
  LicensesDialog,
  loadLicenseInventory,
} from "../components/LicensesDialog.tsx";
import { DiagnosticsStore } from "../diagnostics/store.ts";
import { resetApplicationState } from "../state.ts";

// Failure modes: release users cannot hand over diagnostics; the copied
// report leaks a token; the licenses screen shows nothing when one
// inventory fails, crashes on malformed JSON, or cannot find a package.
describe("support: diagnostics report", () => {
  beforeEach(() => resetApplicationState());

  it("copies a redacted report to the clipboard", async () => {
    const store = new DiagnosticsStore();
    store.log("Playback failed for Music-User-Token: AqmL0f7xY2Zp9wR3kT8vN1b");
    const writeClipboardText = vi.fn().mockResolvedValue(undefined);
    const controller = createAppController({
      diagnosticsStore: store,
      writeClipboardText,
    });
    await controller.copyDiagnosticsReport?.();
    expect(writeClipboardText).toHaveBeenCalledOnce();
    const report = String(writeClipboardText.mock.calls[0]?.[0]);
    expect(report).toContain("# Arlet diagnostics report");
    expect(report).toContain("Playback failed");
    expect(report).not.toContain("AqmL0f7xY2Zp9wR3kT8vN1b");
    controller.dispose();
  });
});

describe("support: licenses", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.append(root);
  });

  afterEach(() => {
    void act(() => render(null, root));
    root.remove();
  });

  it("merges npm and cargo inventories and tolerates one failing", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url === "/licenses.json") {
        return {
          "preact@10.0.0": { licenses: "MIT", licenseText: "MIT text" },
        };
      }
      throw new Error("missing");
    });
    const entries = await loadLicenseInventory(fetchJson);
    expect(entries).toEqual([
      { name: "preact@10.0.0", licenses: "MIT", licenseText: "MIT text" },
    ]);
    const malformed = await loadLicenseInventory(async () => "not json");
    expect(malformed).toEqual([]);
  });

  it("filters packages and shows a license text", async () => {
    const load = vi.fn().mockResolvedValue([
      { name: "preact@10.0.0", licenses: "MIT", licenseText: "MIT text" },
      { name: "cargo:serde@1.0.0", licenses: "MIT OR Apache-2.0" },
    ]);
    void act(() => {
      render(h(LicensesDialog, { onClose: vi.fn(), load }), root);
    });
    // Effects run when the first act settles; let the load resolve after.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(root.querySelectorAll(".licenses-entry")).toHaveLength(2);
    const search = root.querySelector<HTMLInputElement>("input[type=search]")!;
    void act(() => {
      search.value = "serde";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(root.querySelectorAll(".licenses-entry")).toHaveLength(1);
    void act(() => {
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    void act(() => {
      root.querySelector<HTMLElement>(".licenses-entry summary")?.click();
    });
    expect(root.textContent).toContain("MIT text");
  });
});
