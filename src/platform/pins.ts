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

export async function loadPinsPayload(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<unknown> {
  const version = accountDataReadVersion("pins");
  if (version === undefined) return null;
  const value = await invokeFn<unknown>("load_pins");
  return isAccountDataReadCurrent("pins", version) ? value : null;
}

export async function savePinsPayload(
  json: string,
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await writeQueue(async () => {
    assertAccountDataAvailable("pins");
    await invokeFn("save_pins", { json });
    assertAccountDataAvailable("pins");
  });
}

export async function deletePinsPayload(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await writeQueue(() => invokeFn("delete_pins"));
}
