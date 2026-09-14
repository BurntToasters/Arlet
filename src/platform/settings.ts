import { invoke } from "@tauri-apps/api/core";
import type { WindowEffectPreference } from "../state.ts";

export type InvokeFunction = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export interface WindowEffectResult {
  requested: WindowEffectPreference;
  applied: WindowEffectPreference;
  fallbackReason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEffectResult(
  requested: WindowEffectPreference,
  raw: unknown,
): WindowEffectResult {
  if (raw === "acrylic" || raw === "mica" || raw === "solid") {
    return { requested, applied: raw };
  }
  if (isRecord(raw)) {
    const applied = raw.applied;
    const fallbackReason = raw.fallbackReason ?? raw.fallback_reason;
    if (applied === "acrylic" || applied === "mica" || applied === "solid") {
      return {
        requested,
        applied,
        ...(typeof fallbackReason === "string" ? { fallbackReason } : {}),
      };
    }
  }
  return { requested, applied: requested };
}

/**
 * Bridge native effect versions during the frontend/native migration. New
 * native builds accept `{ preference, dark }`; the Phase 0 command accepted
 * `{ enabled, dark }`, so the latter remains a safe fallback.
 */
export async function applyWindowEffect(
  preference: WindowEffectPreference,
  dark: boolean,
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<WindowEffectResult> {
  try {
    const raw = await invokeFn<unknown>("set_window_fx", { preference, dark });
    return normalizeEffectResult(preference, raw);
  } catch (firstError) {
    try {
      const raw = await invokeFn<unknown>("set_window_fx", {
        enabled: preference !== "solid",
        dark,
      });
      const result = normalizeEffectResult(preference, raw);
      return {
        ...result,
        ...(result.applied === preference
          ? {}
          : {
              fallbackReason:
                result.fallbackReason ??
                (firstError instanceof Error
                  ? firstError.message
                  : String(firstError)),
            }),
      };
    } catch (secondError) {
      return {
        requested: preference,
        applied: "solid",
        fallbackReason:
          secondError instanceof Error
            ? secondError.message
            : String(secondError),
      };
    }
  }
}

/** Raw native settings payload. Validation and migration stay in app code. */
export async function loadSettingsPayload(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<unknown> {
  return invokeFn<unknown>("load_settings");
}

export async function saveSettingsPayload(
  json: string,
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await invokeFn("save_settings", { json });
}

export async function resetSettingsPayload(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await invokeFn("reset_settings");
}

// Stable names for consumers that only need the native bridge. App-level
// migration/validation remains in `app/settings.ts`.
export const loadSettings = loadSettingsPayload;
export const saveSettings = saveSettingsPayload;
export const resetSettings = resetSettingsPayload;
