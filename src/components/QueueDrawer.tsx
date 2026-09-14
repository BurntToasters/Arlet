import { ListMusic, X } from "lucide-preact";
import type { JSX } from "preact";
import { useAppController, useAppState } from "../app/context.tsx";
import { Artwork } from "./Artwork.tsx";
import { IconButton } from "./IconButton.tsx";

export function QueueDrawer(): JSX.Element | null {
  const state = useAppState();
  const controller = useAppController();
  if (!state.ui.queueOpen) return null;
  const queue = state.playback.queue;

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
            Start a song from Search and the rest of its results will appear
            here.
          </p>
        </div>
      ) : (
        <ol className="queue-list" aria-label="Queued songs">
          {queue.map((track, index) => {
            const active = index === state.playback.queueIndex;
            return (
              <li
                className={`queue-row ${active ? "is-active" : ""}`.trim()}
                key={`${track.id}-${index}`}
              >
                <span className="queue-index" aria-hidden="true">
                  {active ? "♫" : index + 1}
                </span>
                <Artwork track={track} size="sm" alt="" />
                <span className="queue-copy">
                  <strong title={track.title}>{track.title}</strong>
                  <small title={track.artistName}>{track.artistName}</small>
                </span>
                {active ? (
                  <span className="now-playing-label">Playing</span>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
