import { invoke } from "@tauri-apps/api/core";
import type { InvokeFunction } from "./settings.ts";

export type { InvokeFunction };

export async function loadPlaybackSessionPayload(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<unknown> {
  return invokeFn<unknown>("load_playback_session");
}

export async function savePlaybackSessionPayload(
  json: string,
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await invokeFn("save_playback_session", { json });
}

export async function deletePlaybackSessionPayload(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await invokeFn("delete_playback_session");
}
