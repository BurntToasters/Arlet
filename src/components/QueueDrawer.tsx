import {
  AudioLines,
  ChevronDown,
  ChevronUp,
  ListMusic,
  ListPlus,
  ListX,
  MoreHorizontal,
  X,
} from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useAppController, useAppSlices } from "../app/context.tsx";
import type { Track } from "../domain/music.ts";
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

export function QueueDrawer(): JSX.Element | null {
  const state = useAppSlices("playback", "ui");
  const controller = useAppController();
  const queueOpen = state.ui.queueOpen;
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
  const upcomingCount = Math.max(0, queue.length - current - 1);
  const restCount = state.playback.queueRest ?? 0;

  const playQueueItem = (index: number): void => {
    if (!queue[index]) return;
    void controller.playQueueItem(index).catch(reportActionError);
  };

  const moveTo = (from: number, to: number): void => {
    reportQueueEdit(controller.moveQueueItem(from, to, queue[from]?.id));
  };

  const renderRow = (track: Track, index: number): JSX.Element => {
    const active = index === current;
    const upcoming = index > current;
    return (
      <li
        onDragOver={(event) => {
          if (!upcoming || dragFrom.current === undefined) return;
          event.preventDefault();
        }}
        onDrop={(event) => {
          const from = dragFrom.current;
          dragFrom.current = undefined;
          if (from === undefined || !upcoming || from === index) return;
          event.preventDefault();
          moveTo(from, index);
        }}
      >
        <div
          className={`queue-row-shell ${active ? "is-active" : ""}`.trim()}
          data-context-kind="track"
          data-context-id={track.id}
          data-context-title={track.title}
          data-context-artist={track.artistName}
          {...(upcoming ? { "data-context-queue-index": String(index) } : {})}
          {...(track.albumRef
            ? {
                "data-context-album-ref": serializeContextRefs(track.albumRef),
              }
            : {})}
          {...(track.artistRefs?.length
            ? {
                "data-context-artist-refs": serializeContextRefs(
                  track.artistRefs,
                ),
              }
            : {})}
          {...(track.albumTitle
            ? { "data-context-album": track.albumTitle }
            : {})}
          {...(track.artwork?.url
            ? { "data-context-artwork": track.artwork.url }
            : {})}
          {...(track.resourceType
            ? { "data-context-resource-type": track.resourceType }
            : {})}
          {...(track.catalogId
            ? { "data-context-catalog-id": track.catalogId }
            : {})}
          {...(track.catalogUrl
            ? { "data-context-catalog-url": track.catalogUrl }
            : {})}
          draggable={upcoming}
          onDragStart={(event) => {
            if (!upcoming) return;
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
            {upcoming ? (
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
          </div>
        </div>
      </li>
    );
  };

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
                  controller.fullQueue?.() ?? queue,
                  event.currentTarget,
                )
              }
            >
              <ListPlus aria-hidden="true" size={15} />
              Save as playlist
            </button>
            <button
              type="button"
              aria-label="Clear up next"
              disabled={upcomingCount === 0}
              onClick={() => reportQueueEdit(controller.clearUpNext())}
            >
              <ListX aria-hidden="true" size={15} />
              Clear
            </button>
          </div>
          <div className="queue-scroll">
            <VirtualList
              items={queue}
              getKey={(track, index) => `${track.id}-${index}`}
              renderRow={renderRow}
              className="queue-list"
              aria-label="Queued songs"
              scrollParentSelector=".queue-scroll"
            />
            {restCount > 0 ? (
              <p className="queue-rest-note">
                {restCount === 1
                  ? "1 more song is added as the queue plays."
                  : `${restCount.toLocaleString()} more songs are added as the queue plays.`}
              </p>
            ) : null}
          </div>
        </>
      )}
    </aside>
  );
}
