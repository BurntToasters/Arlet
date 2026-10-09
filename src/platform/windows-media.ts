import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type WindowsMediaControl = "play" | "pause" | "next" | "previous";

export interface WindowsMediaPayload {
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
  playbackStatus: "playing" | "paused" | "stopped";
  playEnabled: boolean;
  pauseEnabled: boolean;
  nextEnabled: boolean;
  previousEnabled: boolean;
  shuffle: boolean;
  repeat: WindowsMediaRepeat;
}

export type WindowsMediaRepeat = "off" | "all" | "one";

export function updateWindowsMediaSession(
  payload: WindowsMediaPayload,
): Promise<void> {
  return invoke<void>("update_windows_media_session", { payload });
}

export interface WindowsMediaTimeline {
  positionSeconds: number;
  durationSeconds: number;
}

export function updateWindowsMediaTimeline(
  payload: WindowsMediaTimeline,
): Promise<void> {
  return invoke<void>("update_windows_media_timeline", { payload });
}

export const TIMELINE_SYNC_INTERVAL_MS = 5_000;
const TIMELINE_SEEK_DRIFT_SECONDS = 2;

/**
 * Windows extrapolates the timeline while playing, so ticks are forwarded
 * only every few seconds or when a seek, pause, or track change breaks the
 * extrapolation.
 */
export function createTimelineSync(
  send: (timeline: WindowsMediaTimeline) => void,
  now: () => number = Date.now,
): (timeline: WindowsMediaTimeline & { playing: boolean }) => void {
  let last:
    | { at: number; position: number; duration: number; playing: boolean }
    | undefined;
  return ({ positionSeconds, durationSeconds, playing }) => {
    const at = now();
    if (last) {
      const elapsed = last.playing ? (at - last.at) / 1000 : 0;
      const drift = Math.abs(positionSeconds - (last.position + elapsed));
      if (
        durationSeconds === last.duration &&
        playing === last.playing &&
        drift < TIMELINE_SEEK_DRIFT_SECONDS &&
        at - last.at < TIMELINE_SYNC_INTERVAL_MS
      ) {
        return;
      }
    }
    last = {
      at,
      position: positionSeconds,
      duration: durationSeconds,
      playing,
    };
    send({ positionSeconds, durationSeconds });
  };
}

export function clearWindowsMediaSession(): Promise<void> {
  return invoke<void>("clear_windows_media_session");
}

export async function listenWindowsMediaControls(
  handler: (control: WindowsMediaControl) => void,
): Promise<UnlistenFn> {
  return listen<WindowsMediaControl>("windows-media-control", (event) => {
    if (
      event.payload === "play" ||
      event.payload === "pause" ||
      event.payload === "next" ||
      event.payload === "previous"
    ) {
      handler(event.payload);
    }
  });
}

/**
 * Seconds for a system seek, or undefined when the request cannot be applied:
 * NaN, negative, or no known duration. Positions past the end are clamped.
 */
export function clampWindowsMediaSeek(
  seconds: number,
  durationSeconds: number,
): number | undefined {
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return undefined;
  }
  return Math.min(seconds, durationSeconds);
}

export function listenWindowsMediaSeek(
  handler: (seconds: number) => void,
): Promise<UnlistenFn> {
  return listen<number>("windows-media-seek", (event) => {
    if (typeof event.payload === "number") handler(event.payload);
  });
}

export function listenWindowsMediaShuffle(
  handler: (enabled: boolean) => void,
): Promise<UnlistenFn> {
  return listen<boolean>("windows-media-shuffle", (event) => {
    if (typeof event.payload === "boolean") handler(event.payload);
  });
}

export function listenWindowsMediaRepeat(
  handler: (mode: WindowsMediaRepeat) => void,
): Promise<UnlistenFn> {
  return listen<WindowsMediaRepeat>("windows-media-repeat", (event) => {
    if (
      event.payload === "off" ||
      event.payload === "all" ||
      event.payload === "one"
    ) {
      handler(event.payload);
    }
  });
}
