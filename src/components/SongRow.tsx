import { MoreHorizontal, Play, SkipForward, Star } from "lucide-preact";
import type { JSX } from "preact";
import { useAppSelector } from "../app/context.tsx";
import { ratingKeyOf, trackRatingTarget } from "../app/ratings.ts";
import { Artwork } from "./Artwork.tsx";
import { requestContextMenu } from "./context-menu-events.ts";
import { useNowPlayingStatus } from "./now-playing.ts";
import { useSerializedContextRefs } from "./context-refs.ts";
import {
  activeSelectionFor,
  endTrackDrag,
  startTrackDrag,
  TRACK_DRAG_TYPE,
} from "./track-selection.ts";
import { useVisibleRatingLookup } from "./use-visible-ratings.ts";
import type { Track } from "../domain/music.ts";

function formatDuration(durationMs?: number): string {
  if (!durationMs || durationMs <= 0) return "—";
  const seconds = Math.floor(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export interface SongRowProps {
  track: Track;
  index: number;
  onPlay: () => void;
  onPlayNext?: () => void;
  disabled: boolean;
  rowClassName: string;
  numberClassName: string;
  copyClassName: string;
  durationClassName: string;
  contextData?: Record<string, string>;
  /**
   * Multi-disc album lists: show the track's position on its disc instead of
   * the row number. Rows without a track number keep the row number.
   */
  discTrackNumbers?: boolean;
  /** The row is part of its list's selection. Used with onSelect. */
  selected?: boolean;
  /**
   * Called for every click. Returns true when the click was a selection
   * gesture (Ctrl, Meta or Shift), so the row does not play.
   */
  onSelect?: (event: MouseEvent) => boolean;
}

/**
 * Shared song row. Main playback and row actions stay sibling buttons. The
 * shell is draggable: the drag carries the selection when this row is in it.
 */
export function SongRow({
  track,
  index,
  onPlay,
  onPlayNext,
  disabled,
  rowClassName,
  numberClassName,
  copyClassName,
  durationClassName,
  contextData,
  discTrackNumbers = false,
  selected = false,
  onSelect,
}: SongRowProps): JSX.Element {
  const trackLabel = `${track.title} by ${track.artistName}`;
  const nowPlaying = useNowPlayingStatus(track);
  const refs = useSerializedContextRefs(track.albumRef, track.artistRefs);
  const current = nowPlaying !== "none";
  // Apple marks songs it cannot stream; the menu still offers navigation.
  const unavailable = track.playable === false;
  const ratingTarget = trackRatingTarget(track);
  const ratingKey = ratingKeyOf(ratingTarget);
  // Each row watches only its own rating, so a change re-renders one row.
  const favorite = useAppSelector(
    (state) => ratingKey !== undefined && state.ratings[ratingKey] === 1,
  );
  const lookupRef = useVisibleRatingLookup<HTMLLIElement>(ratingTarget);
  const rowNumber =
    discTrackNumbers && track.trackNumber ? track.trackNumber : index + 1;
  // The play button's label replaces its content, so the badges are spoken here.
  const extras = [
    ...(favorite ? ["favorite"] : []),
    ...(track.explicit ? ["explicit"] : []),
  ];
  const playFlags = [
    ...(current ? [nowPlaying === "playing" ? "now playing" : "paused"] : []),
    // Selection is part of the play button's name; a plain list has no aria-selected.
    ...(onSelect && selected ? ["selected"] : []),
    ...extras,
  ];
  return (
    <li ref={lookupRef} className={selected ? "is-selected" : undefined}>
      <div
        className={[
          "song-row-shell",
          current ? "is-current" : "",
          unavailable ? "is-unavailable" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={unavailable ? "Not available on Apple Music" : undefined}
        {...contextData}
        data-context-album-ref={refs.album}
        data-context-artist-refs={refs.artists}
        data-context-catalog-url={track.catalogUrl}
        draggable
        onDragStart={(event) => {
          // A selected row drags the whole selection; any other row drags alone.
          const tracks = activeSelectionFor(track.id, event.currentTarget) ?? [
            track,
          ];
          startTrackDrag(tracks);
          const transfer = event.dataTransfer;
          if (!transfer) return;
          transfer.effectAllowed = "copy";
          transfer.setData(
            TRACK_DRAG_TYPE,
            JSON.stringify(tracks.map((item) => item.id)),
          );
          transfer.setData(
            "text/plain",
            tracks.map((item) => item.title).join("\n"),
          );
        }}
        onDragEnd={() => endTrackDrag()}
      >
        <button
          className={rowClassName}
          type="button"
          disabled={disabled || unavailable}
          aria-label={
            unavailable
              ? `${trackLabel} (${["not available on Apple Music", ...extras].join(", ")})`
              : playFlags.length
                ? `Play ${trackLabel} (${playFlags.join(", ")})`
                : `Play ${trackLabel}`
          }
          aria-current={current ? "true" : undefined}
          onClick={(event) => {
            if (onSelect?.(event)) return;
            onPlay();
          }}
        >
          <span className={numberClassName} aria-hidden="true">
            {current ? (
              <span
                className={
                  nowPlaying === "playing"
                    ? "now-playing-bars is-playing"
                    : "now-playing-bars"
                }
              >
                <span />
                <span />
                <span />
              </span>
            ) : (
              String(rowNumber).padStart(2, "0")
            )}
          </span>
          <span className="song-row-artwork">
            <Artwork track={track} size="sm" alt="" />
            <span className="song-row-artwork-overlay" aria-hidden="true">
              <span className="row-play-button">
                <Play size={15} fill="currentColor" strokeWidth={1.9} />
              </span>
            </span>
          </span>
          <span className={copyClassName}>
            <strong title={track.title}>
              {track.title}
              {favorite ? (
                <Star
                  className="song-row-favorite"
                  aria-hidden="true"
                  size={12}
                  fill="currentColor"
                  strokeWidth={1.9}
                />
              ) : null}
            </strong>
            <span title={track.artistName}>
              {track.artistName}
              {track.albumTitle ? ` · ${track.albumTitle}` : ""}
            </span>
          </span>
          {track.explicit ? (
            <span className="explicit-badge" role="img" aria-label="Explicit">
              E
            </span>
          ) : null}
          <span className={durationClassName}>
            {formatDuration(track.durationMs)}
          </span>
        </button>
        <div
          className="song-row-actions"
          aria-label={`Actions for ${trackLabel}`}
        >
          <button
            className="song-row-action song-row-next"
            type="button"
            aria-label={`Play ${trackLabel} next`}
            title="Play next"
            disabled={disabled || unavailable}
            onClick={onPlayNext ?? (() => undefined)}
          >
            <SkipForward aria-hidden="true" size={16} strokeWidth={1.9} />
          </button>
          <button
            className="song-row-action song-row-more"
            type="button"
            aria-label={`More actions for ${trackLabel}`}
            title="More actions"
            aria-haspopup="menu"
            disabled={disabled}
            onClick={(event) => {
              const target = event.currentTarget.closest<HTMLElement>(
                "[data-context-kind], [data-context-track-id]",
              );
              if (target) requestContextMenu(target, event.currentTarget);
            }}
          >
            <MoreHorizontal aria-hidden="true" size={17} strokeWidth={1.9} />
          </button>
        </div>
      </div>
    </li>
  );
}
