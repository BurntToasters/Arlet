import { MoreHorizontal, Play, SkipForward } from "lucide-preact";
import type { JSX } from "preact";
import { Artwork } from "./Artwork.tsx";
import { requestContextMenu } from "./context-menu-events.ts";
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
}

/** Shared song row. Main playback and row actions stay sibling buttons. */
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
}: SongRowProps): JSX.Element {
  const trackLabel = `${track.title} by ${track.artistName}`;
  return (
    <li>
      <div className="song-row-shell" {...contextData}>
        <button
          className={rowClassName}
          type="button"
          disabled={disabled}
          aria-label={`Play ${trackLabel}`}
          onClick={onPlay}
        >
          <span className={numberClassName} aria-hidden="true">
            {String(index + 1).padStart(2, "0")}
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
            <strong title={track.title}>{track.title}</strong>
            <span title={track.artistName}>
              {track.artistName}
              {track.albumTitle ? ` · ${track.albumTitle}` : ""}
            </span>
          </span>
          {track.explicit ? <span className="explicit-badge">E</span> : null}
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
            disabled={disabled}
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
