import {
  LoaderCircle,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from "lucide-preact";
import type { JSX } from "preact";
import { usePlaybackPosition } from "../app/context.tsx";
import { IconButton } from "./IconButton.tsx";

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export interface TransportControlsProps {
  canControl: boolean;
  playing: boolean;
  loading: boolean;
  onPrevious: () => void;
  onTogglePlayback: () => void;
  onNext: () => void;
}

export function TransportControls({
  canControl,
  playing,
  loading,
  onPrevious,
  onTogglePlayback,
  onNext,
}: TransportControlsProps): JSX.Element {
  return (
    <div className="transport-controls">
      <IconButton
        icon={SkipBack}
        label="Previous track"
        disabled={!canControl}
        onClick={onPrevious}
      />
      <button
        className="play-button"
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        aria-pressed={playing}
        disabled={!canControl || loading}
        onClick={onTogglePlayback}
      >
        {loading ? (
          <LoaderCircle
            className="spin"
            aria-hidden="true"
            size={18}
            strokeWidth={2}
          />
        ) : playing ? (
          <Pause
            aria-hidden="true"
            size={18}
            fill="currentColor"
            strokeWidth={1.8}
          />
        ) : (
          <Play
            aria-hidden="true"
            size={18}
            fill="currentColor"
            strokeWidth={1.8}
          />
        )}
      </button>
      <IconButton
        icon={SkipForward}
        label="Next track"
        disabled={!canControl}
        onClick={onNext}
      />
    </div>
  );
}

/** Re-renders on playback ticks without re-rendering the whole bar. */
export function PlaybackProgress({
  hasTrack,
  onSeek,
}: {
  hasTrack: boolean;
  onSeek: (seconds: number) => void;
}): JSX.Element {
  const { positionSeconds, durationSeconds } = usePlaybackPosition();
  const progress =
    durationSeconds > 0
      ? Math.min(100, Math.max(0, (positionSeconds / durationSeconds) * 100))
      : 0;
  return (
    <div className="player-progress">
      <span>{formatTime(positionSeconds)}</span>
      <input
        aria-label="Playback position"
        type="range"
        min="0"
        max={String(Math.max(0, durationSeconds))}
        step="1"
        value={Math.min(durationSeconds, Math.max(0, positionSeconds))}
        style={{ "--range-progress": `${progress}%` }}
        disabled={!hasTrack || durationSeconds <= 0}
        onChange={(event) => onSeek(Number(event.currentTarget.value))}
      />
      <span>{formatTime(durationSeconds)}</span>
    </div>
  );
}
