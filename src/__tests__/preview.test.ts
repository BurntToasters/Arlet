import { describe, expect, it } from "vitest";
import { classifyPlaybackKind } from "../musickit/preview.ts";

describe("classifyPlaybackKind", () => {
  it("flags a 30s stream of a longer catalog track as a preview", () => {
    expect(
      classifyPlaybackKind({
        catalogDurationSeconds: 240,
        playbackDurationSeconds: 30,
      }),
    ).toBe("preview");
  });

  it("treats matching long durations as full playback", () => {
    expect(
      classifyPlaybackKind({
        catalogDurationSeconds: 240,
        playbackDurationSeconds: 240,
      }),
    ).toBe("full");
  });

  it("does not flag a short catalog track as a preview", () => {
    expect(
      classifyPlaybackKind({
        catalogDurationSeconds: 28,
        playbackDurationSeconds: 28,
      }),
    ).toBe("full");
  });

  it("returns unknown before duration is known", () => {
    expect(
      classifyPlaybackKind({
        catalogDurationSeconds: 240,
        playbackDurationSeconds: 0,
      }),
    ).toBe("unknown");
  });

  it("treats a short stream with unknown catalog length as a preview", () => {
    expect(
      classifyPlaybackKind({
        playbackDurationSeconds: 30,
      }),
    ).toBe("preview");
  });
});
