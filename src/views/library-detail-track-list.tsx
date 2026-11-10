import { useMemo } from "preact/hooks";
import type { JSX } from "preact";
import { SelectionBar } from "../components/SelectionBar.tsx";
import { useTrackSelection } from "../components/track-selection.ts";
import { VirtualList } from "../components/VirtualList.tsx";
import type { Track } from "../domain/music.ts";
import { LibraryTrackRow, toTrack, type ResourceLike } from "./LibraryView.tsx";
import { discNumberOf, groupByDisc, type DiscGroup } from "./detail-meta.ts";
import type { DetailSource } from "./library-detail-helpers.ts";

export function TrackList({
  resources,
  canPlay,
  onPlay,
  parentKind,
  parentId,
  parentSource,
}: {
  resources: ResourceLike[];
  canPlay: boolean;
  onPlay: (track: Track, index: number) => void;
  parentKind: "album" | "playlist";
  parentId: string;
  parentSource: DetailSource;
}): JSX.Element {
  // Each disc is its own list, so headings sit outside the virtualized rows
  // and row-height spacers stay exact. Rows keep the album-wide index for Play.
  const groups = useMemo(
    () =>
      groupByDisc(resources, parentKind === "album" ? discNumberOf : () => 1),
    [resources, parentKind],
  );
  // Selection spans every disc, in the album's track order.
  const loadedTracks = useMemo(
    () => resources.map(toTrack).filter((item): item is Track => Boolean(item)),
    [resources],
  );
  const selection = useTrackSelection(
    loadedTracks,
    `${parentKind}:${parentId}`,
  );
  // Several discs show each track's position on its disc; play still uses the
  // album-wide index.
  const multiDisc = groups.length > 1;
  const renderRows = (rows: DiscGroup<ResourceLike>["items"]): JSX.Element => (
    <VirtualList
      className="library-track-list"
      items={rows}
      getKey={({ item, index }) =>
        `${item.type ?? "track"}:${item.id}:${index}`
      }
      renderRow={({ item, index }) => (
        <LibraryTrackRow
          resource={item}
          index={index}
          onPlay={onPlay}
          disabled={!canPlay}
          discTrackNumbers={multiDisc}
          contextData={{
            "data-context-parent-kind": parentKind,
            "data-context-parent-id": parentId,
            "data-context-parent-source": parentSource,
            "data-context-parent-index": String(index),
          }}
          selected={selection.isSelected(item.id)}
          onSelect={selection.handleClick}
        />
      )}
    />
  );
  if (groups.length < 2) {
    return (
      <>
        <section
          className="library-list-panel"
          aria-label="Tracks"
          ref={selection.setPanel}
          onKeyDown={selection.onKeyDown}
        >
          {renderRows(groups[0]?.items ?? [])}
        </section>
        <SelectionBar tracks={selection.tracks} onClear={selection.clear} />
      </>
    );
  }
  return (
    <>
      <div
        className="library-disc-groups"
        ref={selection.setPanel}
        onKeyDown={selection.onKeyDown}
      >
        {groups.map((group) => (
          <section
            key={group.disc}
            className="library-disc"
            aria-labelledby={`library-disc-${group.disc}`}
          >
            <h2
              id={`library-disc-${group.disc}`}
              className="library-disc-heading"
            >
              Disc {group.disc}
            </h2>
            <div className="library-list-panel">{renderRows(group.items)}</div>
          </section>
        ))}
      </div>
      <SelectionBar tracks={selection.tracks} onClear={selection.clear} />
    </>
  );
}
