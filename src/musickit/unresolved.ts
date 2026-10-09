import type { Track } from "../domain/music.ts";

const UNRESOLVED_MESSAGE = "One or more items could not be resolved";
const LIBRARY_ID = /^[ailp]\.[A-Za-z0-9]+$/u;
/** One retry per round of newly unresolved IDs; each round only shrinks the list. */
const MAX_ATTEMPTS = 4;

/**
 * IDs MusicKit's item loader could not resolve. It throws `NOT_FOUND` with
 * the unresolved descriptors on `data`, and lists the IDs in the message.
 */
export function unresolvedIds(error: unknown): Set<string> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : "";
  const reason = record.errorCode ?? record.reason;
  if (reason !== "NOT_FOUND" && !message.startsWith(UNRESOLVED_MESSAGE)) {
    return undefined;
  }
  const ids = new Set<string>();
  if (Array.isArray(record.data)) {
    for (const entry of record.data) {
      const id = (entry as { id?: unknown } | null)?.id;
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  if (ids.size === 0 && message.startsWith(UNRESOLVED_MESSAGE)) {
    const list = message.slice(message.indexOf(":") + 1);
    for (const id of list.split(",")) {
      if (id.trim()) ids.add(id.trim());
    }
  }
  return ids.size ? ids : undefined;
}

/** A track as sent to MusicKit, with its position in the requested list. */
export interface ResolvableEntry {
  track: Track;
  index: number;
}

export interface ResolvedTracks {
  entries: ResolvableEntry[];
  skipped: Track[];
}

function queuedId(track: Track): string {
  return track.catalogId ?? track.id;
}

/**
 * Runs a MusicKit queue call, dropping songs Apple marks unstreamable and
 * songs MusicKit cannot resolve, and retrying with the rest. A library song whose catalog copy is gone is retried once by
 * its library ID. Other errors, and a list with nothing left, are rethrown.
 */
export async function withResolvableTracks(
  tracks: readonly Track[],
  run: (entries: readonly ResolvableEntry[]) => Promise<void>,
): Promise<ResolvedTracks> {
  const skipped: Track[] = [];
  // Songs Apple already marks unstreamable never reach MusicKit.
  let entries: ResolvableEntry[] = [];
  tracks.forEach((track, index) => {
    if (track.playable === false) skipped.push(track);
    else entries.push({ track, index });
  });
  if (entries.length === 0) {
    throw new Error("None of these songs are available on Apple Music.");
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      await run(entries);
      return { entries, skipped };
    } catch (error) {
      const missing = unresolvedIds(error);
      if (!missing || attempt >= MAX_ATTEMPTS) throw error;
      const next: ResolvableEntry[] = [];
      let changed = false;
      for (const entry of entries) {
        const { track } = entry;
        if (!missing.has(queuedId(track))) {
          next.push(entry);
          continue;
        }
        changed = true;
        if (track.catalogId && LIBRARY_ID.test(track.id)) {
          const { catalogId: _removed, ...libraryTrack } = track;
          next.push({ ...entry, track: libraryTrack });
        } else {
          skipped.push(track);
        }
      }
      // IDs that match nothing we sent would only repeat the same failure.
      if (!changed) throw error;
      if (next.length === 0) {
        throw new Error("None of these songs are available on Apple Music.");
      }
      entries = next;
    }
  }
}

/** Position of the requested start after skips: it, or the next one kept. */
export function keptStartIndex(
  entries: readonly ResolvableEntry[],
  requested: number,
): number {
  const exact = entries.findIndex((entry) => entry.index === requested);
  if (exact >= 0) return exact;
  const after = entries.findIndex((entry) => entry.index > requested);
  return after >= 0 ? after : Math.max(0, entries.length - 1);
}

/** Toast text for skipped songs, or undefined when none were skipped. */
export function skippedMessage(count: number): string | undefined {
  if (count === 0) return undefined;
  return count === 1
    ? "Skipped 1 song that isn't available on Apple Music."
    : `Skipped ${count} songs that aren't available on Apple Music.`;
}
