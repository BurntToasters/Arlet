import { Forward, ListPlus, SkipForward, Star, X } from "lucide-preact";
import type { JSX } from "preact";
import { useAppController } from "../app/context.tsx";
import { trackRatingTarget } from "../app/ratings.ts";
import type { Track } from "../domain/music.ts";
import { reportActionError } from "./action-errors.ts";
import { requestPlaylistDialog } from "./playlist-events.ts";

/** User actions; failures surface as a toast. */
function act(action: () => Promise<unknown> | undefined): void {
  void Promise.resolve(action()).catch(reportActionError);
}

/**
 * Actions for 2 or more selected songs. Shown sticky at the bottom of the
 * list; the selection stays after an action so several can be chained.
 */
export function SelectionBar({
  tracks,
  onClear,
}: {
  tracks: readonly Track[];
  onClear: () => void;
}): JSX.Element | null {
  const controller = useAppController();
  if (tracks.length < 2) return null;
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selected songs">
      <span
        className="selection-count"
        role="status"
      >{`${tracks.length} selected`}</span>
      <div className="selection-bar-actions">
        <button
          className="primary-button"
          type="button"
          data-selection-action="play-next"
          onClick={() => act(() => controller.playNextTracks(tracks))}
        >
          <SkipForward aria-hidden="true" size={15} strokeWidth={1.9} />
          Play Next
        </button>
        <button
          className="secondary-button"
          type="button"
          data-selection-action="play-later"
          onClick={() => act(() => controller.playLaterTracks(tracks))}
        >
          <Forward aria-hidden="true" size={15} strokeWidth={1.9} />
          Play Later
        </button>
        <button
          className="secondary-button"
          type="button"
          data-selection-action="add-to-playlist"
          onClick={(event) =>
            requestPlaylistDialog("picker", tracks, event.currentTarget)
          }
        >
          <ListPlus aria-hidden="true" size={15} strokeWidth={1.9} />
          Add to Playlist…
        </button>
        <button
          className="secondary-button"
          type="button"
          data-selection-action="favorite"
          onClick={() =>
            act(() =>
              Promise.all(
                tracks.map((track) =>
                  controller.rate(trackRatingTarget(track), 1),
                ),
              ),
            )
          }
        >
          <Star aria-hidden="true" size={15} strokeWidth={1.9} />
          Favorite
        </button>
        <button
          className="secondary-button"
          type="button"
          data-selection-action="clear"
          onClick={onClear}
        >
          <X aria-hidden="true" size={15} strokeWidth={1.9} />
          Clear
        </button>
      </div>
    </div>
  );
}
