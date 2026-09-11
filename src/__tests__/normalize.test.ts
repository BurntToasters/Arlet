import { describe, it, expect } from "vitest";
import { normalizeTrack, normalizeArtworkUrl } from "../musickit/normalize.ts";

describe("normalizeArtworkUrl", () => {
  it("replaces width and height placeholders", () => {
    const url = "https://example.com/{w}x{h}bb.jpg";
    expect(normalizeArtworkUrl(url, 300)).toBe(
      "https://example.com/300x300bb.jpg",
    );
  });
});

describe("normalizeTrack", () => {
  it("maps a MusicKit MediaItem to a Track", () => {
    const item = {
      id: "12345",
      title: "Test Song",
      artistName: "Test Artist",
      albumName: "Test Album",
      artworkURL: "",
      playbackDuration: 240,
      artwork: {
        url: "https://example.com/{w}x{h}bb.jpg",
        width: 1000,
        height: 1000,
      },
    } as MusicKit.MediaItem;

    const track = normalizeTrack(item);
    expect(track.id).toBe("12345");
    expect(track.title).toBe("Test Song");
    expect(track.artistName).toBe("Test Artist");
    expect(track.albumTitle).toBe("Test Album");
    expect(track.durationMs).toBe(240000);
    expect(track.artwork).toBeDefined();
    expect(track.artwork?.url).toContain("300x300");
  });

  it("prefers catalog durationInMillis over playbackDuration", () => {
    const item = {
      id: "1",
      title: "Long Song",
      artistName: "Artist",
      albumName: "Album",
      artworkURL: "",
      playbackDuration: 30,
      attributes: { durationInMillis: 240000 },
    } as MusicKit.MediaItem;

    expect(normalizeTrack(item).durationMs).toBe(240000);
  });

  it("handles missing fields gracefully", () => {
    const item = {
      id: "99999",
      title: "",
      artistName: "",
      albumName: "",
      artworkURL: "",
      playbackDuration: 0,
    } as MusicKit.MediaItem;

    const track = normalizeTrack(item);
    expect(track.id).toBe("99999");
    expect(track.title).toBe("Unknown Title");
    expect(track.artistName).toBe("Unknown Artist");
    expect(track.artwork).toBeUndefined();
  });
});
