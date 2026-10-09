import { X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import {
  useAppController,
  useAppRouter,
  useAppState,
} from "../app/context.tsx";
import type { MusicEntityRef, Track } from "../domain/music.ts";
import { setUiState } from "../state.ts";
import { Artwork } from "./Artwork.tsx";
import { reportActionError } from "./action-errors.ts";
import { PlaybackProgress, TransportControls } from "./TransportControls.tsx";

const FOCUSABLE =
  "button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex='-1'])";

function closeNowPlaying(): void {
  setUiState({ nowPlayingOpen: false });
}

/** Full-window Now Playing view. Mounted only while `ui.nowPlayingOpen`. */
export function NowPlaying(): JSX.Element | null {
  const state = useAppState();
  if (!state.ui.nowPlayingOpen) return null;
  return <NowPlayingDialog />;
}

function NowPlayingDialog(): JSX.Element {
  const state = useAppState();
  const controller = useAppController();
  const router = useAppRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const playback = state.playback;
  const current = playback.current;
  const playing = playback.status === "playing";
  const loading = playback.status === "loading";
  const canControl =
    state.initialization.status === "ready" && Boolean(current);

  useEffect(() => {
    // Unmounting happens on every close path, including the global Esc
    // shortcut, so focus always goes back to whatever opened the overlay.
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const run = (action: () => Promise<void>): void => {
    void action().catch(reportActionError);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeNowPlaying();
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
  const artists = current?.artistRefs ?? [];

  return (
    <div
      className="now-playing"
      role="dialog"
      aria-modal="true"
      aria-label="Now Playing"
      tabIndex={-1}
      ref={dialogRef}
      onKeyDown={onKeyDown}
    >
      <header className="now-playing-header">
        <span className="eyebrow">Now playing</span>
        <button
          ref={closeRef}
          className="icon-button"
          type="button"
          aria-label="Close Now Playing"
          onClick={closeNowPlaying}
        >
          <X aria-hidden="true" size={18} strokeWidth={1.8} />
        </button>
      </header>
      <div className="now-playing-body">
        <section className="now-playing-hero">
          <Artwork
            track={current}
            size="xl"
            alt={current ? `${current.title} artwork` : "No song playing"}
          />
          <div className="now-playing-meta">
            <h2 title={current?.title}>
              {current?.title ?? "Nothing playing"}
            </h2>
            <p className="now-playing-artists">
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
                        aria-label={`Go to artist: ${artist.name ?? `Artist ${index + 1}`}`}
                        onClick={() => navigateTo("artist", artist)}
                      >
                        {artist.name ?? current?.artistName}
                      </button>
                    </span>
                  ))
                : (current?.artistName ?? null)}
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
  return (
    <ol className="now-playing-queue" aria-label="Up Next">
      {upcoming.map(({ track, index }) => (
        <li key={`${track.id}-${index}`}>
          <button type="button" onClick={() => onPlay(index)}>
            <Artwork track={track} size="sm" alt="" />
            <span className="now-playing-queue-copy">
              <strong>{track.title}</strong>
              <small>{track.artistName}</small>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
