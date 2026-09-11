import { describe, it, expect, beforeEach } from "vitest";
import {
  getState,
  setAuthState,
  setPlaybackStatus,
  setCurrentTrack,
  setPlaybackPosition,
  setVolume,
  setPlaybackError,
  setQueue,
  resetState,
} from "../state.ts";

beforeEach(() => {
  resetState();
});

describe("state", () => {
  it("starts unauthorized and idle", () => {
    const state = getState();
    expect(state.auth.status).toBe("unauthorized");
    expect(state.playback.status).toBe("idle");
    expect(state.tracksPlayed).toBe(0);
  });

  it("tracks authorization", () => {
    setAuthState({ status: "authorized", musicUserToken: "token123" });
    const state = getState();
    expect(state.auth.status).toBe("authorized");
  });

  it("tracks playback status", () => {
    setPlaybackStatus("playing");
    expect(getState().playback.status).toBe("playing");
  });

  it("increments track counter on new track", () => {
    setCurrentTrack({ id: "1", title: "Song A", artistName: "Artist" });
    expect(getState().tracksPlayed).toBe(1);
    setCurrentTrack({ id: "2", title: "Song B", artistName: "Artist" });
    expect(getState().tracksPlayed).toBe(2);
  });

  it("does not increment for same track", () => {
    setCurrentTrack({ id: "1", title: "Song", artistName: "Artist" });
    setCurrentTrack({ id: "1", title: "Song", artistName: "Artist" });
    expect(getState().tracksPlayed).toBe(1);
  });

  it("tracks position and duration", () => {
    setPlaybackPosition(30, 240);
    const state = getState();
    expect(state.playback.positionSeconds).toBe(30);
    expect(state.playback.durationSeconds).toBe(240);
  });

  it("tracks volume", () => {
    setVolume(0.75);
    expect(getState().playback.volume).toBe(0.75);
  });

  it("stores a consecutive playback queue", () => {
    setQueue(
      [
        { id: "1", title: "A", artistName: "X" },
        { id: "2", title: "B", artistName: "Y" },
      ],
      1,
    );
    const state = getState();
    expect(state.playback.queue).toHaveLength(2);
    expect(state.playback.queueIndex).toBe(1);
  });

  it("records errors", () => {
    setPlaybackError("PLAYBACK_FAILED", "DRM error");
    const state = getState();
    expect(state.playback.status).toBe("error");
    expect(state.playback.error?.code).toBe("PLAYBACK_FAILED");
  });

  it("resets to initial state", () => {
    setAuthState({ status: "authorized", musicUserToken: "tok" });
    setCurrentTrack({ id: "1", title: "S", artistName: "A" });
    resetState();
    expect(getState().auth.status).toBe("unauthorized");
    expect(getState().tracksPlayed).toBe(0);
  });
});
