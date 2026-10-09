import { describe, expect, it } from "vitest";
import {
  CONSECUTIVE_TRACK_TARGET,
  queueOptionsForTracks,
  readPlaybackModes,
  setRepeatMode,
  setShuffleMode,
} from "../musickit/player.ts";
import type { Track } from "../domain/music.ts";

describe("player queue", () => {
  it("keeps the consecutive-track target at the Phase 0 matrix size", () => {
    expect(CONSECUTIVE_TRACK_TARGET).toBe(20);
  });
});

describe("player modes", () => {
  it("normalizes and writes shuffle and repeat modes", () => {
    const player = { shuffle: false, repeatMode: 0 };
    const instance = { player } as unknown as MusicKit.MusicKitInstance;
    expect(readPlaybackModes(instance)).toMatchObject({
      shuffleMode: "off",
      repeatMode: "off",
      capabilities: { shuffle: true, repeat: true },
    });
    expect(setShuffleMode(instance, true)).toBe(true);
    expect(setRepeatMode(instance, "one")).toBe(true);
    expect(readPlaybackModes(instance)).toMatchObject({
      shuffleMode: "songs",
      repeatMode: "one",
    });
  });

  it("fails closed when provider hides mode setters", () => {
    const instance = { player: {} } as unknown as MusicKit.MusicKitInstance;
    expect(setShuffleMode(instance, true)).toBe(false);
    expect(setRepeatMode(instance, "all")).toBe(false);
  });

  it("hides repeat when the provider exposes a read-only property", () => {
    const player: Record<string, unknown> = {};
    Object.defineProperty(player, "repeatMode", {
      configurable: true,
      get: () => 0,
    });
    const instance = { player } as unknown as MusicKit.MusicKitInstance;
    expect(readPlaybackModes(instance).capabilities.repeat).toBe(false);
    expect(setRepeatMode(instance, "all")).toBe(false);
  });
});

describe("queueOptionsForTracks", () => {
  function libraryTrack(
    id: string,
    resourceType: Track["resourceType"],
    catalogId?: string,
  ): Track {
    return {
      id,
      title: "Song",
      artistName: "Artist",
      resourceType,
      ...(catalogId ? { catalogId } : {}),
    };
  }

  it("prefers catalog identifiers for library songs", () => {
    expect(
      queueOptionsForTracks([
        libraryTrack("i.one", "library-songs", "c.one"),
        libraryTrack("i.two", "library-songs", "c.two"),
      ]),
    ).toEqual({ songs: ["c.one", "c.two"] });
  });

  it("falls back to library identifiers without catalog matches", () => {
    expect(
      queueOptionsForTracks([libraryTrack("i.up", "library-songs")]),
    ).toEqual({
      songs: ["i.up"],
    });
  });

  it("keeps music videos on the video descriptor", () => {
    expect(
      queueOptionsForTracks([
        libraryTrack("i.vid", "library-music-videos", "c.vid"),
        libraryTrack("v.other", "music-videos"),
      ]),
    ).toEqual({ musicVideos: ["c.vid", "v.other"] });
  });

  it("never emits library-only descriptor keys", () => {
    const options = queueOptionsForTracks([
      libraryTrack("i.one", "library-songs", "c.one"),
    ]) as Record<string, unknown>;
    expect(options).not.toHaveProperty("librarySongs");
    expect(options).not.toHaveProperty("libraryMusicVideos");
  });
});
