import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useAppController, usePlaybackPosition } from "../app/context.tsx";
import type { Track } from "../domain/music.ts";
import type { LyricLine, ParsedLyrics } from "../musickit/lyrics.ts";

interface LyricsView {
  key: string;
  lyrics?: ParsedLyrics;
}

interface TimedLine {
  index: number;
  start: number;
}

function timedLines(lines: readonly LyricLine[]): TimedLine[] {
  const timed: TimedLine[] = [];
  lines.forEach((line, index) => {
    if (line.start !== undefined) timed.push({ index, start: line.start });
  });
  return timed;
}

/** Index of the last timed line that has started by `position`, or -1. */
function activeLineIndex(
  timed: readonly TimedLine[],
  position: number,
): number {
  let low = 0;
  let high = timed.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = timed[mid];
    if (!candidate) break;
    if (candidate.start <= position) {
      found = candidate.index;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * Lyrics for the current song. Subscribes only to playback ticks, so the
 * active line moves without re-rendering the rest of the app.
 */
export function LyricsPanel({ track }: { track?: Track }): JSX.Element {
  const controller = useAppController();
  const { positionSeconds } = usePlaybackPosition();
  const listRef = useRef<HTMLDivElement>(null);
  const key = track ? (track.catalogId ?? track.id) : "";
  const [view, setView] = useState<LyricsView>();

  useEffect(() => {
    if (!track) return undefined;
    let current = true;
    const request = controller.loadLyrics?.(track);
    if (!request) {
      setView({ key });
      return undefined;
    }
    void request.then(
      (result) => {
        // A late answer for a song that is no longer playing is dropped.
        if (current) {
          setView({
            key,
            lyrics: result.status === "available" ? result.lyrics : undefined,
          });
        }
      },
      () => {
        if (current) setView({ key });
      },
    );
    return () => {
      current = false;
    };
  }, [controller, key, track?.hasLyrics]);

  const lyrics = view?.key === key ? view.lyrics : undefined;
  const loading = Boolean(track) && view?.key !== key;
  const timed = useMemo(
    () => (lyrics?.synced ? timedLines(lyrics.lines) : []),
    [lyrics],
  );
  const activeIndex = activeLineIndex(timed, positionSeconds);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-current="true"]')
      ?.scrollIntoView({ block: "center" });
  }, [activeIndex, lyrics]);

  if (loading) {
    return (
      <p className="lyrics-status" role="status">
        Loading lyrics…
      </p>
    );
  }
  if (!lyrics || lyrics.lines.length === 0) {
    return (
      <p className="lyrics-status" role="status">
        Lyrics aren&apos;t available for this song.
      </p>
    );
  }
  if (!lyrics.synced) {
    return (
      <div className="lyrics-text" ref={listRef}>
        {lyrics.lines.map((line, index) => (
          <p key={index}>{line.text}</p>
        ))}
      </div>
    );
  }
  return (
    <div className="lyrics-text" ref={listRef}>
      <ol aria-label="Lyrics">
        {lyrics.lines.map((line, index) => (
          <li
            key={index}
            className={index === activeIndex ? "is-active" : undefined}
            aria-current={index === activeIndex ? "true" : undefined}
          >
            {line.text}
          </li>
        ))}
      </ol>
    </div>
  );
}
