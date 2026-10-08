import { invoke } from "@tauri-apps/api/core";
import type { InvokeFunction } from "./settings.ts";

/** Opens https://rosie.run/support in the default browser (fixed in Rust). */
export async function openSupportPage(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await invokeFn("open_support_page");
}
