import type { MusicSource, Track } from "../domain/music.ts";
import { getState, setUiState } from "../state.ts";
import { readPlaybackModes } from "../musickit/player.ts";
import type { LibraryLoader } from "./library-loader.ts";

export interface CollectionPlaybackDeps {
  requireMusic(): MusicKit.MusicKitInstance;
  getMusic(): MusicKit.MusicKitInstance | null | undefined;
  requireLibrary: LibraryLoader["requireLibrary"];
  playTracks(tracks: readonly Track[], startIndex?: number): Promise<void>;
  setShuffleMode(mode: "off" | "songs"): Promise<void>;
}

export interface CollectionPlayOptions {
  shuffle?: boolean;
}

/** Uniform random index in [0, length) from the platform CSPRNG. */
function randomIndex(length: number): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] % length;
}

/** Fisher-Yates over a copy, used when the provider cannot shuffle. */
function shuffled(tracks: readonly Track[]): Track[] {
  const result = [...tracks];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Loads every page of a playlist or album, then starts the clicked occurrence
 * inside the full queue. Any newer playback request supersedes a pending load.
 */
export function createCollectionPlayback(deps: CollectionPlaybackDeps) {
  let generation = 0;

  /** Cancels any in-flight collection load and clears its busy state. */
  const invalidate = (): void => {
    generation += 1;
    if (getState().ui.pendingCollection) {
      setUiState({ pendingCollection: undefined });
    }
  };

  const play = async (
    kind: "playlist" | "album",
    id: string,
    source: MusicSource,
    startIndex: number,
    options: CollectionPlayOptions = {},
  ): Promise<void> => {
    const mine = ++generation;
    setUiState({ pendingCollection: { kind, id } });
    try {
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

      let queue: readonly Track[] = tracks;
      let index = startIndex;
      if (options.shuffle) {
        if (readPlaybackModes(instance).capabilities.shuffle) {
          await deps.setShuffleMode("songs");
          index = tracks.length ? randomIndex(tracks.length) : 0;
        } else {
          queue = shuffled(tracks);
          index = 0;
        }
      }
      if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
        throw new Error(`The selected ${kind} song is unavailable.`);
      }
      await deps.playTracks(queue, index);
    } finally {
      if (mine === generation && getState().ui.pendingCollection) {
        setUiState({ pendingCollection: undefined });
      }
    }
  };

  return { invalidate, play };
}
