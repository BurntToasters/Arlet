import { AudioLines, ListMusic, MoreHorizontal, X } from "lucide-preact";
import type { JSX } from "preact";
import { useAppController, useAppState } from "../app/context.tsx";
import { Artwork } from "./Artwork.tsx";
import { requestContextMenu } from "./context-menu-events.ts";
import { IconButton } from "./IconButton.tsx";

export function QueueDrawer(): JSX.Element | null {
  const state = useAppState();
  const controller = useAppController();
  if (!state.ui.queueOpen) return null;
  const queue = state.playback.queue;

  const playQueueItem = (index: number): void => {
    if (!queue[index]) return;
    void controller.playQueueItem(index).catch(() => undefined);
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
        <ol className="queue-list" aria-label="Queued songs">
          {queue.map((track, index) => {
            const active = index === state.playback.queueIndex;
            return (
              <li key={`${track.id}-${index}`}>
                <div
                  className={`queue-row-shell ${active ? "is-active" : ""}`.trim()}
                  data-context-kind="track"
                  data-context-id={track.id}
                  data-context-title={track.title}
                  data-context-artist={track.artistName}
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
                >
                  <button
                    className={`queue-row ${active ? "is-active" : ""}`.trim()}
                    type="button"
                    aria-label={`${active ? "Playing" : "Play"} ${track.title} by ${track.artistName}`}
                    aria-current={active ? "true" : undefined}
                    onClick={() => playQueueItem(index)}
                  >
                    <span className="queue-index" aria-hidden="true">
                      {active ? (
                        <AudioLines aria-hidden="true" size={14} />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <Artwork track={track} size="sm" alt="" />
                    <span className="queue-copy">
                      <strong title={track.title}>{track.title}</strong>
                      <small title={track.artistName}>{track.artistName}</small>
                    </span>
                    {active ? (
                      <span className="now-playing-label">Playing</span>
                    ) : null}
                  </button>
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
                      if (target)
                        requestContextMenu(target, event.currentTarget);
                    }}
                  >
                    <MoreHorizontal aria-hidden="true" size={17} />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
