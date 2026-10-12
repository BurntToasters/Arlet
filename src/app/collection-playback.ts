import type { MusicSource, Track } from "../domain/music.ts";
import { getState, setUiState } from "../state.ts";
import { readPlaybackModes } from "../musickit/player.ts";
import type { LibraryLoader } from "./library-loader.ts";
import { FIRST_BATCH_LENGTH, nearestTrackIndex } from "./queue-window.ts";

export interface CollectionPlaybackDeps {
  requireMusic(): MusicKit.MusicKitInstance;
  getMusic(): MusicKit.MusicKitInstance | null | undefined;
  requireLibrary: LibraryLoader["requireLibrary"];
  /** Resolves to the new queue's continuation token, or undefined. */
  playTracks(
    tracks: readonly Track[],
    startIndex?: number,
    timing?: PlayTiming,
  ): Promise<number | undefined>;
  setShuffleMode(mode: "off" | "songs"): Promise<void>;
  /** Identifies the queue a Play just set, for `appendContinuation`. */
  continuationToken(): number;
  /** Adds later-loaded songs to that queue's continuation, if still current. */
  appendContinuation(token: number, tracks: readonly Track[]): void;
  log(message: string): void;
}

/** What happened before playTracks, so its timing log covers the whole Play. */
export interface PlayTiming {
  /** `performance.now()` when the user asked to play. */
  startedAt: number;
  /** Already-formatted steps that ran before playTracks, such as page loads. */
  steps: string[];
}

export interface CollectionPlayOptions {
  shuffle?: boolean;
  /**
   * The song the user picked at `startIndex`. The collection is reloaded to
   * play it, and may have changed since its page was shown.
   */
  trackId?: string;
  /**
   * Every song of the collection as the page shows it. When given, Play
   * starts from it instead of fetching the pages again.
   */
  shown?: readonly Track[];
}

/** Uniform random index in [0, length) from the platform CSPRNG. */
export function randomIndex(length: number): number {
  // Values past the last whole multiple of `length` are redrawn, so the
  // modulo below has no bias toward low indexes.
  const limit = 2 ** 32 - (2 ** 32 % length);
  const values = new Uint32Array(1);
  let value = 0;
  do {
    crypto.getRandomValues(values);
    value = values[0] ?? 0;
  } while (value >= limit);
  return value % length;
}

/** Fisher-Yates over a copy, used when the provider cannot shuffle. */
export function shuffled(tracks: readonly Track[]): Track[] {
  const result = [...tracks];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    // Both indexes are in range, so the reads cannot be undefined.
    [result[i], result[j]] = [result[j] as Track, result[i] as Track];
  }
  return result;
}

/** Reads a playlist or album one page at a time, refusing a repeated cursor. */
function createTrackPager(
  kind: "playlist" | "album",
  id: string,
  source: MusicSource,
  client: ReturnType<LibraryLoader["requireLibrary"]>,
) {
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let done = false;
  return {
    get done(): boolean {
      return done;
    },
    async next(): Promise<Track[]> {
      const page =
        kind === "playlist"
          ? await client.getPlaylistTracks(id, cursor, source)
          : await client.getAlbumTracks(id, source, cursor);
      cursor = page.next;
      if (!cursor) done = true;
      else if (cursors.has(cursor)) {
        throw new Error(`Apple Music returned a repeated ${kind} page.`);
      } else cursors.add(cursor);
      return page.items;
    },
  };
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
  onPage: () => void = () => undefined,
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
    onPage();
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
 * inside the full queue. Any newer playback request or pause supersedes a
 * pending load.
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
    const mine = generation;
    const { queue, index } = await prepareShuffle(deps.requireMusic(), tracks);
    // A pause or newer request during shuffle setup supersedes this play.
    if (mine !== generation) return;
    await deps.playTracks(queue, index);
  };

  /**
   * Loads the remaining pages after Play started and adds them to the queue's
   * continuation. Stops when that queue is replaced (its token changes); a
   * pause does not stop it, so resuming keeps the whole collection.
   */
  const loadRest = async (
    pager: ReturnType<typeof createTrackPager>,
    token: number,
    instance: MusicKit.MusicKitInstance,
  ): Promise<void> => {
    try {
      while (!pager.done) {
        const items = await pager.next();
        if (
          deps.continuationToken() !== token ||
          instance !== deps.getMusic()
        ) {
          return;
        }
        deps.appendContinuation(token, items);
      }
    } catch (error) {
      deps.log(
        `Loading the rest of the queue failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    const startedAt = performance.now();
    setUiState({ pendingCollection: { kind, id } });
    try {
      const instance = deps.requireMusic();
      const client = deps.requireLibrary();
      const stale = (): boolean =>
        mine !== generation || instance !== deps.getMusic();
      // The page already holds every song: no fetch before audio. Otherwise
      // shuffle needs the whole collection, and in order Play starts once
      // the chosen song's page is in; the rest loads while it plays.
      const shown = options.shown?.length ? options.shown : undefined;
      const pager = shown
        ? undefined
        : createTrackPager(kind, id, source, client);
      const tracks: Track[] = shown ? [...shown] : [];
      let pages = 0;
      const loadUntil = async (enough: () => boolean): Promise<boolean> => {
        while (pager && !pager.done && !enough()) {
          const items = await pager.next();
          if (stale()) return false;
          pages += 1;
          tracks.push(...items);
        }
        return true;
      };
      // Enough for the chosen song and MusicKit's first batch after it; the
      // songs before it are already in, since pages arrive in order.
      // With shuffle on, MusicKit or Arlet shuffles the whole collection,
      // so every page is needed first.
      const shuffleOn =
        options.shuffle === true ||
        readPlaybackModes(instance).shuffleMode === "songs";
      const loadedChosen = (): boolean => {
        if (shuffleOn) return false;
        const chosen = options.trackId
          ? nearestTrackIndex(tracks, startIndex, options.trackId)
          : startIndex < tracks.length
            ? startIndex
            : -1;
        if (chosen < 0) return false;
        return tracks.length >= chosen + FIRST_BATCH_LENGTH;
      };
      if (!(await loadUntil(loadedChosen))) return;
      const timing: PlayTiming = {
        startedAt,
        steps: [
          pager
            ? `${kind} pages ${pages} (${tracks.length} songs) ${Math.round(performance.now() - startedAt)}ms`
            : `shown list (${tracks.length} songs)`,
        ],
      };

      let queue: readonly Track[] = tracks;
      let index = startIndex;
      if (options.shuffle) {
        ({ queue, index } = await prepareShuffle(instance, tracks));
        // A pause or newer request during shuffle setup supersedes this play.
        if (mine !== generation) return;
      }
      if (!options.shuffle && options.trackId) {
        index = nearestTrackIndex(queue, index, options.trackId);
        if (index < 0) {
          throw new Error(`That song is no longer in this ${kind}.`);
        }
      }
      if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
        throw new Error(`The selected ${kind} song is unavailable.`);
      }
      // The token comes from this Play: a newer Play that started meanwhile
      // must not receive this collection's later pages.
      const token = await deps.playTracks(queue, index, timing);
      if (token !== undefined && pager && !pager.done) {
        void loadRest(pager, token, instance);
      }
    } catch (error) {
      // A request the user already replaced must not surface its failure.
      if (mine !== generation) return;
      throw error;
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
