import {
  AudioLines,
  ChevronDown,
  ChevronUp,
  Infinity as InfinityIcon,
  ListMusic,
  ListPlus,
  ListX,
  MoreHorizontal,
  X,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  useAppController,
  useAppSelector,
  useAppSlices,
} from "../app/context.tsx";
import type { Track } from "../domain/music.ts";
import { upcomingUserCount } from "../app/queue-window.ts";
import { getState, setUiState } from "../state.ts";
import { Artwork } from "./Artwork.tsx";
import { reportActionError, reportQueueEdit } from "./action-errors.ts";
import { serializeContextRefs } from "./context-refs.ts";
import { requestContextMenu } from "./context-menu-events.ts";
import { IconButton } from "./IconButton.tsx";
import { requestPlaylistDialog } from "./playlist-events.ts";
import { VirtualList } from "./VirtualList.tsx";

// Matches the slide in 07-queue.css.
const SLIDE_MS = 180;

type DrawerPhase = "closed" | "open" | "closing";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Whether Escape closes the drawer: focus is inside it, or nothing else is
 * open above it. Text fields keep Escape for themselves.
 */
function escapeClosesQueue(drawer: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (drawer?.contains(active)) return true;
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLSelectElement ||
    (active instanceof HTMLElement && active.isContentEditable)
  ) {
    return false;
  }
  const ui = getState().ui;
  if (ui.nowPlayingOpen || ui.diagnosticsOpen || ui.sidebarOpen) return false;
  return !document.querySelector(
    '[role="dialog"], [role="menu"], dialog[open]',
  );
}

/** A queue song with its real queue position, which edits and playback use. */
interface QueueEntry {
  track: Track;
  index: number;
}

/** Context-menu data for a track row. Callers add the queue index when editable. */
function trackContextAttributes(track: Track): Record<string, string> {
  return {
    "data-context-kind": "track",
    "data-context-id": track.id,
    "data-context-title": track.title,
    "data-context-artist": track.artistName,
    ...(track.albumRef
      ? { "data-context-album-ref": serializeContextRefs(track.albumRef) }
      : {}),
    ...(track.artistRefs?.length
      ? {
          "data-context-artist-refs": serializeContextRefs(track.artistRefs),
        }
      : {}),
    ...(track.albumTitle ? { "data-context-album": track.albumTitle } : {}),
    ...(track.artwork?.url
      ? { "data-context-artwork": track.artwork.url }
      : {}),
    ...(track.resourceType
      ? { "data-context-resource-type": track.resourceType }
      : {}),
    ...(track.catalogId ? { "data-context-catalog-id": track.catalogId } : {}),
    ...(track.catalogUrl
      ? { "data-context-catalog-url": track.catalogUrl }
      : {}),
  };
}

/** The More actions button, shared by user and autoplay rows. */
function moreAction(track: Track): JSX.Element {
  return (
    <button
      className="queue-row-more"
      type="button"
      aria-label={`More actions for ${track.title} by ${track.artistName}`}
      title="More actions"
      aria-haspopup="menu"
      onClick={(event) => {
        const target = event.currentTarget.closest<HTMLElement>(
          "[data-context-kind], [data-context-track-id]",
        );
        if (target) requestContextMenu(target, event.currentTarget);
      }}
    >
      <MoreHorizontal aria-hidden="true" size={17} />
    </button>
  );
}

export function QueueDrawer(): JSX.Element | null {
  const state = useAppSlices("playback", "settings");
  const controller = useAppController();
  const queueOpen = useAppSelector((store) => store.ui.queueOpen);
  // Index of the upcoming row being dragged; only same-drawer drags count.
  const dragFrom = useRef<number | undefined>(undefined);
  // The drawer stays mounted while it slides out.
  const [phase, setPhase] = useState<DrawerPhase>(
    queueOpen ? "open" : "closed",
  );
  const drawerRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The control that had focus when the drawer opened; focus returns to it.
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(queueOpen);

  useEffect(() => {
    if (queueOpen === wasOpen.current) return;
    wasOpen.current = queueOpen;
    if (queueOpen) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement ? active : null;
      setPhase("open");
      headingRef.current?.focus({ preventScroll: true });
      return;
    }
    const opener = openerRef.current;
    const active = document.activeElement;
    // Focus left where the user put it unless it was in the drawer or lost.
    if (
      opener?.isConnected &&
      (!active ||
        active === document.body ||
        drawerRef.current?.contains(active))
    ) {
      opener.focus({ preventScroll: true });
    }
    setPhase("closing");
  }, [queueOpen]);

  useEffect(() => {
    if (phase !== "closing") return undefined;
    const timer = window.setTimeout(
      () => setPhase("closed"),
      prefersReducedMotion() ? 0 : SLIDE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (!queueOpen) return undefined;
    // Capture phase, so this runs before Now Playing's own Escape shortcut
    // could close Now Playing and leave the drawer looking topmost.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      if (!escapeClosesQueue(drawerRef.current)) return;
      event.preventDefault();
      setUiState({ queueOpen: false });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [queueOpen]);

  if (!queueOpen && phase === "closed") return null;
  const closing = !queueOpen;
  const queue = state.playback.queue;
  const current = state.playback.queueIndex;
  // Clear removes only the user's upcoming songs; autoplay songs stay.
  const upcomingCount = upcomingUserCount(queue, current);
  const restCount = state.playback.queueRest ?? 0;
  // A station's queue cannot be edited, so its upcoming rows offer no edits.
  const stationPlaying = state.playback.stationPlaying === true;

  const settings = state.settings;
  // Upcoming autoplay songs leave the user's list for their own section, unless
  // that section is hidden, so no song disappears from the drawer.
  const autoplayEntries: QueueEntry[] = [];
  queue.forEach((track, index) => {
    if (index > current && track.autoplay)
      autoplayEntries.push({ track, index });
  });
  const showAutoplay =
    state.playback.autoplayStation !== false && autoplayEntries.length > 0;
  // With Autoplay off the section stays, empty, so its toggle can turn
  // Autoplay back on. A station has no autoplay songs.
  const showAutoplayOff =
    !settings.autoplay &&
    !stationPlaying &&
    queue.length > 0 &&
    state.playback.modeCapabilities?.autoplay === true;
  const listEntries: QueueEntry[] = queue.flatMap((track, index) =>
    showAutoplay && index > current && track.autoplay ? [] : [{ track, index }],
  );
  const repeating = (state.playback.repeatMode ?? "off") !== "off";
  const toggleAutoplay = (): void => {
    void controller.setAutoplay(!settings.autoplay).catch(reportActionError);
  };

  const playQueueItem = (index: number): void => {
    if (!queue[index]) return;
    void controller.playQueueItem(index).catch(reportActionError);
  };

  const moveTo = (from: number, to: number): void => {
    reportQueueEdit(controller.moveQueueItem(from, to, queue[from]?.id));
  };

  const renderRow = ({ track, index }: QueueEntry): JSX.Element => {
    const active = index === current;
    const upcoming = index > current;
    const editable = upcoming && !stationPlaying;
    return (
      <li
        onDragOver={(event) => {
          if (!editable || dragFrom.current === undefined) return;
          event.preventDefault();
        }}
        onDrop={(event) => {
          const from = dragFrom.current;
          dragFrom.current = undefined;
          if (from === undefined || !editable || from === index) return;
          event.preventDefault();
          moveTo(from, index);
        }}
      >
        <div
          className={`queue-row-shell ${active ? "is-active" : ""}`.trim()}
          {...trackContextAttributes(track)}
          {...(editable ? { "data-context-queue-index": String(index) } : {})}
          draggable={editable}
          onDragStart={(event) => {
            if (!editable) return;
            dragFrom.current = index;
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", String(index));
            }
          }}
          onDragEnd={() => {
            dragFrom.current = undefined;
          }}
        >
          <button
            className={`queue-row ${active ? "is-active" : ""}`.trim()}
            type="button"
            aria-label={`${active ? "Playing" : "Play"} ${track.title} by ${track.artistName}`}
            aria-current={active ? "true" : undefined}
            onClick={() => playQueueItem(index)}
          >
            <span className="queue-index" aria-hidden="true">
              {active ? <AudioLines aria-hidden="true" size={14} /> : index + 1}
            </span>
            <Artwork track={track} size="sm" alt="" />
            <span className="queue-copy">
              <strong title={track.title}>{track.title}</strong>
              <small title={track.artistName}>{track.artistName}</small>
            </span>
            {active ? <span className="now-playing-label">Playing</span> : null}
          </button>
          <div className="queue-row-tools">
            {editable ? (
              <>
                <button
                  className="queue-row-action"
                  type="button"
                  data-queue-action="up"
                  aria-label={`Move ${track.title} up`}
                  title="Move up"
                  disabled={index === current + 1}
                  onClick={() => moveTo(index, index - 1)}
                >
                  <ChevronUp aria-hidden="true" size={15} />
                </button>
                <button
                  className="queue-row-action"
                  type="button"
                  data-queue-action="down"
                  aria-label={`Move ${track.title} down`}
                  title="Move down"
                  disabled={index === queue.length - 1}
                  onClick={() => moveTo(index, index + 1)}
                >
                  <ChevronDown aria-hidden="true" size={15} />
                </button>
                <button
                  className="queue-row-action"
                  type="button"
                  data-queue-action="remove"
                  aria-label={`Remove ${track.title} from queue`}
                  title="Remove from queue"
                  onClick={() =>
                    reportQueueEdit(controller.removeQueueItem(index, track.id))
                  }
                >
                  <X aria-hidden="true" size={15} />
                </button>
              </>
            ) : null}
            {moreAction(track)}
          </div>
        </div>
      </li>
    );
  };

  // Autoplay rows play on click; they have no edit controls and no drag.
  const renderAutoplayRow = ({ track, index }: QueueEntry): JSX.Element => (
    <li key={`${track.id}-${index}`}>
      <div className="queue-row-shell" {...trackContextAttributes(track)}>
        <button
          className="queue-row"
          type="button"
          aria-label={`Play ${track.title} by ${track.artistName}`}
          onClick={() => playQueueItem(index)}
        >
          <span className="queue-index" aria-hidden="true">
            {index + 1}
          </span>
          <Artwork track={track} size="sm" alt="" />
          <span className="queue-copy">
            <strong title={track.title}>{track.title}</strong>
            <small title={track.artistName}>{track.artistName}</small>
          </span>
        </button>
        <div className="queue-row-tools">{moreAction(track)}</div>
      </div>
    </li>
  );

  return (
    <aside
      ref={drawerRef}
      className="queue-drawer"
      aria-label="Playing Next"
      aria-hidden={closing || undefined}
      data-state={closing ? "closing" : "open"}
    >
      <div className="queue-header">
        <div>
          <span className="eyebrow">Up next</span>
          <h2 ref={headingRef} tabIndex={-1}>
            Playing Next
          </h2>
        </div>
        <IconButton
          icon={X}
          label="Close Playing Next"
          onClick={controller.toggleQueue}
        />
      </div>
      {queue.length === 0 ? (
        <div className="queue-empty empty-state compact">
          <span className="empty-icon">
            <ListMusic aria-hidden="true" size={22} strokeWidth={1.8} />
          </span>
          <strong>Your queue is empty</strong>
          <p>
            Play anything — a song, playlist, or album — and the rest of the
            queue will appear here.
          </p>
        </div>
      ) : (
        <>
          <div className="queue-toolbar">
            <button
              type="button"
              onClick={(event) =>
                requestPlaylistDialog(
                  "create",
                  // The whole playlist, including songs still to be added.
                  controller.fullQueue() ?? queue,
                  event.currentTarget,
                )
              }
            >
              <ListPlus aria-hidden="true" size={15} />
              Save as playlist
            </button>
            {stationPlaying ? null : (
              <button
                type="button"
                aria-label="Clear up next"
                disabled={upcomingCount === 0}
                onClick={() => reportQueueEdit(controller.clearUpNext())}
              >
                <ListX aria-hidden="true" size={15} />
                Clear
              </button>
            )}
          </div>
          <div className="queue-scroll">
            <VirtualList
              items={listEntries}
              getKey={({ track, index }) => `${track.id}-${index}`}
              renderRow={renderRow}
              className="queue-list"
              aria-label="Queued songs"
              scrollParentSelector=".queue-scroll"
              revealIndex={current}
            />
            {restCount > 0 ? (
              <p className="queue-rest-note">
                {restCount === 1
                  ? "1 more song is added as the queue plays."
                  : `${restCount.toLocaleString()} more songs are added as the queue plays.`}
              </p>
            ) : null}
            {showAutoplay || showAutoplayOff ? (
              <section
                className="queue-autoplay"
                aria-labelledby="queue-autoplay-heading"
              >
                <div className="queue-autoplay-head">
                  <h3 id="queue-autoplay-heading">Autoplay</h3>
                  <button
                    className={`queue-autoplay-toggle ${settings.autoplay ? "is-active" : ""}`.trim()}
                    type="button"
                    aria-label="Autoplay"
                    aria-pressed={settings.autoplay}
                    disabled={repeating}
                    title={
                      repeating
                        ? "Turn off Repeat to use Autoplay"
                        : settings.autoplay
                          ? "Turn off Autoplay"
                          : "Turn on Autoplay"
                    }
                    onClick={toggleAutoplay}
                  >
                    <InfinityIcon aria-hidden="true" size={16} />
                  </button>
                </div>
                {showAutoplay ? (
                  <ol
                    className="queue-autoplay-list"
                    aria-label="Autoplay songs"
                  >
                    {autoplayEntries.map(renderAutoplayRow)}
                  </ol>
                ) : null}
              </section>
            ) : null}
          </div>
        </>
      )}
    </aside>
  );
}
