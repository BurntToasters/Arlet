import { invoke } from "@tauri-apps/api/core";
import { createSerialQueue } from "./serial.ts";
import type { InvokeFunction } from "./settings.ts";

const writeQueue = createSerialQueue();

export type { InvokeFunction };

export async function loadPinsPayload(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<unknown> {
  return invokeFn<unknown>("load_pins");
}

export async function savePinsPayload(
  json: string,
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await writeQueue(() => invokeFn("save_pins", { json }));
}

export async function deletePinsPayload(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await writeQueue(() => invokeFn("delete_pins"));
}
