import { invoke } from "@tauri-apps/api/core";
import type { InvokeFunction } from "./settings.ts";

/** Opens https://rosie.run/support in the default browser (fixed in Rust). */
export async function openSupportPage(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await invokeFn("open_support_page");
}

/** Links the About section may open. Rust builds each URL from these names. */
export type AboutLink = "project" | "release_notes" | "license";

/** Opens one About link in the default browser (URLs fixed in Rust). */
export async function openAboutLink(
  link: AboutLink,
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await invokeFn("open_about_link", { link });
}
