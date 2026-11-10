import {
  LoaderCircle,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from "lucide-preact";
import type { JSX } from "preact";
import { useLayoutEffect, useState } from "preact/hooks";
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
        // The label carries the state, so the button is not also a toggle.
        aria-label={playing ? "Pause" : "Play"}
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
  seekable = true,
  onSeek,
}: {
  hasTrack: boolean;
  /** False for a parked station, which cannot be scrubbed. */
  seekable?: boolean;
  onSeek: (seconds: number) => void;
}): JSX.Element {
  const { positionSeconds, durationSeconds } = usePlaybackPosition();
  // While pressed or dragged the slider shows the pointer, not playback. A
  // tick re-rendering `value` mid-press would move the thumb and reset
  // Chromium's change baseline, so the release would seek to the tick.
  const [scrubSeconds, setScrubSeconds] = useState<number | null>(null);
  const scrubbing = scrubSeconds !== null;
  // A layout effect, so the listeners are in place before the next frame; a
  // blur straight after the press would otherwise be missed.
  useLayoutEffect(() => {
    if (!scrubbing) return;
    // A release where the press started fires no change; drop the hold once
    // the release's own change event has had its turn. A blur can swallow the
    // release when focus leaves mid-drag, so it drops the hold too.
    let timer: number | undefined;
    const release = (): void => {
      timer = window.setTimeout(() => setScrubSeconds(null), 0);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
      window.clearTimeout(timer);
    };
  }, [scrubbing]);
  const shownSeconds = scrubSeconds ?? positionSeconds;
  const progress =
    durationSeconds > 0
      ? Math.min(100, Math.max(0, (shownSeconds / durationSeconds) * 100))
      : 0;
  return (
    <div className="player-progress">
      <span>{formatTime(shownSeconds)}</span>
      <input
        aria-label="Playback position"
        type="range"
        min="0"
        max={String(Math.max(0, durationSeconds))}
        step="1"
        value={Math.min(durationSeconds, Math.max(0, shownSeconds))}
        aria-valuetext={`${formatTime(shownSeconds)} of ${formatTime(durationSeconds)}`}
        style={{ "--range-progress": `${progress}%` }}
        disabled={!hasTrack || !seekable || durationSeconds <= 0}
        onInput={(event) => setScrubSeconds(Number(event.currentTarget.value))}
        onChange={(event) => {
          setScrubSeconds(null);
          onSeek(Number(event.currentTarget.value));
        }}
      />
      <span>{formatTime(durationSeconds)}</span>
    </div>
  );
}
