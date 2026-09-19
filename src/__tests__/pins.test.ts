import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { createAppController } from "../app/controller.ts";
import type { AppController } from "../app/controller.ts";
import { AppProvider } from "../app/context.tsx";
import type { HashRouter } from "../routing/router.ts";
import { ContextMenu } from "../components/ContextMenu.tsx";
import { Sidebar } from "../components/Sidebar.tsx";
import type { PinnedPlaylist } from "../domain/music.ts";
import {
  MAX_PINS,
  loadPins,
  parsePins,
  savePins,
  serializePins,
} from "../app/pins.ts";
import type { InvokeFunction } from "../app/pins.ts";
import { MemoryLibraryCache } from "../library/cache.ts";
import type { AppleMusicLibraryClient } from "../musickit/library.ts";
import {
  getState,
  resetApplicationState,
  setLibraryCollectionItems,
  setNavigation,
  setPins,
} from "../state.ts";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(async () => "clipboard text"),
  writeText: vi.fn(async () => undefined),
}));

beforeEach(() => resetApplicationState());
afterEach(() => resetApplicationState());

function pin(
  id: string,
  source: PinnedPlaylist["source"] = "library",
): PinnedPlaylist {
  return { id, source };
}

describe("pins schema", () => {
  it("returns empty for corrupt payloads", () => {
    expect(parsePins("not json {{{")).toEqual([]);
    expect(parsePins("")).toEqual([]);
    expect(parsePins(undefined)).toEqual([]);
    expect(parsePins({})).toEqual([]);
    expect(parsePins({ pins: "oops" })).toEqual([]);
  });

  it("accepts object and bare-array shapes", () => {
    expect(parsePins("[]")).toEqual([]);
    expect(
      parsePins(JSON.stringify({ schemaVersion: 1, pins: [pin("a")] })),
    ).toEqual([pin("a")]);
    expect(parsePins([pin("b", "catalog")])).toEqual([pin("b", "catalog")]);
  });

  it("skips invalid entries and defaults source to library", () => {
    expect(
      parsePins([
        { id: "", source: "library" },
        { id: "a", source: "nope" },
        { id: "b" },
        "str",
        42,
        null,
        pin("c", "catalog"),
      ]),
    ).toEqual([pin("b"), pin("c", "catalog")]);
  });

  it("keeps the first hundred pins in stored order", () => {
    const entries = Array.from({ length: MAX_PINS + 5 }, (_, index) =>
      pin(`pin-${index}`),
    );
    const parsed = parsePins(entries);
    expect(parsed).toHaveLength(MAX_PINS);
    expect(parsed[0]).toEqual(pin("pin-0"));
    expect(parsed[MAX_PINS - 1]).toEqual(pin(`pin-${MAX_PINS - 1}`));
  });

  it("serializes the versioned shape capped at one hundred", () => {
    const entries = Array.from({ length: MAX_PINS + 5 }, (_, index) =>
      pin(`pin-${index}`, index % 2 === 0 ? "library" : "catalog"),
    );
    const payload = JSON.parse(serializePins(entries)) as {
      schemaVersion: number;
      pins: PinnedPlaylist[];
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.pins).toHaveLength(MAX_PINS);
    expect(payload.pins[0]).toEqual(pin("pin-0"));
  });
});

describe("pins persistence bridge", () => {
  it("loads empty when the native command fails", async () => {
    const invokeFn = vi.fn(async () => {
      throw new Error("denied");
    }) as unknown as InvokeFunction;
    await expect(loadPins(invokeFn)).resolves.toEqual([]);
  });

  it("saves through the native command with the versioned shape", async () => {
    const invokeFn = vi.fn(async () => undefined) as unknown as InvokeFunction;
    await savePins([pin("a"), pin("b", "catalog")], invokeFn);
    expect(invokeFn).toHaveBeenCalledOnce();
    const [command, args] = vi.mocked(invokeFn).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(command).toBe("save_pins");
    expect(JSON.parse(args.json as string)).toEqual({
      schemaVersion: 1,
      pins: [pin("a"), pin("b", "catalog")],
    });
  });
});

function fakeUpdater() {
  return {
    configure: vi.fn(),
    startupCheck: vi.fn(async () => undefined),
    checkNow: vi.fn(async () => undefined),
    dismissPending: vi.fn(),
    installPending: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
}

function fakeMusic(): MusicKit.MusicKitInstance {
  return {
    isAuthorized: false,
    storefrontId: "us",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setQueue: vi.fn().mockResolvedValue(undefined),
    play: vi.fn().mockResolvedValue(undefined),
    authorize: vi.fn().mockResolvedValue("token"),
    unauthorize: vi.fn().mockResolvedValue(undefined),
  } as unknown as MusicKit.MusicKitInstance;
}

function pinsInvoke(responses: {
  loadPins?: unknown;
  failSave?: boolean;
  calls?: Array<{ command: string; args?: Record<string, unknown> }>;
}): InvokeFunction {
  const invokeFn = (async <T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    responses.calls?.push({ command, args });
    if (command === "load_settings") return "{}" as unknown as T;
    if (command === "load_pins")
      return (responses.loadPins ?? "[]") as unknown as T;
    if (command === "save_pins") {
      if (responses.failSave) throw new Error("disk full");
      return undefined as unknown as T;
    }
    if (command === "set_window_fx") return "solid" as unknown as T;
    return undefined as unknown as T;
  }) as unknown as InvokeFunction;
  return invokeFn;
}

function pinsController(
  responses: Parameters<typeof pinsInvoke>[0] = {},
  client = {} as AppleMusicLibraryClient,
) {
  const music = fakeMusic();
  const controller = createAppController({
    initializeMusicKit: async () => music,
    createLibraryClient: () => client,
    libraryCache: new MemoryLibraryCache(),
    updater: fakeUpdater() as never,
    invokeFn: pinsInvoke(responses),
  });
  return { controller, music };
}

describe("pins controller", () => {
  it("loads pins through loadPins and during loadSettings", async () => {
    const calls: Array<{ command: string }> = [];
    const { controller } = pinsController({
      calls,
      loadPins: JSON.stringify({ schemaVersion: 1, pins: [pin("a")] }),
    });
    await controller.loadPins();
    expect(getState().pins).toEqual([pin("a")]);

    await controller.loadSettings();
    expect(calls.map((call) => call.command)).toContain("load_pins");
    expect(getState().pins).toEqual([pin("a")]);
    controller.dispose();
  });

  it("toggles and unpins with persistence", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> =
      [];
    const { controller } = pinsController({ calls });
    await controller.initialize();

    await controller.togglePin("a");
    expect(getState().pins).toEqual([pin("a")]);
    expect(controller.isPinned("a")).toBe(true);

    await controller.togglePin("b", "catalog");
    expect(getState().pins).toEqual([pin("a"), pin("b", "catalog")]);

    await controller.togglePin("a");
    expect(getState().pins).toEqual([pin("b", "catalog")]);
    expect(controller.isPinned("a")).toBe(false);

    await controller.unpin("b");
    expect(getState().pins).toEqual([]);
    expect(calls.filter((call) => call.command === "save_pins")).toHaveLength(
      4,
    );
    controller.dispose();
  });

  it("treats pins by id across sources", async () => {
    const { controller } = pinsController();
    await controller.initialize();
    await controller.togglePin("x", "catalog");
    expect(controller.isPinned("x")).toBe(true);
    await controller.togglePin("x", "library");
    expect(getState().pins).toEqual([]);
    controller.dispose();
  });

  it("caps stored pins at one hundred entries", async () => {
    const { controller } = pinsController();
    await controller.initialize();
    setPins(
      Array.from({ length: MAX_PINS }, (_, index) => pin(`pin-${index}`)),
    );
    await controller.togglePin("overflow");
    expect(getState().pins).toHaveLength(MAX_PINS);
    expect(controller.isPinned("overflow")).toBe(false);
    controller.dispose();
  });

  it("keeps in-memory pins and logs when save fails", async () => {
    const { controller } = pinsController({ failSave: true });
    await controller.initialize();
    await controller.togglePin("a");
    expect(getState().pins).toEqual([pin("a")]);
    expect(
      getState().diagnostics.logs.some((line) =>
        line.includes("Pinned playlists save failed"),
      ),
    ).toBe(true);
    controller.dispose();
  });

  it("reloads pins after authorize", async () => {
    const responses = {
      loadPins: JSON.stringify({ schemaVersion: 1, pins: [pin("post-auth")] }),
    };
    const { controller } = pinsController(responses);
    await controller.initialize();
    expect(getState().pins).toEqual([]);
    await controller.authorize();
    expect(getState().auth.status).toBe("authorized");
    expect(getState().pins).toEqual([pin("post-auth")]);
    controller.dispose();
  });

  it("clears pins on sign-out", async () => {
    const { controller } = pinsController();
    await controller.initialize();
    setPins([pin("a"), pin("b", "catalog")]);
    await controller.signOut();
    expect(getState().pins).toEqual([]);
    expect(getState().auth.status).toBe("unauthorized");
    controller.dispose();
  });
});

function testRouter(): HashRouter {
  return {
    getRoute: () => ({ kind: "home" }),
    navigate: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    subscribe: () => () => undefined,
    start: () => () => undefined,
  };
}

function stubController(): AppController {
  return {
    isPinned: () => false,
    togglePin: vi.fn(async () => undefined),
    unpin: vi.fn(async () => undefined),
  } as unknown as AppController;
}

async function renderSidebar(
  router = testRouter(),
  controller: AppController = stubController(),
): Promise<{ root: HTMLDivElement; router: HashRouter }> {
  const root = document.createElement("div");
  document.body.append(root);
  await act(async () => {
    render(
      h(AppProvider, {
        controller,
        router,
        children: h(Sidebar, null),
      }),
      root,
    );
    await Promise.resolve();
  });
  return { root, router };
}

describe("sidebar pinned group", () => {
  it("hides the pinned group without pins", async () => {
    const { root } = await renderSidebar();
    expect(root.textContent).not.toContain("Pinned");
    render(null, root);
    root.remove();
  });

  it("renders named pins from library collections", async () => {
    setLibraryCollectionItems("playlists", [
      { id: "p1", title: "Mix" },
      { id: "p2", name: "Chill" },
    ]);
    setPins([pin("p1"), pin("p2")]);
    const { root } = await renderSidebar();
    expect(root.textContent).toContain("Pinned");
    expect(root.textContent).toContain("Mix");
    expect(root.textContent).toContain("Chill");
    const row = root.querySelector(
      '[data-context-kind="playlist"][data-context-id="p1"]',
    );
    expect(row).not.toBeNull();
    render(null, root);
    root.remove();
  });

  it("resolves catalog names from home items", async () => {
    const { setHomeState } = await import("../state.ts");
    setLibraryCollectionItems("playlists", [{ id: "other", title: "Other" }]);
    setHomeState({
      status: "success",
      recentPlaylists: [{ id: "c1", name: "Catalog cut" }],
      heavyRotation: [],
      recommendations: [],
      errors: {},
      stale: false,
    });
    setPins([pin("c1", "catalog")]);
    const { root } = await renderSidebar();
    expect(root.textContent).toContain("Catalog cut");
    render(null, root);
    root.remove();
  });

  it("shows a neutral label before collections settle", async () => {
    setPins([pin("missing")]);
    const { root } = await renderSidebar();
    expect(root.textContent).toContain("Playlist");
    expect(root.textContent).not.toContain("Unknown playlist");
    render(null, root);
    root.remove();
  });

  it("marks dead pins only after a successful load", async () => {
    setLibraryCollectionItems("playlists", [{ id: "live", title: "Live" }]);
    setPins([pin("ghost")]);
    const { root } = await renderSidebar();
    expect(root.textContent).toContain("Unknown playlist");
    const row = root.querySelector(
      '[data-context-kind="playlist"][data-context-id="ghost"]',
    );
    expect(row).not.toBeNull();
    render(null, root);
    root.remove();
  });

  it("highlights only the active pin source", async () => {
    setLibraryCollectionItems("playlists", [{ id: "x", title: "Same" }]);
    setPins([pin("x"), pin("x", "catalog")]);
    setNavigation({ kind: "playlist", id: "x" });
    const { root } = await renderSidebar();
    const active = root.querySelectorAll(".sidebar-link.is-active");
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain("Same");
    render(null, root);
    root.remove();
  });

  it("navigates to the pinned playlist route on click", async () => {
    setLibraryCollectionItems("playlists", [{ id: "p1", title: "Mix" }]);
    setPins([pin("p1", "catalog")]);
    const router = testRouter();
    const { root } = await renderSidebar(router);
    const row = root.querySelector(
      '[data-context-kind="playlist"][data-context-id="p1"]',
    ) as HTMLElement | null;
    expect(row).not.toBeNull();
    await act(async () => {
      row?.click();
    });
    expect(router.navigate).toHaveBeenCalledWith({
      kind: "playlist",
      id: "p1",
      source: "catalog",
    });
    render(null, root);
    root.remove();
  });
});

async function openPlaylistMenu(
  target: HTMLElement,
  controller: AppController,
): Promise<HTMLDivElement> {
  const root = document.createElement("div");
  document.body.append(root);
  await act(async () => {
    render(
      h(AppProvider, {
        controller,
        router: testRouter(),
        children: h(ContextMenu, null),
      }),
      root,
    );
  });
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }),
    );
  });
  return root;
}

function closeMenu(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

describe("playlist context menu pins", () => {
  it("offers Pin playlist when unpinned", async () => {
    const target = document.createElement("div");
    target.dataset.contextKind = "playlist";
    target.dataset.contextId = "p1";
    target.dataset.contextRouteKind = "playlist";
    document.body.append(target);
    const root = await openPlaylistMenu(target, stubController());
    expect(document.querySelector(".context-menu")?.textContent).toContain(
      "Pin playlist",
    );
    expect(document.querySelector(".context-menu")?.textContent).not.toContain(
      "Unpin playlist",
    );
    await act(async () => {
      closeMenu();
    });
    render(null, root);
    root.remove();
    target.remove();
  });

  it("offers Unpin playlist when pinned", async () => {
    const target = document.createElement("div");
    target.dataset.contextKind = "playlist";
    target.dataset.contextId = "p1";
    target.dataset.contextRouteKind = "playlist";
    document.body.append(target);
    const controller = {
      isPinned: () => true,
      togglePin: vi.fn(async () => undefined),
      unpin: vi.fn(async () => undefined),
    } as unknown as AppController;
    const root = await openPlaylistMenu(target, controller);
    expect(document.querySelector(".context-menu")?.textContent).toContain(
      "Unpin playlist",
    );
    await act(async () => {
      closeMenu();
    });
    render(null, root);
    root.remove();
    target.remove();
  });

  it("hides pin actions for non-playlist targets", async () => {
    const target = document.createElement("div");
    target.dataset.contextKind = "track";
    target.dataset.contextTrackId = "t1";
    document.body.append(target);
    const root = await openPlaylistMenu(target, stubController());
    expect(document.querySelector(".context-menu")?.textContent).not.toContain(
      "Pin playlist",
    );
    await act(async () => {
      closeMenu();
    });
    render(null, root);
    root.remove();
    target.remove();
  });
});
