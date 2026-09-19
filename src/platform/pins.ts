import { invoke } from "@tauri-apps/api/core";
import type { InvokeFunction } from "./settings.ts";

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
  await invokeFn("save_pins", { json });
}

export async function deletePinsPayload(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await invokeFn("delete_pins");
}
