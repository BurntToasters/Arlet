import {
  CircleAlert,
  ListMusic,
  LoaderCircle,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  Shuffle,
  Volume2,
  VolumeX,
} from "lucide-preact";
import type { JSX } from "preact";
import { useAppController, useAppState } from "../app/context.tsx";
import type { AppErrorCode } from "../domain/errors.ts";
import { Artwork } from "./Artwork.tsx";
import { IconButton } from "./IconButton.tsx";

export function playerErrorLabel(code: AppErrorCode): string {
  switch (code) {
    case "NETWORK":
      return "No connection";
    case "AUTH_REQUIRED":
      return "Sign in needed";
    case "SUBSCRIPTION_REQUIRED":
      return "Subscription needed";
    case "TOKEN_EXPIRED":
      return "Session expired";
    case "MUSICKIT_INIT_FAILED":
      return "Player unavailable";
    case "PLAYBACK_FAILED":
      return "Can't play";
    case "CONTENT_UNAVAILABLE":
      return "Unavailable";
    case "RATE_LIMITED":
      return "Rate limited";
    case "UPDATER_FAILED":
      return "Update failed";
    case "UNKNOWN":
      return "Error";
  }
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function PlayerBar(): JSX.Element {
  const state = useAppState();
  const controller = useAppController();
  const playback = state.playback;
  const current = playback.current;
  const playing = playback.status === "playing";
  const loading = playback.status === "loading";
  const canControl =
    state.initialization.status === "ready" && Boolean(current);
  const progress =
    playback.durationSeconds > 0
      ? Math.min(
          100,
          Math.max(
            0,
            (playback.positionSeconds / playback.durationSeconds) * 100,
          ),
        )
      : 0;

  const run = (action: () => Promise<void>): void => {
    void action().catch(() => undefined);
  };

  const onSeek = (event: JSX.TargetedEvent<HTMLInputElement>): void => {
    run(() => controller.seek(Number(event.currentTarget.value)));
  };

  return (
    <footer className="player-bar" aria-label="Now playing">
      <div className="player-track">
        <Artwork
          track={current}
          size="sm"
          alt={current ? `${current.title} artwork` : "No song playing"}
        />
        <div className="player-track-copy">
          <strong title={current?.title}>
            {current?.title ?? "Nothing playing"}
          </strong>
          <span title={current?.artistName}>
            {current?.artistName ?? "Choose something to listen to"}
          </span>
        </div>
        {current?.explicit ? <span className="explicit-badge">E</span> : null}
      </div>

      <div className="player-center">
        <div className="transport-controls">
          <IconButton
            icon={SkipBack}
            label="Previous track"
            disabled={!canControl}
            onClick={() => run(controller.previous)}
          />
          <button
            className="play-button"
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            aria-pressed={playing}
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
            onClick={() => run(controller.next)}
          />
        </div>
        <div className="player-progress">
          <span>{formatTime(playback.positionSeconds)}</span>
          <input
            aria-label="Playback position"
            type="range"
            min="0"
            max={String(Math.max(0, playback.durationSeconds))}
            step="1"
            value={Math.min(
              playback.durationSeconds,
              Math.max(0, playback.positionSeconds),
            )}
            style={{ "--range-progress": `${progress}%` }}
            disabled={!current || playback.durationSeconds <= 0}
            onChange={onSeek}
          />
          <span>{formatTime(playback.durationSeconds)}</span>
        </div>
      </div>

      <div className="player-actions">
        {playback.modeCapabilities?.shuffle ? (
          <IconButton
            icon={Shuffle}
            label="Toggle shuffle"
            pressed={playback.shuffleMode === "songs"}
            className={playback.shuffleMode === "songs" ? "is-active" : ""}
            onClick={() =>
              void Promise.resolve(
                controller.setShuffleMode?.(
                  playback.shuffleMode === "songs" ? "off" : "songs",
                ),
              ).catch(() => undefined)
            }
          />
        ) : null}
        {playback.modeCapabilities?.repeat ? (
          <IconButton
            icon={Repeat}
            label={`Repeat ${playback.repeatMode ?? "off"}`}
            pressed={playback.repeatMode !== "off"}
            className={playback.repeatMode !== "off" ? "is-active" : ""}
            onClick={() =>
              void Promise.resolve(controller.cycleRepeatMode?.()).catch(
                () => undefined,
              )
            }
          />
        ) : null}
        {playback.error ? (
          <span className="player-error" title={playback.error.message}>
            <CircleAlert aria-hidden="true" size={15} strokeWidth={1.9} />
            <span>{playerErrorLabel(playback.error.code)}</span>
          </span>
        ) : null}
        <div className="volume-control">
          {playback.volume === 0 ? (
            <VolumeX aria-hidden="true" size={16} strokeWidth={1.8} />
          ) : (
            <Volume2 aria-hidden="true" size={16} strokeWidth={1.8} />
          )}
          <input
            aria-label="Volume"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={playback.volume}
            style={{ "--range-progress": `${playback.volume * 100}%` }}
            onInput={(event) => {
              void controller.setVolume(Number(event.currentTarget.value));
            }}
          />
        </div>
        <IconButton
          icon={ListMusic}
          label="Toggle Playing Next"
          pressed={state.ui.queueOpen}
          className={state.ui.queueOpen ? "is-active" : ""}
          onClick={controller.toggleQueue}
        />
      </div>
    </footer>
  );
}
