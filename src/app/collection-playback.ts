import type { MusicSource, Track } from "../domain/music.ts";
import type { LibraryLoader } from "./library-loader.ts";

export interface CollectionPlaybackDeps {
  requireMusic(): MusicKit.MusicKitInstance;
  getMusic(): MusicKit.MusicKitInstance | null | undefined;
  requireLibrary: LibraryLoader["requireLibrary"];
  playTracks(tracks: readonly Track[], startIndex?: number): Promise<void>;
}

/**
 * Loads every page of a playlist or album, then starts the clicked occurrence
 * inside the full queue. Any newer playback request supersedes a pending load.
 */
export function createCollectionPlayback(deps: CollectionPlaybackDeps) {
  let generation = 0;

  /** Cancels any in-flight collection load. */
  const invalidate = (): void => {
    generation += 1;
  };

  const play = async (
    kind: "playlist" | "album",
    id: string,
    source: MusicSource,
    startIndex: number,
  ): Promise<void> => {
    const mine = ++generation;
    const instance = deps.requireMusic();
    const client = deps.requireLibrary();
    const tracks: Track[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page =
        kind === "playlist"
          ? await client.getPlaylistTracks(id, cursor, source)
          : await client.getAlbumTracks(id, source, cursor);
      if (mine !== generation || instance !== deps.getMusic()) return;
      tracks.push(...page.items);
      cursor = page.next;
      if (cursor) {
        if (cursors.has(cursor)) {
          throw new Error(`Apple Music returned a repeated ${kind} page.`);
        }
        cursors.add(cursor);
      }
    } while (cursor);
    if (
      !Number.isInteger(startIndex) ||
      startIndex < 0 ||
      startIndex >= tracks.length
    ) {
      throw new Error(`The selected ${kind} song is unavailable.`);
    }
    await deps.playTracks(tracks, startIndex);
  };

  return { invalidate, play };
}
