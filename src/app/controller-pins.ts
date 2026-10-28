import type { MusicSource, PinnedPlaylist, Playlist } from "../domain/music.ts";
import type { AppleMusicLibraryClient } from "../musickit/library.ts";
import { getState, setPins } from "../state.ts";
import {
  MAX_PINS,
  deletePins as deletePersistedPins,
  loadPins as loadPersistedPins,
  savePins as savePersistedPins,
  type InvokeFunction,
} from "./pins.ts";
import {
  safeErrorMessage,
  type ControllerContext,
} from "./controller-support.ts";

export interface ControllerPinsDependencies {
  invokeFn: InvokeFunction;
  /** The loaded library client, or null while the library is unavailable. */
  libraryClient(): AppleMusicLibraryClient | null;
}

/** Pinned playlists: local persistence, name/artwork resolution, and toggling. */
export function createControllerPins(
  context: ControllerContext,
  deps: ControllerPinsDependencies,
) {
  const { log } = context;
  const { invokeFn } = deps;

  const persistPins = async (
    pins: readonly PinnedPlaylist[],
  ): Promise<void> => {
    try {
      await savePersistedPins(pins, invokeFn);
    } catch (error) {
      log(`Pinned playlists save failed: ${safeErrorMessage(error)}`);
    }
  };

  const reload = async (): Promise<void> => {
    setPins(await loadPersistedPins(invokeFn));
    void resolveDetails();
  };

  let resolvingPins = false;
  // A request that arrives mid-run (a new pin) runs once more afterwards.
  let resolvePinsAgain = false;
  /**
   * Saves each pin's name and artwork, so the sidebar can show a pinned
   * playlist that is not in the loaded playlist list. Uses the loaded list
   * when it has the playlist (also picking up renames) and asks Apple for the
   * rest. Runs once at a time; needs a signed-in library.
   */
  const resolveDetails = async (): Promise<void> => {
    if (resolvingPins) {
      resolvePinsAgain = true;
      return;
    }
    const client = deps.libraryClient();
    if (!client || getState().auth.status !== "authorized") return;
    resolvingPins = true;
    try {
      const listed = getState().library.collections.playlists.items;
      const pins = getState().pins;
      const knownOf = (pin: PinnedPlaylist) =>
        listed.find((item) => item.id === pin.id) as
          { name?: unknown; artwork?: { url?: unknown } } | undefined;
      // Pins that neither the list nor the saved pin can name. One batched
      // request per source covers them; any pin it misses is looked up alone.
      const needsLookup = pins.filter(
        (pin) => !knownOf(pin)?.name && !pin.name,
      );
      const batched = new Map<string, Playlist>();
      const batchSources = [...new Set(needsLookup.map((pin) => pin.source))];
      await Promise.all(
        batchSources.map(async (source) => {
          const ids = needsLookup
            .filter((pin) => pin.source === source)
            .map((pin) => pin.id);
          try {
            for (const playlist of await client.getPlaylistsByIds(
              ids,
              source,
            )) {
              batched.set(playlist.id, playlist);
            }
          } catch (error) {
            log(`Pinned playlist batch failed: ${safeErrorMessage(error)}`);
          }
        }),
      );
      const updates = new Map<
        string,
        Pick<PinnedPlaylist, "name" | "artworkUrl">
      >();
      for (const pin of pins) {
        const known = knownOf(pin);
        let name = typeof known?.name === "string" ? known.name : undefined;
        let artworkUrl =
          typeof known?.artwork?.url === "string"
            ? known.artwork.url
            : undefined;
        if (!name && !pin.name) {
          const found = batched.get(pin.id);
          if (found) {
            name = found.name;
            artworkUrl = found.artwork?.url;
          } else {
            try {
              const playlist = await client.getPlaylist(pin.id, pin.source);
              name = playlist?.name;
              artworkUrl = playlist?.artwork?.url;
            } catch (error) {
              log(`Pinned playlist lookup failed: ${safeErrorMessage(error)}`);
            }
          }
        }
        if (
          (name && name !== pin.name) ||
          (artworkUrl && artworkUrl !== pin.artworkUrl)
        ) {
          updates.set(pin.id, {
            name: name ?? pin.name,
            artworkUrl: artworkUrl ?? pin.artworkUrl,
          });
        }
      }
      if (updates.size === 0) return;
      // Pins may have changed during the lookups; apply to the latest list.
      const next = getState().pins.map((pin) => {
        const update = updates.get(pin.id);
        return update ? { ...pin, ...update } : pin;
      });
      setPins(next);
      await persistPins(next);
    } finally {
      resolvingPins = false;
      if (resolvePinsAgain) {
        resolvePinsAgain = false;
        void resolveDetails();
      }
    }
  };

  const togglePin = async (
    id: string,
    source: MusicSource = "library",
  ): Promise<void> => {
    const trimmed = id.trim();
    if (!trimmed) return;
    const current = getState().pins;
    const next = current.some((pin) => pin.id === trimmed)
      ? current.filter((pin) => pin.id !== trimmed)
      : [...current, { id: trimmed, source }].slice(0, MAX_PINS);
    setPins(next);
    await persistPins(next);
    void resolveDetails();
  };

  const unpin = async (id: string): Promise<void> => {
    const current = getState().pins;
    if (!current.some((pin) => pin.id === id)) return;
    const next = current.filter((pin) => pin.id !== id);
    setPins(next);
    await persistPins(next);
  };

  /**
   * Local sign-out step: pins are local and not tied to an Apple ID, so the
   * next account to sign in on this PC must not see them. A failure is logged.
   */
  const clearStored = async (): Promise<void> => {
    setPins([]);
    await deletePersistedPins(invokeFn);
  };

  return { reload, resolveDetails, togglePin, unpin, clearStored };
}

export type ControllerPins = ReturnType<typeof createControllerPins>;
