import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { ContextMenu } from "../components/ContextMenu.tsx";
import { AppProvider } from "../app/context.tsx";
import type { AppController } from "../app/controller.ts";
import type { HashRouter } from "../routing/router.ts";
import { LibraryView } from "../views/LibraryView.tsx";
import {
  resetApplicationState,
  setAuthState,
  setInitializationState,
  setLibraryCollectionItems,
  setLibraryDetailState,
} from "../state.ts";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(async () => "clipboard text"),
  writeText: vi.fn(async () => undefined),
}));

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

function testController(): AppController {
  return {
    initialize: vi.fn(async () => undefined),
    loadSettings: vi.fn(async () => undefined),
    loadPins: vi.fn(async () => undefined),
    authorize: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    loadLibrarySection: vi.fn(async () => undefined),
    loadMoreLibrarySection: vi.fn(async () => undefined),
    refreshLibrarySection: vi.fn(async () => undefined),
    loadHome: vi.fn(async () => undefined),
    loadAlbum: vi.fn(async () => undefined),
    loadArtist: vi.fn(async () => undefined),
    loadPlaylist: vi.fn(async () => undefined),
    loadPlaylistFolder: vi.fn(async () => undefined),
    togglePin: vi.fn(async () => undefined),
    unpin: vi.fn(async () => undefined),
    isPinned: vi.fn(() => false),
    searchPlaylists: vi.fn(async () => []),
    createPlaylist: vi.fn(async () => undefined),
    createPlaylistFolder: vi.fn(async () => undefined),
    addTracksToPlaylist: vi.fn(async () => undefined),
    playNextTracks: vi.fn(async () => undefined),
    playLaterTracks: vi.fn(async () => undefined),
    playQueueItem: vi.fn(async () => undefined),
    refreshCurrentData: vi.fn(async () => undefined),
    search: vi.fn(async () => []),
    playFromSearch: vi.fn(async () => undefined),
    playTracks: vi.fn(async () => undefined),
    playConsecutive: vi.fn(async () => undefined),
    togglePlayback: vi.fn(async () => undefined),
    previous: vi.fn(async () => undefined),
    next: vi.fn(async () => undefined),
    seek: vi.fn(async () => undefined),
    setVolume: vi.fn(),
    setTheme: vi.fn(async () => undefined),
    setWindowEffect: vi.fn(async () => undefined),
    setAutoCheckUpdates: vi.fn(async () => undefined),
    setUpdateChannel: vi.fn(async () => undefined),
    startupUpdateCheck: vi.fn(async () => undefined),
    checkForUpdates: vi.fn(async () => undefined),
    dismissUpdate: vi.fn(),
    installUpdate: vi.fn(async () => undefined),
    toggleQueue: vi.fn(),
    toggleDiagnostics: vi.fn(),
    closeDiagnostics: vi.fn(),
    openMusicDiagnostic: vi.fn(async () => ""),
    setDiagnosticsEnvironment: vi.fn(),
    log: vi.fn(),
    dispose: vi.fn(),
    consecutiveTrackTarget: 3,
  };
}

afterEach(() => resetApplicationState());

describe("library UI shell", () => {
  it("recognizes the recently played route", async () => {
    const { parseRoute } = await import("../routing/router.ts");
    expect(parseRoute("#/library/history")).toEqual({
      kind: "library",
      section: "history",
    });
  });

  it("renders cached songs as playable context targets", async () => {
    setInitializationState({ status: "ready" });
    setAuthState({ status: "authorized" });
    setLibraryCollectionItems("songs", [
      {
        id: "song-1",
        type: "library-songs",
        attributes: { name: "Song", artistName: "Artist" },
      },
    ]);
    const root = document.createElement("div");
    document.body.append(root);
    render(
      h(AppProvider, {
        controller: testController(),
        router: testRouter(),
        children: h(LibraryView, { section: "songs" }),
      }),
      root,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(root.querySelector("[data-context-kind='track']")).not.toBeNull();
    render(null, root);
    root.remove();
  });

  it("replaces the browser context menu with Arlet's menu", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    await act(async () => {
      render(
        h(AppProvider, {
          controller: testController(),
          router: testRouter(),
          children: h(ContextMenu, null),
        }),
        root,
      );
    });
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 20,
    });
    await act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector(".context-menu")).not.toBeNull();
    await act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector(".context-menu")).toBeNull();
    render(null, root);
    root.remove();
  });

  it("renders root playlists and nested playlist folders", async () => {
    setInitializationState({ status: "ready" });
    setAuthState({ status: "authorized" });
    setLibraryCollectionItems("playlists", []);
    setLibraryDetailState("playlistFolder", {
      status: "success",
      source: "network",
      stale: false,
      items: [
        {
          id: "folder-1",
          name: "Favorites",
          resourceType: "library-playlist-folders",
          parentId: "root",
        },
        {
          id: "nested-playlist",
          name: "Deep cuts",
          resourceType: "library-playlists",
          parentId: "folder-1",
        },
        {
          id: "root-playlist",
          name: "Daily mix",
          resourceType: "library-playlists",
          parentId: "root",
        },
      ],
    });
    const root = document.createElement("div");
    document.body.append(root);
    render(
      h(AppProvider, {
        controller: testController(),
        router: testRouter(),
        children: h(LibraryView, { section: "playlists" }),
      }),
      root,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(root.textContent).toContain("Favorites");
    expect(root.textContent).toContain("Deep cuts");
    expect(root.textContent).toContain("Daily mix");
    render(null, root);
    root.remove();
  });
});
