import { invoke } from "@tauri-apps/api/core";
import * as z from "zod/mini";
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

const MAX_PIN_NAME_LENGTH = 300;

const pinSchema = z.object({
  id: z.string().check(z.minLength(1)),
  source: z._default(z.enum(["library", "catalog"]), "library"),
  // Display-only hints; a bad value is dropped, never the pin itself.
  name: z.catch(
    z.optional(
      z
        .string()
        .check(z.trim(), z.minLength(1), z.maxLength(MAX_PIN_NAME_LENGTH)),
    ),
    undefined,
  ),
  artworkUrl: z.catch(
    z.optional(
      z.string().check(
        z.maxLength(2048),
        z.refine((url: string) => url.startsWith("https://")),
      ),
    ),
    undefined,
  ),
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
    const { id, source, name, artworkUrl } = candidate.data;
    pins.push({
      id,
      source,
      ...(name ? { name } : {}),
      ...(artworkUrl ? { artworkUrl } : {}),
    });
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
      ...(pin.name ? { name: pin.name.slice(0, MAX_PIN_NAME_LENGTH) } : {}),
      ...(pin.artworkUrl?.startsWith("https://")
        ? { artworkUrl: pin.artworkUrl }
        : {}),
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
