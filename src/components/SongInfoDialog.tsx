import { LoaderCircle, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useAppController, useAppSlices } from "../app/context.tsx";
import type { SongInfo, Track } from "../domain/music.ts";

export const SONG_INFO_REQUEST = "arlet:song-info";

interface SongInfoRequestDetail {
  track: Track;
  restoreFocus?: HTMLElement;
}

/** Opens Get Info for a song. The dialog mounts once in App.tsx. */
export function requestSongInfo(
  track: Track,
  restoreFocus?: HTMLElement,
): void {
  window.dispatchEvent(
    new CustomEvent<SongInfoRequestDetail>(SONG_INFO_REQUEST, {
      detail: { track, restoreFocus },
    }),
  );
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface InfoField {
  label: string;
  value: string;
}

function formatDuration(durationMs: number | undefined): string | undefined {
  if (!durationMs || durationMs <= 0) return undefined;
  const total = Math.floor(durationMs / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

function discAndTrack(info: SongInfo): string | undefined {
  const parts: string[] = [];
  if (info.discNumber) parts.push(`Disc ${info.discNumber}`);
  if (info.trackNumber) parts.push(`Track ${info.trackNumber}`);
  return parts.length ? parts.join(", ") : undefined;
}

function ratingLabel(rating: SongInfo["contentRating"]): string | undefined {
  if (rating === "explicit") return "Explicit";
  if (rating === "clean") return "Clean";
  return undefined;
}

/** Only the fields Apple returned, in display order. Every value is plain text. */
function fieldsOf(info: SongInfo): InfoField[] {
  const candidates: [string, string | undefined][] = [
    ["Composer", info.composerName],
    ["Genre", info.genreNames.join(", ") || undefined],
    ["Release date", info.releaseDate],
    ["Disc and track", discAndTrack(info)],
    ["Duration", formatDuration(info.durationMs)],
    ["Content rating", ratingLabel(info.contentRating)],
    ["ISRC", info.isrc],
    ["Label", info.recordLabel],
    ["Copyright", info.copyright],
  ];
  return candidates
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) => ({ label, value }));
}

export function SongInfoDialog(): JSX.Element | null {
  const controller = useAppController();
  const state = useAppSlices("songInfo");
  const [request, setRequest] = useState<SongInfoRequestDetail | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // The effect that registers the listener runs once; this keeps it on the
  // latest close, which reads the open request's focus target.
  const closeRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const onRequest = (event: Event): void => {
      const detail = (event as CustomEvent<SongInfoRequestDetail>).detail;
      if (!detail?.track) return;
      setRequest(detail);
    };
    window.addEventListener(SONG_INFO_REQUEST, onRequest);
    return () => window.removeEventListener(SONG_INFO_REQUEST, onRequest);
  }, []);

  // Each open asks for the song again. Failures are kept in the slice, so the
  // dialog shows them and the rejection is not raised here.
  useEffect(() => {
    if (!request) return;
    void controller.loadSongInfo(request.track).catch(() => undefined);
  }, [controller, request]);

  const open = request !== null;

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    // Capture phase, so Escape closes this dialog before App.tsx's window
    // listener can also close Now Playing underneath it.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const outside = !dialog.contains(active);
      if (
        (event.shiftKey && (active === first || outside)) ||
        (!event.shiftKey && (active === last || outside))
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previousFocus?.focus?.();
    };
  }, [open]);

  if (!request) return null;

  const close = (): void => {
    const focusTarget = request.restoreFocus;
    setRequest(null);
    if (focusTarget) window.setTimeout(() => focusTarget.focus(), 0);
  };
  closeRef.current = close;

  const track = request.track;
  // The slice is shared, so it only counts when it belongs to this song.
  // Anything else, including a previous song's answer, reads as loading.
  const current = state.songInfo.id === track.id ? state.songInfo : undefined;
  const info = current?.status === "success" ? current.info : undefined;
  const fields = info ? fieldsOf(info) : [];
  const failed = current?.status === "error";

  return (
    <div
      className="playlist-dialog-backdrop song-info-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        className="playlist-dialog song-info-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Song info"
        // A click on dialog text focuses the section, not the page behind it.
        tabIndex={-1}
      >
        <header className="playlist-dialog-header">
          <div className="song-info-heading">
            <span className="eyebrow">Get Info</span>
            <h2>{track.title}</h2>
            {track.artistName ? <p>{track.artistName}</p> : null}
          </div>
          <button
            ref={closeButton}
            className="icon-button"
            type="button"
            aria-label="Close song info"
            onClick={close}
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>
        {failed ? (
          <p className="playlist-dialog-error" role="alert">
            {current?.error ?? "Song info could not be loaded."}
          </p>
        ) : !info ? (
          <p className="song-info-status" role="status">
            <LoaderCircle className="spin" aria-hidden="true" size={16} />{" "}
            Loading song info…
          </p>
        ) : fields.length ? (
          <dl className="song-info-list">
            {fields.map((field) => (
              <div className="song-info-row" key={field.label}>
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="song-info-status">
            Apple Music has no other details for this song.
          </p>
        )}
      </section>
    </div>
  );
}
