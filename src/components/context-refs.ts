import { useRef } from "preact/hooks";
import type { MusicEntityRef } from "../domain/music.ts";

// Serialized refs per object. Track and navigation objects come from app state
// and are replaced, not mutated, so a cached string cannot go stale.
const serializedRefs = new WeakMap<object, string>();

/** JSON for a ref or ref list, serialized once per object identity. */
export function serializeContextRefs(
  value: MusicEntityRef | readonly MusicEntityRef[],
): string {
  const cached = serializedRefs.get(value);
  if (cached !== undefined) return cached;
  const json = JSON.stringify(value);
  serializedRefs.set(value, json);
  return json;
}

export interface SerializedContextRefs {
  album?: string;
  artists?: string;
}

function refKey(ref: MusicEntityRef | undefined): string {
  return ref ? `${ref.source}\u0000${ref.id}\u0000${ref.name ?? ""}` : "";
}

/**
 * Album and artist refs as data-* JSON for a row. Rows are often handed fresh
 * ref objects on every parent render, so the strings are reused while the ids,
 * sources, and names stay the same; the attribute value then does not change.
 */
export function useSerializedContextRefs(
  album: MusicEntityRef | undefined,
  artists: readonly MusicEntityRef[] | undefined,
): SerializedContextRefs {
  const key = `${refKey(album)}\u0001${(artists ?? []).map(refKey).join("\u0001")}`;
  const cache = useRef<
    { key: string; value: SerializedContextRefs } | undefined
  >(undefined);
  if (cache.current?.key !== key) {
    cache.current = {
      key,
      value: {
        album: album ? JSON.stringify(album) : undefined,
        artists: artists?.length ? JSON.stringify(artists) : undefined,
      },
    };
  }
  return cache.current.value;
}
