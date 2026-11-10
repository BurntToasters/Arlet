import { invoke } from "@tauri-apps/api/core";
import {
  accountDataReadVersion,
  assertAccountDataAvailable,
  isAccountDataReadCurrent,
} from "./account-data.ts";
import { createSerialQueue } from "./serial.ts";
import type { InvokeFunction } from "./settings.ts";

const writeQueue = createSerialQueue();

export type { InvokeFunction };

export async function loadPlaybackSessionPayload(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<unknown> {
  const version = accountDataReadVersion("queue");
  if (version === undefined) return null;
  const value = await invokeFn<unknown>("load_playback_session");
  return isAccountDataReadCurrent("queue", version) ? value : null;
}

export async function savePlaybackSessionPayload(
  json: string,
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await writeQueue(async () => {
    assertAccountDataAvailable("queue");
    await invokeFn("save_playback_session", { json });
    assertAccountDataAvailable("queue");
  });
}

export async function deletePlaybackSessionPayload(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await writeQueue(() => invokeFn("delete_playback_session"));
}
