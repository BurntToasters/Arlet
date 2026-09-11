import { describe, expect, it, vi } from "vitest";
import {
  CONSECUTIVE_TRACK_TARGET,
  playQueue,
  playSong,
} from "../musickit/player.ts";

function mockInstance(): MusicKit.MusicKitInstance {
  return {
    setQueue: vi.fn().mockResolvedValue(undefined),
    play: vi.fn().mockResolvedValue(undefined),
  } as unknown as MusicKit.MusicKitInstance;
}

describe("player queue", () => {
  it("keeps the consecutive-track target at the Phase 0 matrix size", () => {
    expect(CONSECUTIVE_TRACK_TARGET).toBe(20);
  });

  it("queues a single song", async () => {
    const instance = mockInstance();
    await playSong(instance, "song-1");
    expect(instance.setQueue).toHaveBeenCalledWith({ songs: ["song-1"] });
    expect(instance.play).toHaveBeenCalledOnce();
  });

  it("queues consecutive songs from a start index", async () => {
    const instance = mockInstance();
    await playQueue(instance, ["a", "b", "c", "d"], 2);
    expect(instance.setQueue).toHaveBeenCalledWith({ songs: ["c", "d"] });
    expect(instance.play).toHaveBeenCalledOnce();
  });

  it("rejects an empty queue", async () => {
    const instance = mockInstance();
    await expect(playQueue(instance, [])).rejects.toThrow("Queue is empty");
    expect(instance.setQueue).not.toHaveBeenCalled();
  });
});
