import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { AppSettings, ThemePreference } from "../state.ts";
import { DEFAULT_SETTINGS } from "../state.ts";
import {
  loadSettingsPayload,
  resetSettingsPayload,
  saveSettingsPayload,
  type InvokeFunction,
} from "../platform/settings.ts";

export {
  applyWindowEffect,
  type InvokeFunction,
  type WindowEffectResult,
} from "../platform/settings.ts";

const settingsShape = z.object({
  schemaVersion: z.literal(1).optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  windowEffect: z.enum(["acrylic", "mica", "solid"]).optional(),
  autoCheckUpdates: z.boolean().optional(),
  updateChannel: z.enum(["auto", "stable", "beta"]).optional(),
});
const themeSchema = z.enum(["system", "light", "dark"]);
const windowEffectSchema = z.enum(["acrylic", "mica", "solid"]);
const updateChannelSchema = z.enum(["auto", "stable", "beta"]);

export const appSettingsSchema = settingsShape.passthrough();

function systemMediaQuery(): Pick<MediaQueryList, "matches"> {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
  ) {
    try {
      return window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return { matches: false };
    }
  }
  return { matches: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Migrate persisted settings without allowing arbitrary persisted values to
 * become application state. Only reserved `_` keys are carried forward.
 */
export function migrateSettings(raw: unknown): AppSettings {
  let parsed: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      const value: unknown = JSON.parse(raw);
      if (isRecord(value)) parsed = value;
    } catch {
      parsed = {};
    }
  } else if (isRecord(raw)) {
    parsed = raw;
  }

  const candidate = {
    theme: themeSchema.safeParse(parsed.theme),
    windowEffect: windowEffectSchema.safeParse(parsed.windowEffect),
    autoCheckUpdates: z.boolean().safeParse(parsed.autoCheckUpdates),
    updateChannel: updateChannelSchema.safeParse(parsed.updateChannel),
  };
  const reserved = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => key.startsWith("_")),
  );
  return {
    ...reserved,
    schemaVersion: 1,
    theme: candidate.theme.success
      ? candidate.theme.data
      : DEFAULT_SETTINGS.theme,
    windowEffect: candidate.windowEffect.success
      ? candidate.windowEffect.data
      : DEFAULT_SETTINGS.windowEffect,
    autoCheckUpdates: candidate.autoCheckUpdates.success
      ? candidate.autoCheckUpdates.data
      : DEFAULT_SETTINGS.autoCheckUpdates,
    updateChannel: candidate.updateChannel.success
      ? candidate.updateChannel.data
      : DEFAULT_SETTINGS.updateChannel,
  };
}

export function serializeSettings(settings: AppSettings): string {
  const reserved = Object.fromEntries(
    Object.entries(settings).filter(([key]) => key.startsWith("_")),
  );
  return JSON.stringify({
    ...reserved,
    schemaVersion: 1,
    theme: settings.theme,
    windowEffect: settings.windowEffect,
    autoCheckUpdates: settings.autoCheckUpdates,
    updateChannel: settings.updateChannel,
  });
}

export function darkModeForTheme(
  theme: ThemePreference,
  mediaQuery: Pick<MediaQueryList, "matches"> = systemMediaQuery(),
): boolean {
  return theme === "dark" || (theme === "system" && mediaQuery.matches);
}

export function watchSystemTheme(
  listener: (dark: boolean) => void,
  matchMedia: (query: string) => MediaQueryList = (query) =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query)
      : ({ matches: false } as MediaQueryList),
): () => void {
  let query: MediaQueryList;
  try {
    query = matchMedia("(prefers-color-scheme: dark)");
  } catch {
    return () => undefined;
  }
  const onChange = (event: MediaQueryListEvent): void =>
    listener(event.matches);
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  if (typeof query.addListener === "function") {
    query.addListener(onChange);
    return () => query.removeListener?.(onChange);
  }
  return () => undefined;
}

export async function loadSettings(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<AppSettings> {
  try {
    const raw = await loadSettingsPayload(invokeFn);
    return migrateSettings(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(
  settings: AppSettings,
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await saveSettingsPayload(serializeSettings(settings), invokeFn);
}

export async function resetSettings(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await resetSettingsPayload(invokeFn);
}
