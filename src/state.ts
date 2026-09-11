import type { PlaybackState, Track } from "./domain/music.ts";
import type { AppErrorCode } from "./domain/errors.ts";

export interface AppState {
  auth: AuthState;
  playback: PlaybackState;
  tracksPlayed: number;
}

export type AuthState =
  | { status: "unauthorized" }
  | { status: "authorized"; musicUserToken: string };

const initialPlaybackState: PlaybackState = {
  status: "idle",
  current: undefined,
  positionSeconds: 0,
  durationSeconds: 0,
  volume: 0.5,
  queue: [],
  queueIndex: 0,
  error: undefined,
};

let state: AppState = {
  auth: { status: "unauthorized" },
  playback: { ...initialPlaybackState },
  tracksPlayed: 0,
};

export function getState(): Readonly<AppState> {
  return state;
}

export function setAuthState(auth: AuthState): void {
  state = { ...state, auth };
}

export function setPlaybackStatus(
  status: PlaybackState["status"],
): void {
  state = {
    ...state,
    playback: { ...state.playback, status },
  };
}

export function setCurrentTrack(track: Track | undefined): void {
  const isNewTrack =
    track !== undefined && track.id !== state.playback.current?.id;
  state = {
    ...state,
    playback: { ...state.playback, current: track },
    tracksPlayed: isNewTrack ? state.tracksPlayed + 1 : state.tracksPlayed,
  };
}

export function setPlaybackPosition(
  positionSeconds: number,
  durationSeconds: number,
): void {
  state = {
    ...state,
    playback: { ...state.playback, positionSeconds, durationSeconds },
  };
}

export function setVolume(volume: number): void {
  state = {
    ...state,
    playback: { ...state.playback, volume },
  };
}

export function setPlaybackError(
  code: AppErrorCode,
  message: string,
): void {
  state = {
    ...state,
    playback: {
      ...state.playback,
      status: "error",
      error: { code, message },
    },
  };
}

export function resetState(): void {
  state = {
    auth: { status: "unauthorized" },
    playback: { ...initialPlaybackState },
    tracksPlayed: 0,
  };
}
