import {
  CircleAlert,
  Heart,
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
import { useEffect, useState } from "preact/hooks";
import {
  useAppController,
  useAppRouter,
  useAppState,
  usePlaybackPosition,
} from "../app/context.tsx";
import { ratingKeyOf, trackRatingTarget } from "../app/ratings.ts";
import type { AppErrorCode } from "../domain/errors.ts";
import type { Track } from "../domain/music.ts";
import type { TrackNavigation } from "../musickit/song-navigation.ts";
import { Artwork } from "./Artwork.tsx";
import { IconButton } from "./IconButton.tsx";
import { reportActionError } from "./action-errors.ts";

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

/** Re-renders on playback ticks without re-rendering the whole bar. */
function PlaybackProgress({
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

export function PlayerBar(): JSX.Element {
  const state = useAppState();
  const controller = useAppController();
  const router = useAppRouter();
  const playback = state.playback;
  const current = playback.current;
  const playing = playback.status === "playing";
  const loading = playback.status === "loading";
  const muted = playback.muted === true;
  const shownVolume = muted ? 0 : playback.volume;
  const canControl =
    state.initialization.status === "ready" && Boolean(current);
  const loveTarget = current ? trackRatingTarget(current) : undefined;
  const loveKey = loveTarget ? ratingKeyOf(loveTarget) : undefined;
  const loved = loveKey !== undefined && state.ratings[loveKey] === 1;
  const [resolvedNavigation, setResolvedNavigation] = useState<{
    track: Track;
    value: TrackNavigation;
  }>();

  useEffect(() => {
    let active = true;
    if (!current) {
      setResolvedNavigation(undefined);
      return () => {
        active = false;
      };
    }
    const resolve = controller.resolveTrackNavigation;
    if (!resolve) {
      setResolvedNavigation({
        track: current,
        value: {
          album: current.albumRef,
          artists: current.artistRefs ?? [],
        },
      });
      return () => {
        active = false;
      };
    }
    void resolve(current)
      .then((value) => {
        if (active) setResolvedNavigation({ track: current, value });
      })
      .catch((error: unknown) => {
        if (active) reportActionError(error);
      });
    return () => {
      active = false;
    };
  }, [
    controller,
    current,
    current?.id,
    current?.catalogId,
    current?.albumTitle,
    current?.artistName,
    current?.albumRef?.id,
    JSON.stringify(current?.artistRefs ?? []),
  ]);

  const navigation =
    current &&
    resolvedNavigation &&
    resolvedNavigation.track.id === current.id &&
    resolvedNavigation.track.catalogId === current.catalogId
      ? resolvedNavigation.value
      : {
          album: current?.albumRef,
          artists: current?.artistRefs ?? [],
        };

  const navigateTo = (
    kind: "album" | "artist",
    ref: NonNullable<TrackNavigation["album"]>,
  ): void => {
    router.navigate({
      kind,
      id: ref.id,
      ...(ref.source === "catalog" ? { source: "catalog" } : {}),
    });
  };

  const run = (action: () => Promise<void>): void => {
    void action().catch(reportActionError);
  };

  return (
    <footer className="player-bar" aria-label="Now playing">
      <div
        className="player-track"
        data-context-kind={current ? "track" : undefined}
        data-context-id={current?.id}
        data-context-title={current?.title}
        data-context-artist={current?.artistName}
        data-context-album={current?.albumTitle}
        data-context-resource-type={current?.resourceType}
        data-context-catalog-id={current?.catalogId}
        data-context-album-ref={
          navigation.album ? JSON.stringify(navigation.album) : undefined
        }
        data-context-artist-refs={
          navigation.artists.length
            ? JSON.stringify(navigation.artists)
            : undefined
        }
      >
        <Artwork
          track={current}
          size="sm"
          alt={current ? `${current.title} artwork` : "No song playing"}
        />
        <div className="player-track-copy">
          <strong title={current?.title}>
            {current?.title && navigation.album ? (
              <button
                className="player-title-album"
                type="button"
                data-player-navigation="album"
                data-player-navigation-id={navigation.album.id}
                aria-label={`Go to album: ${navigation.album.name ?? current.title}`}
                onClick={() => navigateTo("album", navigation.album!)}
              >
                {current.title}
              </button>
            ) : (
              (current?.title ?? "Nothing playing")
            )}
          </strong>
          <div className="player-track-links">
            {navigation.artists.length ? (
              navigation.artists.map((artist, index) => (
                <span className="player-track-link-group" key={artist.id}>
                  {index > 0 ? <span aria-hidden="true">, </span> : null}
                  <button
                    type="button"
                    data-player-navigation="artist"
                    data-player-navigation-id={artist.id}
                    aria-label={`Go to artist: ${artist.name ?? `Artist ${index + 1}`}`}
                    title={artist.name ?? current?.artistName}
                    onClick={() => navigateTo("artist", artist)}
                  >
                    {artist.name ??
                      (navigation.artists.length === 1
                        ? current?.artistName
                        : `Artist ${index + 1}`)}
                  </button>
                </span>
              ))
            ) : current?.artistName ? (
              <span title={current.artistName}>{current.artistName}</span>
            ) : (
              <span>Choose something to listen to</span>
            )}
          </div>
        </div>
        {loveKey && loveTarget ? (
          <IconButton
            icon={Heart}
            label={loved ? "Unlove" : "Love"}
            pressed={loved}
            disabled={!canControl}
            onClick={() =>
              run(() => controller.rate(loveTarget, loved ? 0 : 1))
            }
          />
        ) : null}
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
        <PlaybackProgress
          hasTrack={Boolean(current)}
          onSeek={(seconds) => run(() => controller.seek(seconds))}
        />
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
              ).catch(reportActionError)
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
                reportActionError,
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
          <button
            className="volume-mute-button"
            type="button"
            aria-label={muted ? "Unmute" : "Mute"}
            aria-pressed={muted}
            onClick={controller.toggleMute}
          >
            {muted || playback.volume === 0 ? (
              <VolumeX aria-hidden="true" size={16} strokeWidth={1.8} />
            ) : (
              <Volume2 aria-hidden="true" size={16} strokeWidth={1.8} />
            )}
          </button>
          <input
            aria-label="Volume"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={shownVolume}
            style={{ "--range-progress": `${shownVolume * 100}%` }}
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
