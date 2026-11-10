import { Disc3, ListMusic, UserRound } from "lucide-preact";
import type { JSX } from "preact";
import { useAppController, useAppRouter } from "../app/context.tsx";
import { Artwork } from "../components/Artwork.tsx";
import { SongRow } from "../components/SongRow.tsx";
import { CardActions, CardShell } from "../components/CardActions.tsx";
import { reportActionError } from "../components/action-errors.ts";
import type { Album, Artist, Playlist, Track } from "../domain/music.ts";
import { itemTrack, trackContextData } from "./search-view-model.ts";

export function TrackRow({
  track,
  index,
  onPlay,
  onPlayNext,
  disabled,
}: {
  track: Track;
  index: number;
  onPlay: () => void;
  onPlayNext?: () => void;
  disabled: boolean;
}): JSX.Element {
  return (
    <SongRow
      track={track}
      index={index}
      onPlay={onPlay}
      onPlayNext={onPlayNext}
      disabled={disabled}
      rowClassName="search-row"
      numberClassName="search-row-number"
      copyClassName="search-row-copy"
      durationClassName="search-row-duration"
      contextData={trackContextData(track)}
    />
  );
}

export function ResourceCard({
  item,
  kind,
  source,
  canPlay,
}: {
  item: Album | Artist | Playlist;
  kind: "album" | "artist" | "playlist";
  source: "catalog" | "library";
  canPlay: boolean;
}): JSX.Element {
  const router = useAppRouter();
  const controller = useAppController();
  const track = itemTrack(item);
  const title = track.title;
  const Icon =
    kind === "artist" ? UserRound : kind === "album" ? Disc3 : ListMusic;
  // Artists have no collection playback, so only albums and playlists get Play.
  const collectionKind = kind === "artist" ? undefined : kind;
  const playable = !("playable" in item && item.playable === false);
  return (
    <CardShell
      contextData={{
        "data-context-kind": kind,
        "data-context-id": item.id,
        "data-context-title": title,
        "data-context-route-kind": kind,
        "data-context-source": source,
      }}
      catalogUrl={item.catalogUrl}
    >
      <button
        className="home-discovery-card"
        type="button"
        onClick={() => router.navigate({ kind, id: item.id, source })}
      >
        <Artwork
          track={track}
          size="lg"
          alt={`${title} artwork`}
          className="home-discovery-art"
        />
        {track.artwork ? null : <Icon aria-hidden="true" />}
        <span className="home-discovery-copy">
          <strong title={title}>{title}</strong>
          <small>{track.artistName}</small>
        </span>
        <span className="home-discovery-source">
          {source === "library" ? "Library" : "Apple Music"}
        </span>
      </button>
      <CardActions
        title={title}
        onPlay={
          collectionKind && playable && canPlay
            ? () =>
                void Promise.resolve(
                  controller.playCollection(collectionKind, item.id, source, 0),
                ).catch(reportActionError)
            : undefined
        }
      />
    </CardShell>
  );
}
