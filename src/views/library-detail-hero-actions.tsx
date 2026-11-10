import { LibraryBig, MoreHorizontal, Pin, PinOff, Star } from "lucide-preact";
import { useEffect } from "preact/hooks";
import type { JSX } from "preact";
import { useAppSelector } from "../app/context.tsx";
import type { AppController } from "../app/controller.ts";
import {
  isLibraryTarget,
  ratingKeyOf,
  type RatingTarget,
} from "../app/ratings.ts";
import { getState } from "../state.ts";
import { requestContextMenu } from "../components/context-menu-events.ts";
import { resourceSource } from "./detail-context.ts";
import type { ResourceLike } from "./LibraryView.tsx";
import { act, run } from "./library-detail-helpers.ts";

/** The rating target the context menu builds for a page of this kind. */
function ratingTargetFor(kind: "album" | "playlist", id: string): RatingTarget {
  return { type: kind === "album" ? "albums" : "playlists", id };
}

/** Favorite, Add to Library, Pin and "…" for an album or playlist header. */
export function DetailHeroActions({
  kind,
  id,
  title,
  resource,
  controller,
  online,
}: {
  kind: "album" | "playlist";
  id: string;
  title: string;
  resource: ResourceLike;
  controller: AppController;
  /** Writes to Apple Music need an authorized session that is not offline. */
  online: boolean;
}): JSX.Element {
  const ratingTarget = ratingTargetFor(kind, id);
  const key = ratingKeyOf(ratingTarget);
  const favorite = useAppSelector(
    (state) => key !== undefined && state.ratings[key] === 1,
  );
  const pinned = useAppSelector((state) =>
    state.pins.some((pin) => pin.id === id),
  );
  const canAddToLibrary =
    !isLibraryTarget(ratingTarget) && resourceSource(resource) !== "library";
  useEffect(() => {
    if (online) run(() => controller.loadRating(ratingTargetFor(kind, id)));
  }, [online, controller, kind, id]);
  const toggleFavorite = (): void => {
    if (key === undefined) return;
    // Toggle against the value at click time, as the context menu does.
    const current = getState().ratings[key];
    run(() => controller.rate(ratingTarget, current === 1 ? 0 : 1));
  };
  const togglePin = (): void =>
    act(() =>
      pinned
        ? controller.unpin(id)
        : controller.togglePin(id, resourceSource(resource) ?? "library"),
    );
  return (
    <>
      <button
        className="secondary-button"
        type="button"
        aria-pressed={favorite}
        disabled={!online}
        onClick={toggleFavorite}
      >
        <Star
          aria-hidden="true"
          size={16}
          fill={favorite ? "currentColor" : "none"}
        />{" "}
        Favorite
      </button>
      {canAddToLibrary ? (
        <button
          className="secondary-button"
          type="button"
          disabled={!online}
          onClick={() => run(() => controller.addToLibrary(ratingTarget))}
        >
          <LibraryBig aria-hidden="true" size={16} /> Add to Library
        </button>
      ) : null}
      {kind === "playlist" ? (
        <button className="secondary-button" type="button" onClick={togglePin}>
          {pinned ? (
            <PinOff aria-hidden="true" size={16} />
          ) : (
            <Pin aria-hidden="true" size={16} />
          )}{" "}
          {pinned ? "Unpin" : "Pin"}
        </button>
      ) : null}
      <button
        className="icon-button"
        type="button"
        aria-label={`More actions for ${title}`}
        title="More actions"
        aria-haspopup="menu"
        onClick={(event) => {
          const target = event.currentTarget.closest<HTMLElement>(
            "[data-context-kind]",
          );
          if (target) requestContextMenu(target, event.currentTarget);
        }}
      >
        <MoreHorizontal aria-hidden="true" size={16} />
      </button>
    </>
  );
}
