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
}

export function updateWindowsMediaSession(
  payload: WindowsMediaPayload,
): Promise<void> {
  return invoke<void>("update_windows_media_session", { payload });
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
