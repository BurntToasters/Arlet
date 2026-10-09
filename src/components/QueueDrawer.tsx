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
import { useRef } from "preact/hooks";
import { useAppController, useAppState } from "../app/context.tsx";
import type { Track } from "../domain/music.ts";
import { Artwork } from "./Artwork.tsx";
import { reportActionError, reportQueueEdit } from "./action-errors.ts";
import { requestContextMenu } from "./context-menu-events.ts";
import { IconButton } from "./IconButton.tsx";
import { requestPlaylistDialog } from "./playlist-events.ts";
import { VirtualList } from "./VirtualList.tsx";

export function QueueDrawer(): JSX.Element | null {
  const state = useAppState();
  const controller = useAppController();
  // Index of the upcoming row being dragged; only same-drawer drags count.
  const dragFrom = useRef<number | undefined>(undefined);
  if (!state.ui.queueOpen) return null;
  const queue = state.playback.queue;
  const current = state.playback.queueIndex;
  const upcomingCount = Math.max(0, queue.length - current - 1);
  const restCount = state.playback.queueRest ?? 0;

  const playQueueItem = (index: number): void => {
    if (!queue[index]) return;
    void controller.playQueueItem(index).catch(reportActionError);
  };

  const moveTo = (from: number, to: number): void => {
    reportQueueEdit(controller.moveQueueItem(from, to));
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
                "data-context-album-ref": JSON.stringify(track.albumRef),
              }
            : {})}
          {...(track.artistRefs?.length
            ? {
                "data-context-artist-refs": JSON.stringify(track.artistRefs),
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
                    reportQueueEdit(controller.removeQueueItem(index))
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
    <aside className="queue-drawer" aria-label="Playing Next">
      <div className="queue-header">
        <div>
          <span className="eyebrow">Up next</span>
          <h2>Playing Next</h2>
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
                requestPlaylistDialog("create", queue, event.currentTarget)
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
