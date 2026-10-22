import {
  LoaderCircle,
  Maximize2,
  Pause,
  Pin,
  Play,
  SkipBack,
  SkipForward,
} from "lucide-preact";
import type { JSX, TargetedMouseEvent } from "preact";
import { useState } from "preact/hooks";
import {
  useAppController,
  usePlaybackPosition,
  useAppSlices,
} from "../app/context.tsx";
import { exitMiniPlayer } from "../app/mini-player.ts";
import { setMiniPlayerOnTop } from "../platform/mini-player.ts";
import { startWindowDrag } from "../platform/window.ts";
import { Artwork } from "./Artwork.tsx";
import { reportActionError } from "./action-errors.ts";

/**
 * Thin read-only progress line. It subscribes to the playback position itself,
 * so the position ticks do not re-render the player.
 */
function MiniProgress(): JSX.Element {
  const { positionSeconds, durationSeconds } = usePlaybackPosition();
  const progress =
    durationSeconds > 0
      ? Math.min(100, Math.max(0, (positionSeconds / durationSeconds) * 100))
      : 0;
  return (
    <div
      className="mini-player-progress"
      role="progressbar"
      aria-label="Mini player progress"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, Math.round(durationSeconds))}
      aria-valuenow={Math.round(positionSeconds)}
    >
      <span style={{ width: `${progress}%` }} />
    </div>
  );
}

/**
 * Compact layout shown instead of the main shell while the window is in mini
 * mode. App.tsx mounts it and keeps the playback components alive.
 */
export function MiniPlayer(): JSX.Element {
  const state = useAppSlices("initialization", "playback");
  const controller = useAppController();
  const playback = state.playback;
  const current = playback.current;
  const playing = playback.status === "playing";
  const loading = playback.status === "loading";
  const canControl =
    state.initialization.status === "ready" && Boolean(current);
  // Always on top is the default each time mini mode starts (native side).
  const [onTop, setOnTop] = useState(true);

  const run = (action: () => Promise<void>): void => {
    void action().catch(reportActionError);
  };

  const togglePin = (): void => {
    const next = !onTop;
    setOnTop(next);
    setMiniPlayerOnTop(next).catch((error: unknown) => {
      setOnTop(!next);
      reportActionError(error);
    });
  };

  // Like the titlebar, but without double-click maximize: a 360 px window
  // should not jump to full screen.
  const onDragStart = (event: TargetedMouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-no-drag], button, input")) return;
    void startWindowDrag().catch(() => undefined);
  };

  return (
    <div
      className="mini-player"
      role="region"
      aria-label="Mini player"
      onMouseDown={onDragStart}
    >
      <Artwork
        className="mini-player-artwork"
        track={current}
        size="sm"
        alt={current ? `${current.title} artwork` : "No song playing"}
      />
      <div className="mini-player-head">
        <div className="mini-player-copy" title={current?.title}>
          <strong>{current?.title ?? "Not playing"}</strong>
          <span>{current?.artistName ?? ""}</span>
        </div>
        <button
          className={`mini-player-button${onTop ? " is-active" : ""}`}
          type="button"
          data-mini-pin
          data-no-drag
          aria-label="Keep on top"
          aria-pressed={onTop}
          title="Keep on top"
          onClick={togglePin}
        >
          <Pin aria-hidden="true" size={15} strokeWidth={1.9} />
        </button>
        <button
          className="mini-player-button"
          type="button"
          data-mini-expand
          data-no-drag
          aria-label="Exit mini player"
          title="Exit mini player"
          onClick={() => run(exitMiniPlayer)}
        >
          <Maximize2 aria-hidden="true" size={15} strokeWidth={1.9} />
        </button>
      </div>
      <div className="mini-player-controls">
        <button
          className="mini-player-button"
          type="button"
          data-no-drag
          aria-label="Previous track"
          disabled={!canControl}
          onClick={() => run(controller.previous)}
        >
          <SkipBack aria-hidden="true" size={17} fill="currentColor" />
        </button>
        <button
          className="mini-player-button mini-player-play"
          type="button"
          data-no-drag
          aria-label={playing ? "Pause" : "Play"}
          disabled={!canControl || loading}
          onClick={() => run(controller.togglePlayback)}
        >
          {loading ? (
            <LoaderCircle
              className="spin"
              aria-hidden="true"
              size={18}
              strokeWidth={2}
            />
          ) : playing ? (
            <Pause aria-hidden="true" size={18} fill="currentColor" />
          ) : (
            <Play aria-hidden="true" size={18} fill="currentColor" />
          )}
        </button>
        <button
          className="mini-player-button"
          type="button"
          data-no-drag
          aria-label="Next track"
          disabled={!canControl}
          onClick={() => run(controller.next)}
        >
          <SkipForward aria-hidden="true" size={17} fill="currentColor" />
        </button>
      </div>
      <MiniProgress />
    </div>
  );
}
