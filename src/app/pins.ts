import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { PinnedPlaylist } from "../domain/music.ts";
import {
  deletePinsPayload,
  loadPinsPayload,
  savePinsPayload,
  type InvokeFunction,
} from "../platform/pins.ts";

export type { PinnedPlaylist };
export type { InvokeFunction };

export const MAX_PINS = 100;

const pinSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["library", "catalog"]).default("library"),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRaw(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function parsePins(raw: unknown): PinnedPlaylist[] {
  const parsed = parseRaw(raw);
  if (parsed === undefined) return [];
  const entries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.pins)
      ? parsed.pins
      : [];
  const pins: PinnedPlaylist[] = [];
  for (const entry of entries) {
    const candidate = pinSchema.safeParse(entry);
    if (!candidate.success) continue;
    pins.push({ id: candidate.data.id, source: candidate.data.source });
    if (pins.length >= MAX_PINS) break;
  }
  return pins;
}

export function serializePins(pins: readonly PinnedPlaylist[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    pins: pins.slice(0, MAX_PINS).map((pin) => ({
      id: pin.id,
      source: pin.source,
    })),
  });
}

export async function loadPins(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<PinnedPlaylist[]> {
  try {
    return parsePins(await loadPinsPayload(invokeFn));
  } catch {
    return [];
  }
}

export async function savePins(
  pins: readonly PinnedPlaylist[],
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await savePinsPayload(serializePins(pins), invokeFn);
}

export async function deletePins(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<void> {
  await deletePinsPayload(invokeFn);
}
