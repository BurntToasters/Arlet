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
export function randomIndex(length: number): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] % length;
}

/** Fisher-Yates over a copy, used when the provider cannot shuffle. */
export function shuffled(tracks: readonly Track[]): Track[] {
  const result = [...tracks];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Reads every page of a playlist or album in order. Returns undefined when
 * `isStale` reports the load was superseded.
 */
export async function loadAllTracks(
  kind: "playlist" | "album",
  id: string,
  source: MusicSource,
  client: ReturnType<LibraryLoader["requireLibrary"]>,
  isStale: () => boolean = () => false,
): Promise<Track[] | undefined> {
  const tracks: Track[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page =
      kind === "playlist"
        ? await client.getPlaylistTracks(id, cursor, source)
        : await client.getAlbumTracks(id, source, cursor);
    if (isStale()) return undefined;
    tracks.push(...page.items);
    cursor = page.next;
    if (cursor) {
      if (cursors.has(cursor)) {
        throw new Error(`Apple Music returned a repeated ${kind} page.`);
      }
      cursors.add(cursor);
    }
  } while (cursor);
  return tracks;
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

  /** Turns provider shuffle on when supported, else shuffles locally. */
  const prepareShuffle = async (
    instance: MusicKit.MusicKitInstance,
    tracks: readonly Track[],
  ): Promise<{ queue: readonly Track[]; index: number }> => {
    if (readPlaybackModes(instance).capabilities.shuffle) {
      await deps.setShuffleMode("songs");
      return {
        queue: tracks,
        index: tracks.length ? randomIndex(tracks.length) : 0,
      };
    }
    return { queue: shuffled(tracks), index: 0 };
  };

  /** Plays already-loaded tracks in shuffled order. */
  const playShuffled = async (tracks: readonly Track[]): Promise<void> => {
    if (tracks.length === 0) throw new Error("No songs are available.");
    invalidate();
    const { queue, index } = await prepareShuffle(deps.requireMusic(), tracks);
    await deps.playTracks(queue, index);
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
      const tracks = await loadAllTracks(
        kind,
        id,
        source,
        client,
        () => mine !== generation || instance !== deps.getMusic(),
      );
      if (!tracks) return;

      let queue: readonly Track[] = tracks;
      let index = startIndex;
      if (options.shuffle) {
        ({ queue, index } = await prepareShuffle(instance, tracks));
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

  return {
    invalidate,
    play,
    playShuffled,
    generation: (): number => generation,
  };
}
