import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { createAppController } from "../app/controller.ts";
import {
  applyWindowEffect,
  darkModeForTheme,
  migrateSettings,
  serializeSettings,
} from "../app/settings.ts";
import { parseRoute, serializeRoute } from "../routing/router.ts";
import {
  getState,
  resetApplicationState,
  resetState,
  setAuthState,
  setNavigation,
  setUiState,
  subscribe,
} from "../state.ts";
import type { Track } from "../domain/music.ts";
import { registerMusicKitEvents } from "../musickit/events.ts";
import { DiagnosticsStore } from "../diagnostics/store.ts";
import { TrackRow } from "../views/SearchView.tsx";
import { RouteView } from "../views/RouteView.tsx";

afterEach(() => {
  resetApplicationState();
});

describe("shell routing", () => {
  it("round-trips supported routes and search query encoding", () => {
    const routes = [
      { kind: "home" as const },
      { kind: "new" as const },
      { kind: "radio" as const },
      { kind: "search" as const, query: "hello & goodbye" },
      { kind: "library" as const, section: "playlists" as const },
      { kind: "album" as const, id: "album/with spaces" },
      { kind: "settings" as const },
    ];
    for (const route of routes) {
      expect(parseRoute(serializeRoute(route))).toEqual(route);
    }
  });

  it("falls back unknown hashes to Home", () => {
    expect(parseRoute("#/unsupported/path")).toEqual({ kind: "home" });
  });
});

describe("shell state", () => {
  it("notifies subscribers and never retains auth token-shaped fields", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    // This remains accepted for compatibility with the Phase 0 fixture shape.
    const auth = { status: "authorized" as const, musicUserToken: "eyJsecret" };
    setAuthState(auth);
    unsubscribe();

    expect(listener).toHaveBeenCalled();
    expect("musicUserToken" in getState().auth).toBe(false);
  });

  it("keeps the current route and shell UI when account data resets", () => {
    setNavigation({ kind: "search", query: "hello" });
    setUiState({ queueOpen: true, sidebarOpen: true });
    setAuthState({ status: "authorized" });

    resetState();

    expect(getState().navigation).toEqual({
      kind: "search",
      query: "hello",
    });
    expect(getState().ui.queueOpen).toBe(true);
    expect(getState().ui.sidebarOpen).toBe(true);
    expect(getState().auth.status).toBe("unauthorized");
  });
});

describe("settings", () => {
  it("migrates defaults and preserves only reserved keys", () => {
    expect(
      migrateSettings(
        JSON.stringify({
          theme: "dark",
          windowEffect: "mica",
          _futurePreference: { enabled: true },
          password: "must not persist",
        }),
      ),
    ).toEqual({
      schemaVersion: 1,
      theme: "dark",
      windowEffect: "mica",
      _futurePreference: { enabled: true },
    });
    expect(
      serializeSettings(migrateSettings({ theme: "dark", other: 1 })),
    ).toBe('{"schemaVersion":1,"theme":"dark","windowEffect":"acrylic"}');
    expect(migrateSettings({ theme: "dark", windowEffect: "blur" })).toEqual({
      schemaVersion: 1,
      theme: "dark",
      windowEffect: "acrylic",
    });
  });

  it("resolves system appearance and tolerates native command fallback", async () => {
    expect(darkModeForTheme("system", { matches: true })).toBe(true);
    expect(darkModeForTheme("light", { matches: true })).toBe(false);
    const invokeFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("legacy command"))
      .mockResolvedValueOnce(undefined);
    await expect(
      applyWindowEffect("solid", false, invokeFn),
    ).resolves.toMatchObject({
      requested: "solid",
      applied: "solid",
    });
    expect(invokeFn).toHaveBeenNthCalledWith(1, "set_window_fx", {
      preference: "solid",
      dark: false,
    });
    expect(invokeFn).toHaveBeenNthCalledWith(2, "set_window_fx", {
      enabled: false,
      dark: false,
    });
  });

  it("leaves the document transparent for native material effects", () => {
    const styles = readFileSync(
      resolve(process.cwd(), "src/styles/base.css"),
      "utf8",
    );
    expect(styles).toContain(':root[data-window-effect="acrylic"] body');
    expect(styles).toContain(':root[data-window-effect="mica"] #app');
    expect(styles).toContain(':root[data-window-effect="solid"] .app-shell');
    const acrylicRule =
      styles.match(
        /:root\[data-window-effect="acrylic"\] \.app-shell::before\s*\{([\s\S]*?)\n\}/u,
      )?.[1] ?? "";
    expect(acrylicRule).toContain("feTurbulence");
    expect(acrylicRule).toContain("background-blend-mode: soft-light");
    const micaRule =
      styles.match(
        /:root\[data-window-effect="mica"\] \.app-shell::before\s*\{([\s\S]*?)\n\}/u,
      )?.[1] ?? "";
    expect(micaRule).not.toContain("feTurbulence");
    const playerRule = styles.match(/\.player-bar\s*\{([^}]*)\}/u)?.[1] ?? "";
    expect(playerRule).toContain("position: relative;");

    const homeView = readFileSync(
      resolve(process.cwd(), "src/views/HomeView.tsx"),
      "utf8",
    );
    expect(homeView).not.toContain("welcome-sparkle");
    expect(homeView).not.toContain("Sparkles");
  });
});

describe("shell controls", () => {
  it("skips initial heading focus but focuses after a route change", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    render(h(RouteView, { route: { kind: "new" } }), root);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const initialHeading = root.querySelector("h1");
    expect(document.activeElement).not.toBe(initialHeading);

    render(h(RouteView, { route: { kind: "radio" } }), root);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(document.activeElement).toBe(root.querySelector("h1"));
    render(null, root);
    root.remove();
  });

  it("plays a search row once without nested interactive controls", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const onPlay = vi.fn();
    const track: Track = { id: "track-1", title: "Song", artistName: "Artist" };

    render(h(TrackRow, { track, index: 0, onPlay, disabled: false }), root);

    const row = root.querySelector<HTMLButtonElement>("button.search-row");
    expect(row).not.toBeNull();
    expect(row?.querySelectorAll("button")).toHaveLength(0);
    row
      ?.querySelector("svg")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPlay).toHaveBeenCalledOnce();

    render(null, root);
    root.remove();
  });
});

describe("MusicKit event lifecycle", () => {
  it("returns an idempotent cleanup for every registered listener", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const instance = {
      addEventListener,
      removeEventListener,
    } as unknown as MusicKit.MusicKitInstance;

    const stop = registerMusicKitEvents(instance);
    expect(addEventListener).toHaveBeenCalledTimes(4);

    stop();
    stop();

    expect(removeEventListener).toHaveBeenCalledTimes(4);
    expect(removeEventListener.mock.calls).toEqual(addEventListener.mock.calls);
  });
});

describe("MusicKit controller", () => {
  it("discards stale search responses and queues the exact suffix", async () => {
    const instance = {
      isAuthorized: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setQueue: vi.fn().mockResolvedValue(undefined),
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as MusicKit.MusicKitInstance;
    let resolveFirst: (tracks: Track[]) => void = () => undefined;
    let resolveSecond: (tracks: Track[]) => void = () => undefined;
    const first = new Promise<Track[]>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<Track[]>((resolve) => {
      resolveSecond = resolve;
    });
    const search = vi.fn((_music: MusicKit.MusicKitInstance, term: string) =>
      term === "first" ? first : second,
    );
    const controller = createAppController({
      initializeMusicKit: async () => instance,
      searchCatalogSongs: search,
    });
    await controller.initialize();

    const firstRequest = controller.search("first");
    const secondRequest = controller.search("second");
    const tracks = [
      { id: "a", title: "A", artistName: "Artist" },
      { id: "b", title: "B", artistName: "Artist" },
      { id: "c", title: "C", artistName: "Artist" },
    ];
    resolveSecond(tracks);
    await secondRequest;
    resolveFirst(tracks.slice(0, 1));
    await firstRequest;

    expect(getState().search.results).toEqual(tracks);
    await controller.playFromSearch(1);
    expect(instance.setQueue).toHaveBeenLastCalledWith({ songs: ["b", "c"] });
    expect(getState().playback.queue.map((track) => track.id)).toEqual([
      "b",
      "c",
    ]);
    expect(getState().playback.queueIndex).toBe(0);
    controller.dispose();
  });

  it("sanitizes provider errors before exposing them to the UI", async () => {
    const instance = {
      isAuthorized: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setQueue: vi
        .fn()
        .mockRejectedValue(
          new Error("Playback failed Authorization: Bearer eyJplaysecret"),
        ),
      play: vi.fn(),
    } as unknown as MusicKit.MusicKitInstance;
    const search = vi.fn((_music: MusicKit.MusicKitInstance, _term: string) =>
      Promise.reject(
        new Error("Provider failed Authorization: Bearer eyJsearchsecret"),
      ),
    );
    const controller = createAppController({
      initializeMusicKit: async () => instance,
      searchCatalogSongs: search,
    });
    await controller.initialize();

    await controller.search("secret");
    expect(getState().search.error).toContain("[REDACTED]");
    expect(getState().search.error).not.toContain("eyJsearchsecret");

    await expect(
      controller.playTracks([
        { id: "track-1", title: "Song", artistName: "Artist" },
      ]),
    ).rejects.toThrow("eyJplaysecret");
    expect(getState().playback.error?.message).toContain("[REDACTED]");
    expect(getState().playback.error?.message).not.toContain("eyJplaysecret");
    controller.dispose();
  });

  it("classifies preview playback and logs media errors through diagnostics", async () => {
    const listeners = new Map<
      string,
      (event: Record<string, unknown>) => void
    >();
    const addEventListener = vi.fn(
      (name: string, callback: (event: Record<string, unknown>) => void) => {
        listeners.set(name, callback);
      },
    );
    const removeEventListener = vi.fn();
    const instance = {
      isAuthorized: false,
      addEventListener,
      removeEventListener,
      setQueue: vi.fn().mockResolvedValue(undefined),
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as MusicKit.MusicKitInstance;
    const diagnosticsStore = new DiagnosticsStore();
    const controller = createAppController({
      initializeMusicKit: async () => instance,
      diagnosticsStore,
    });
    await controller.initialize();

    const catalogTrack: Track = {
      id: "preview-track",
      title: "Preview",
      artistName: "Artist",
      durationMs: 240_000,
    };
    await controller.playTracks([catalogTrack]);
    listeners.get(MusicKit.Events.nowPlayingItemDidChange)?.({
      item: {
        id: catalogTrack.id,
        title: catalogTrack.title,
        artistName: catalogTrack.artistName,
        playbackDuration: 30,
      },
    });
    listeners.get(MusicKit.Events.playbackTimeDidChange)?.({
      currentPlaybackTime: 4,
      currentPlaybackDuration: 30,
    });
    expect(diagnosticsStore.getSnapshot().playbackKind).toBe("preview");

    listeners.get(MusicKit.Events.mediaPlaybackError)?.({
      message: "Media error Authorization: Bearer eyJmedia-secret",
    });
    const latestEntry = diagnosticsStore.getSnapshot().entries.at(-1);
    expect(latestEntry?.message).toContain("[REDACTED]");
    expect(latestEntry?.message).not.toContain("eyJmedia-secret");
    expect(getState().playback.error?.message).toContain("[REDACTED]");
    controller.dispose();
    expect(removeEventListener).toHaveBeenCalledTimes(4);
  });

  it("guards authorization popups and clears pending state on success or failure", async () => {
    const authorizeMusic = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("cancelled"))
      .mockResolvedValueOnce("private-token");
    const instance = {
      isAuthorized: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      authorize: authorizeMusic,
      unauthorize: vi.fn().mockResolvedValue(undefined),
    } as unknown as MusicKit.MusicKitInstance;
    const controller = createAppController({
      initializeMusicKit: async () => instance,
    });
    await controller.initialize();

    const firstAttempt = controller.authorize();
    expect(getState().auth.pending).toBe(true);
    const duplicateAttempt = controller.authorize();
    expect(authorizeMusic).toHaveBeenCalledOnce();
    await expect(firstAttempt).rejects.toThrow("cancelled");
    await duplicateAttempt;
    expect(getState().auth.pending).toBe(false);
    expect(getState().auth.status).toBe("unauthorized");

    const successfulAttempt = controller.authorize();
    expect(getState().auth.pending).toBe(true);
    await successfulAttempt;
    expect(getState().auth.pending).toBe(false);
    expect(getState().auth.status).toBe("authorized");
    controller.dispose();
  });
});
