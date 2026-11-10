import { useEffect, useState } from "preact/hooks";
import type { AppController } from "../app/controller.ts";
import type { Track } from "../domain/music.ts";
import type { DetailSource } from "./library-detail-helpers.ts";

/**
 * Top songs read on their own, for an artist page whose request lacked them.
 * Results from a previous artist are ignored. Undefined until a read lands.
 */
export function useArtistTopSongs(
  controller: AppController,
  enabled: boolean,
  id: string,
  source: DetailSource,
  catalogId: string | undefined,
): Track[] | undefined {
  const key = `${source}:${id}`;
  const [loaded, setLoaded] = useState<{ key: string; tracks: Track[] }>();
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    controller
      .loadArtistTopSongs(id, source, catalogId)
      .then((tracks) => {
        if (current) setLoaded({ key, tracks });
      })
      .catch((error: unknown) => {
        controller.log(
          `Top songs unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (current) setLoaded({ key, tracks: [] });
      });
    return () => {
      current = false;
    };
  }, [controller, enabled, id, source, catalogId, key]);
  return loaded?.key === key ? loaded.tracks : undefined;
}
