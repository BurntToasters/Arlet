import {
  Maximize,
  Minimize,
  Radio,
  Repeat,
  Shuffle,
  Star,
  ThumbsDown,
  X,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  useAppController,
  useAppRouter,
  useAppSelector,
  useAppSlices,
} from "../app/context.tsx";
import { ratingKeyOf, trackRatingTarget } from "../app/ratings.ts";
import type { MusicEntityRef, Track } from "../domain/music.ts";
import { useLiveMetadata } from "../musickit/live-metadata.ts";
import { setUiState } from "../state.ts";
import { Artwork } from "./Artwork.tsx";
import { IconButton } from "./IconButton.tsx";
import { liveSubtitle } from "./PlayerBar.tsx";
import { VirtualList } from "./VirtualList.tsx";
import { reportActionError } from "./action-errors.ts";
import { PlaybackProgress, TransportControls } from "./TransportControls.tsx";
import { VolumeControl } from "./VolumeControl.tsx";
import { displayArtistLinks } from "./artist-links.ts";
import {
  closeNowPlayingLeavingFullscreen,
  isWindowFullscreen,
  toggleWindowFullscreen,
} from "./window-fullscreen.ts";

const FOCUSABLE =
  "button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex='-1'])";
/** Matches the `.now-playing` exit transition in 24-now-playing.css. */
const CLOSE_TRANSITION_MS = 200;

function closeNowPlaying(): void {
  setUiState({ nowPlayingOpen: false });
}

function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

/**
 * Keeps the dialog mounted through its exit transition after `open` turns
 * false. Reduced motion unmounts at once, so no transition is waited for.
 */
function useDialogPresence(open: boolean): {
  rendered: boolean;
  closing: boolean;
} {
  const [exiting, setExiting] = useState(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      setExiting(false);
      return undefined;
    }
    if (!wasOpen.current) return undefined;
    wasOpen.current = false;
    if (prefersReducedMotion()) return undefined;
    setExiting(true);
    const id = window.setTimeout(() => setExiting(false), CLOSE_TRANSITION_MS);
    return () => window.clearTimeout(id);
  }, [open]);
  return { rendered: open || exiting, closing: !open && exiting };
}

/** Full-window Now Playing view. Mounted while open and through its exit. */
export function NowPlaying(): JSX.Element | null {
  // Only `ui` decides mounting; playback ticks re-render the dialog alone.
  const nowPlayingOpen = useAppSelector((store) => store.ui.nowPlayingOpen);
  const { rendered, closing } = useDialogPresence(nowPlayingOpen);
  if (!rendered) return null;
  return <NowPlayingDialog closing={closing} />;
}

function NowPlayingDialog({ closing }: { closing: boolean }): JSX.Element {
  const state = useAppSlices("initialization", "playback");
  const controller = useAppController();
  const router = useAppRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [fullscreen, setFullscreenState] = useState(false);
  const playback = state.playback;
  const current = playback.current;
  const playing = playback.status === "playing";
  const loading = playback.status === "loading";
  const canControl =
    state.initialization.status === "ready" && Boolean(current);
  const favoriteTarget = current ? trackRatingTarget(current) : undefined;
  const favoriteKey = favoriteTarget ? ratingKeyOf(favoriteTarget) : undefined;
  // Only the playing track's rating, so other ratings do not re-render the dialog.
  const rating = useAppSelector((store) =>
    favoriteKey !== undefined ? store.ratings[favoriteKey] : undefined,
  );
  const favorite = rating === 1;
  const disliked = rating === -1;
  const shuffling = playback.shuffleMode === "songs";
  const repeating = playback.repeatMode !== "off";
  const live = useLiveMetadata();
  const liveText = current?.isLive
    ? liveSubtitle(live, current.title)
    : undefined;

  useEffect(() => {
    // Unmounting happens on every close path, including the global Esc
    // shortcut, so focus always goes back to whatever opened the overlay.
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const opener = openerRef.current;
    return () => {
      // Closing already returned focus; only reclaim it if it is still lost
      // inside this dialog (or on the body) when the dialog unmounts.
      const active = document.activeElement;
      if (
        opener?.isConnected &&
        (!active || active === document.body || active.closest(".now-playing"))
      ) {
        opener.focus();
      }
    };
  }, []);

  useEffect(() => {
    // The exit transition hands focus back at once, so keys and clicks reach
    // the page behind while the overlay fades out.
    if (closing) {
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus();
    } else {
      closeRef.current?.focus();
    }
  }, [closing]);

  useEffect(() => {
    // Fullscreen can change outside this view (F11), so the button re-reads
    // the window state on every resize.
    let active = true;
    const refresh = (): void => {
      void isWindowFullscreen().then((value) => {
        if (active) setFullscreenState(value);
      });
    };
    refresh();
    window.addEventListener("resize", refresh);
    return () => {
      active = false;
      window.removeEventListener("resize", refresh);
    };
  }, []);

  const run = (action: () => Promise<void>): void => {
    void action().catch(reportActionError);
  };

  const onToggleFullscreen = (): void => {
    void toggleWindowFullscreen()
      .then(setFullscreenState)
      .catch(reportActionError);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void closeNowPlayingLeavingFullscreen();
      return;
    }
    const dialog = dialogRef.current;
    if (event.key !== "Tab" || !dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    const outside = !dialog.contains(active);
    if (event.shiftKey && (active === first || outside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || outside)) {
      event.preventDefault();
      first.focus();
    }
  };

  const navigateTo = (kind: "album" | "artist", ref: MusicEntityRef): void => {
    closeNowPlaying();
    router.navigate({
      kind,
      id: ref.id,
      ...(ref.source === "catalog" ? { source: "catalog" } : {}),
    });
  };

  const album = current?.albumRef;
  const artists = displayArtistLinks(
    current?.artistRefs ?? [],
    current?.artistName,
  );
  // Without Apple's bgColor the class and property are absent: the plain surface.
  const tint = current?.artwork?.bgColor;

  return (
    <div
      className={[
        "now-playing",
        tint ? "has-artwork-tint" : "",
        closing ? "is-closing" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={tint ? { "--now-playing-tint": `#${tint}` } : undefined}
      role="dialog"
      aria-modal="true"
      aria-label="Now Playing"
      tabIndex={-1}
      ref={dialogRef}
      onKeyDown={onKeyDown}
    >
      <header className="now-playing-header">
        <span className="eyebrow">Now playing</span>
        <div className="now-playing-header-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={!canControl}
            onClick={() => {
              if (!current) return;
              controller
                .startStation({
                  kind: "song",
                  id: current.id,
                  catalogId: current.catalogId,
                })
                .catch(reportActionError);
            }}
          >
            <Radio aria-hidden="true" size={16} /> Start Station
          </button>
          <IconButton
            icon={fullscreen ? Minimize : Maximize}
            label={fullscreen ? "Exit full screen" : "Enter full screen"}
            onClick={onToggleFullscreen}
          />
          <button
            ref={closeRef}
            className="icon-button"
            type="button"
            aria-label="Close Now Playing"
            onClick={closeNowPlaying}
          >
            <X aria-hidden="true" size={18} strokeWidth={1.8} />
          </button>
        </div>
      </header>
      <div className="now-playing-body">
        <section className="now-playing-hero">
          <Artwork
            track={current}
            size="xl"
            alt={current ? `${current.title} artwork` : "No song playing"}
            priority
          />
          <div className="now-playing-meta">
            <h2 title={current?.title}>
              {current?.title ?? "Nothing playing"}
            </h2>
            <p className="now-playing-artists">
              {liveText !== undefined ? (
                <span className="live-metadata-text" aria-live="polite">
                  {liveText}
                </span>
              ) : (
                <>
                  {album?.name && current ? (
                    <button
                      type="button"
                      aria-label={`Go to album: ${album.name}`}
                      onClick={() => navigateTo("album", album)}
                    >
                      {album.name}
                    </button>
                  ) : null}
                  {artists.length > 0
                    ? artists.map((artist, index) => (
                        <span key={artist.id}>
                          {index > 0 || album?.name ? (
                            <span aria-hidden="true"> · </span>
                          ) : null}
                          <button
                            type="button"
                            aria-label={`Go to artist: ${artist.name ?? current?.artistName ?? "Artist"}`}
                            onClick={() => navigateTo("artist", artist)}
                          >
                            {artist.name ?? current?.artistName}
                          </button>
                        </span>
                      ))
                    : (current?.artistName ?? null)}
                </>
              )}
            </p>
          </div>
          <div className="now-playing-controls">
            <TransportControls
              canControl={canControl}
              playing={playing}
              loading={loading}
              onPrevious={() => run(controller.previous)}
              onTogglePlayback={() => run(controller.togglePlayback)}
              onNext={() => run(controller.next)}
            />
            <PlaybackProgress
              hasTrack={Boolean(current)}
              onSeek={(seconds) => run(() => controller.seek(seconds))}
            />
            <div className="now-playing-actions">
              <div className="now-playing-group">
                {favoriteKey && favoriteTarget ? (
                  <>
                    <IconButton
                      icon={Star}
                      label={favorite ? "Undo Favorite" : "Favorite"}
                      pressed={favorite}
                      disabled={!canControl}
                      onClick={() =>
                        run(() =>
                          controller.rate(favoriteTarget, favorite ? 0 : 1),
                        )
                      }
                    />
                    <IconButton
                      icon={ThumbsDown}
                      label={disliked ? "Remove dislike" : "Dislike"}
                      pressed={disliked}
                      disabled={!canControl}
                      onClick={() =>
                        run(() =>
                          controller.rate(favoriteTarget, disliked ? 0 : -1),
                        )
                      }
                    />
                  </>
                ) : null}
              </div>
              <div className="now-playing-group">
                {playback.modeCapabilities?.shuffle ? (
                  <IconButton
                    icon={Shuffle}
                    label="Toggle shuffle"
                    pressed={shuffling}
                    className={shuffling ? "is-active" : ""}
                    onClick={() =>
                      run(() =>
                        controller.setShuffleMode(shuffling ? "off" : "songs"),
                      )
                    }
                  />
                ) : null}
                {playback.modeCapabilities?.repeat ? (
                  <IconButton
                    icon={Repeat}
                    label={`Repeat ${playback.repeatMode ?? "off"}`}
                    pressed={repeating}
                    className={repeating ? "is-active" : ""}
                    onClick={() => run(() => controller.cycleRepeatMode())}
                  />
                ) : null}
              </div>
              <VolumeControl />
            </div>
          </div>
        </section>
        <section className="now-playing-side">
          <h3 className="now-playing-side-heading">Up Next</h3>
          <UpNext
            queue={state.playback.queue}
            queueIndex={state.playback.queueIndex}
            onPlay={(index) =>
              void controller.playQueueItem(index).catch(reportActionError)
            }
          />
        </section>
      </div>
    </div>
  );
}

function UpNext({
  queue,
  queueIndex,
  onPlay,
}: {
  queue: readonly Track[];
  queueIndex: number;
  onPlay: (index: number) => void;
}): JSX.Element {
  const upcoming = queue
    .map((track, index) => ({ track, index }))
    .slice(queueIndex + 1);
  if (upcoming.length === 0) {
    return <p className="now-playing-empty">Nothing else is queued.</p>;
  }
  // The list is its own scroller, so the selector matches the list itself.
  return (
    <VirtualList
      className="now-playing-queue"
      aria-label="Up Next"
      items={upcoming}
      getKey={({ track, index }) => `${track.id}-${index}`}
      renderRow={({ track, index }) => (
        <li>
          <button type="button" onClick={() => onPlay(index)}>
            <Artwork track={track} size="sm" alt="" />
            <span className="now-playing-queue-copy">
              <strong>{track.title}</strong>
              <small>{track.artistName}</small>
            </span>
          </button>
        </li>
      )}
      scrollParentSelector=".now-playing-queue"
    />
  );
}
