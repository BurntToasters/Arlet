import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { useAppRouter } from "../app/context.tsx";
import { safeErrorMessage } from "../app/controller-support.ts";
import type { AppController } from "../app/controller.ts";
import type { PlaylistCuratorRef } from "../musickit/curators.ts";
import type { ResourceLike } from "./LibraryView.tsx";
import { detailSummary, playlistCuratedBy } from "./detail-meta.ts";

/** "Curated by X": a button to the curator's page when Apple named one. */
function CuratedBy({
  label,
  curator,
}: {
  label: string;
  curator?: PlaylistCuratorRef;
}): JSX.Element {
  const router = useAppRouter();
  if (!curator) return <>{label}</>;
  return (
    <button
      className="curator-link"
      type="button"
      onClick={() =>
        router.navigate({
          kind: "curator",
          id: curator.id,
          curatorKind: curator.kind,
        })
      }
    >
      {label}
    </button>
  );
}

/**
 * A catalog playlist's curator, read on its own so the track list does not
 * wait for it. Undefined until the read lands or when Apple names none.
 */
export function usePlaylistCurator(
  controller: AppController,
  enabled: boolean,
  id: string,
): PlaylistCuratorRef | undefined {
  const [loaded, setLoaded] = useState<{
    id: string;
    curator?: PlaylistCuratorRef;
  }>();
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    controller
      .loadPlaylistCurator(id)
      .then((curator) => {
        if (current) setLoaded({ id, curator });
      })
      .catch((error: unknown) => {
        controller.log(`Curator unavailable: ${safeErrorMessage(error)}`);
        if (current) setLoaded({ id });
      });
    return () => {
      current = false;
    };
  }, [controller, enabled, id]);
  return loaded?.id === id ? loaded.curator : undefined;
}

/** The metadata line under an album or playlist title. */
export function DetailSummary({
  kind,
  resource,
  tracks,
  complete,
  curator,
}: {
  kind: "album" | "playlist";
  resource: ResourceLike;
  tracks: ResourceLike[];
  complete: boolean;
  curator?: PlaylistCuratorRef;
}): JSX.Element | null {
  const parts = detailSummary(kind, resource, tracks, complete);
  const curatedBy =
    kind === "playlist" ? playlistCuratedBy(resource) : undefined;
  if (parts.length === 0 && !curatedBy) return null;
  return (
    <p className="library-detail-meta">
      {parts.join(" · ")}
      {parts.length > 0 && curatedBy ? " · " : null}
      {curatedBy ? <CuratedBy label={curatedBy} curator={curator} /> : null}
    </p>
  );
}
