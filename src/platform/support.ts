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

/**
 * Opens a MusicKit subscribeURL in the default browser. Rust accepts only an
 * https link on apple.com (no credentials or port, at most 2048 bytes) and
 * rejects anything else with an error.
 */
export async function openSubscribeLink(
  url: string,
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await invokeFn("open_subscribe_link", { url });
}

/**
 * Opens an Apple Music web link in the default browser. This reuses the
 * `open_subscribe_link` command, so Rust applies the same checks: https on
 * apple.com only (no credentials or port, at most 2048 bytes).
 */
export async function openAppleMusicLink(
  url: string,
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await invokeFn("open_subscribe_link", { url });
}
