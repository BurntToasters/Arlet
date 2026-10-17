import { asRecord } from "./response.ts";
import { useEffect, useState } from "preact/hooks";

export interface LiveMetadata {
  readonly title: string;
  readonly artist: string;
}

type LiveMetadataListener = (metadata: LiveMetadata | undefined) => void;

/** Longer text is cut so a misbehaving stream cannot fill the UI. */
const MAX_LIVE_TEXT_LENGTH = 200;

let current: LiveMetadata | undefined;
const listeners = new Set<LiveMetadataListener>();

/** The text a live stream reported for its current program, if any. */
export function getLiveMetadata(): LiveMetadata | undefined {
  return current;
}

export function subscribeLiveMetadata(
  listener: LiveMetadataListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setLiveMetadata(next: LiveMetadata | undefined): void {
  if (sameMetadata(current, next)) return;
  current = next;
  for (const listener of [...listeners]) listener(next);
}

function sameMetadata(
  left: LiveMetadata | undefined,
  right: LiveMetadata | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return left.title === right.title && left.artist === right.artist;
}

/**
 * Plain text only: control characters become spaces, runs of whitespace
 * collapse, and the result is capped. Callers must still render it as text.
 */
function readText(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(cleaned).slice(0, MAX_LIVE_TEXT_LENGTH).join("");
}

/**
 * Reads title and artist from a timed-metadata event. The payload shape is
 * not fixed across MusicKit releases, so the nested `timedMetadata` or
 * `metadata` object is preferred and the event itself is the fallback.
 */
export function liveMetadataFromEvent(
  event: Record<string, unknown>,
): LiveMetadata | undefined {
  for (const candidate of [event.timedMetadata, event.metadata, event]) {
    if (typeof candidate === "string") {
      const title = readText(candidate);
      if (title) return { title, artist: "" };
      continue;
    }
    const record = asRecord(candidate);
    if (!record) continue;
    const title = readText(record.title ?? record.name ?? record.songName);
    const artist = readText(record.artist ?? record.artistName);
    if (title || artist) return { title, artist };
  }
  return undefined;
}

/** Mirrors the catalog's live-station test for a now-playing item. */
export function isLiveMediaItem(item: MusicKit.MediaItem): boolean {
  const attributes: Record<string, unknown> = item.attributes ?? {};
  const type = (item as { type?: unknown }).type;
  return attributes.isLive === true || /station/iu.test(String(type ?? ""));
}

/** Preact hook: re-renders when the live text changes. Not rendered yet. */
export function useLiveMetadata(): LiveMetadata | undefined {
  const [metadata, setMetadata] = useState<LiveMetadata | undefined>(
    getLiveMetadata,
  );
  useEffect(() => {
    // The value may have changed between render and subscribe.
    setMetadata(getLiveMetadata());
    return subscribeLiveMetadata(setMetadata);
  }, []);
  return metadata;
}
