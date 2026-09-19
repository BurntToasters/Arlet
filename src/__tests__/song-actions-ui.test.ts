import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { AppController } from "../app/controller.ts";
import { AppProvider } from "../app/context.tsx";
import { PlaylistDialogs } from "../components/PlaylistDialogs.tsx";
import { QueueDrawer } from "../components/QueueDrawer.tsx";
import { CONTEXT_MENU_REQUEST } from "../components/context-menu-events.ts";
import { SongRow } from "../components/SongRow.tsx";
import { requestPlaylistDialog } from "../components/playlist-events.ts";
import {
  resetApplicationState,
  setAuthState,
  setInitializationState,
  setLibraryCollectionItems,
  setQueue,
  setUiState,
} from "../state.ts";
import type { Track } from "../domain/music.ts";
import type { HashRouter } from "../routing/router.ts";

const track: Track = {
  id: "song-1",
  title: "Night Drive",
  artistName: "Arlet",
  albumTitle: "After Dark",
};

function router(): HashRouter {
  return {
    getRoute: () => ({ kind: "home" }),
    navigate: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    subscribe: () => () => undefined,
    start: () => () => undefined,
  };
}

function controller(): AppController {
  return {
    loadLibrarySection: vi.fn(async () => undefined),
    searchPlaylists: vi.fn(async () => []),
    createPlaylist: vi.fn(async () => undefined),
    addTracksToPlaylist: vi.fn(async () => undefined),
    playNextTracks: vi.fn(async () => undefined),
  } as unknown as AppController;
}

afterEach(() => {
  resetApplicationState();
  document.body.innerHTML = "";
});

describe("song row actions", () => {
  it("keeps play, play-next, and menu as sibling keyboard controls", async () => {
    const root = document.createElement("div");
    const play = vi.fn();
    const playNext = vi.fn();
    const request = vi.fn();
    window.addEventListener(CONTEXT_MENU_REQUEST, request);
    document.body.append(root);
    render(
      h(SongRow, {
        track,
        index: 0,
        onPlay: play,
        onPlayNext: playNext,
        disabled: false,
        rowClassName: "search-row",
        numberClassName: "search-row-number",
        copyClassName: "search-row-copy",
        durationClassName: "search-row-duration",
        contextData: {
          "data-context-kind": "track",
          "data-context-id": track.id,
        },
      }),
      root,
    );
    const buttons = root.querySelectorAll("button");
    expect(buttons).toHaveLength(3);
    expect(root.querySelector("button.search-row button")).toBeNull();
    expect(root.querySelector(".song-row-artwork-overlay")).not.toBeNull();
    expect(
      root.querySelector(".song-row-artwork .row-play-button"),
    ).not.toBeNull();
    expect(
      root.querySelector("button.search-row > .row-play-button"),
    ).toBeNull();
    await act(() => {
      (root.querySelector(".song-row-next") as HTMLButtonElement).click();
      (root.querySelector(".song-row-more") as HTMLButtonElement).click();
    });
    expect(playNext).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0].detail.target.dataset.contextId).toBe(
      track.id,
    );
    window.removeEventListener(CONTEXT_MENU_REQUEST, request);
    render(null, root);
    root.remove();
  });
});

describe("playlist dialogs", () => {
  it("adds selected tracks through searchable playlist picker", async () => {
    setInitializationState({ status: "ready" });
    setAuthState({ status: "authorized" });
    setLibraryCollectionItems("playlists", [
      { id: "playlist-1", type: "library-playlists", name: "Night Mix" },
    ]);
    const appController = controller();
    const root = document.createElement("div");
    document.body.append(root);
    await act(() => {
      render(
        h(AppProvider, {
          controller: appController,
          router: router(),
          children: h(PlaylistDialogs, null),
        }),
        root,
      );
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await act(() => requestPlaylistDialog("picker", [track]));
    expect(root.textContent).toContain("Night Mix");
    expect(appController.loadLibrarySection).toHaveBeenCalledWith("playlists");
    await act(async () => {
      (
        root.querySelector(".playlist-dialog-option") as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    expect(appController.addTracksToPlaylist).toHaveBeenCalledWith(
      "playlist-1",
      [track],
    );
    render(null, root);
    root.remove();
  });

  it("validates and creates a playlist with seed tracks", async () => {
    const appController = controller();
    const root = document.createElement("div");
    document.body.append(root);
    await act(() => {
      render(
        h(AppProvider, {
          controller: appController,
          router: router(),
          children: h(PlaylistDialogs, null),
        }),
        root,
      );
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await act(() => requestPlaylistDialog("create", [track]));
    const form = root.querySelector(".playlist-dialog-form") as HTMLFormElement;
    const input = root.querySelector(
      ".playlist-dialog-form input",
    ) as HTMLInputElement;
    expect(root.textContent).not.toContain("Back to playlists");
    expect(root.textContent).toContain("Cancel");
    await act(() => {
      input.value = "Road songs";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (
        form.querySelector("button[type='submit']") as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    expect(appController.createPlaylist).toHaveBeenCalledWith({
      name: "Road songs",
      description: undefined,
      tracks: [track],
    });
    render(null, root);
    root.remove();
  });

  it("preserves seed tracks when switching picker to create and back", async () => {
    const appController = controller();
    const root = document.createElement("div");
    document.body.append(root);
    await act(() => {
      render(
        h(AppProvider, {
          controller: appController,
          router: router(),
          children: h(PlaylistDialogs, null),
        }),
        root,
      );
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await act(() => requestPlaylistDialog("picker", [track]));
    await act(() => {
      (
        root.querySelector("button.secondary-button") as HTMLButtonElement
      ).click();
    });
    expect(root.textContent).toContain("The selected song will be added.");
    expect(root.textContent).toContain("Back to playlists");
    await act(() => {
      (
        root.querySelector("button.secondary-button") as HTMLButtonElement
      ).click();
    });
    expect(root.textContent).toContain("Add to playlist");
    render(null, root);
    root.remove();
  });
});

describe("queue drawer", () => {
  it("selects queue rows through controller and keeps ellipsis as only row action", async () => {
    const secondTrack: Track = {
      ...track,
      id: "song-2",
      title: "Sunrise Exit",
    };
    setQueue([track, secondTrack], 0);
    setUiState({ queueOpen: true });
    const appController = {
      playQueueItem: vi.fn(async () => undefined),
      playTracks: vi.fn(async () => undefined),
      toggleQueue: vi.fn(),
    } as unknown as AppController;
    const root = document.createElement("div");
    document.body.append(root);
    render(
      h(AppProvider, {
        controller: appController,
        router: router(),
        children: h(QueueDrawer, null),
      }),
      root,
    );
    await act(() => {
      (
        root.querySelectorAll("button.queue-row")[1] as HTMLButtonElement
      ).click();
    });
    expect(appController.playQueueItem).toHaveBeenCalledWith(1);
    expect(root.querySelectorAll(".queue-row-more")).toHaveLength(2);
    expect(root.querySelector(".song-row-next")).toBeNull();
    render(null, root);
    root.remove();
  });
});
