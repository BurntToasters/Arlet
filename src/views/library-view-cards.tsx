import { Album as AlbumIcon, ListMusic, UserRound } from "lucide-preact";
import type { JSX } from "preact";
import { useAppController } from "../app/context.tsx";
import { Artwork } from "../components/Artwork.tsx";
import { CardActions, CardShell } from "../components/CardActions.tsx";
import {
  canEditOf,
  editInAppleMusicAttribute,
} from "../components/context-target.ts";
import { SongRow } from "../components/SongRow.tsx";
import type { Track } from "../domain/music.ts";
import { resourceSource } from "./detail-context.ts";
import { toTrack, type ResourceLike } from "./library-view-convert.ts";
import { act, contextData } from "./library-view-shared.ts";

export function LibraryTrackRow({
  resource,
  index,
  onPlay,
  onPlayNext,
  disabled,
  contextData: collectionContext,
  discTrackNumbers,
  selected,
  onSelect,
}: {
  resource: ResourceLike;
  index: number;
  onPlay: (track: Track, index: number) => void;
  onPlayNext?: (track: Track) => void;
  disabled: boolean;
  contextData?: Record<string, string>;
  /** Shows the track's position on its disc; see SongRow. */
  discTrackNumbers?: boolean;
  /** Multi-select; see SongRow. */
  selected?: boolean;
  onSelect?: (event: MouseEvent, track: Track) => boolean;
}): JSX.Element {
  const appController = useAppController();
  const track = toTrack(resource);
  if (!track) return <li />;
  const playNext =
    onPlayNext ??
    ((value: Track) => {
      act(() => appController.playNextTracks([value]));
    });
  return (
    <SongRow
      track={track}
      index={index}
      onPlay={() => onPlay(track, index)}
      onPlayNext={() => playNext(track)}
      disabled={disabled}
      rowClassName="library-track-row"
      numberClassName="library-row-number"
      copyClassName="library-row-copy"
      durationClassName="library-row-duration"
      contextData={{ ...contextData(resource, "track"), ...collectionContext }}
      discTrackNumbers={discTrackNumbers}
      selected={selected}
      onSelect={onSelect ? (event) => onSelect(event, track) : undefined}
    />
  );
}

export function ResourceCard({
  resource,
  kind,
  onOpen,
  editInAppleMusic = false,
}: {
  resource: ResourceLike;
  kind: "album" | "artist" | "playlist";
  onOpen: () => void;
  /** Opt-in for the playlist area; adds "Edit in Apple Music" to editable library playlists. */
  editInAppleMusic?: boolean;
}): JSX.Element {
  const appController = useAppController();
  const Icon =
    kind === "album" ? AlbumIcon : kind === "artist" ? UserRound : ListMusic;
  const trackLike = toTrack(resource);
  // Artists have no collection playback, so only albums and playlists get Play.
  const collectionKind = kind === "artist" ? undefined : kind;
  return (
    <CardShell
      contextData={{
        ...contextData(resource, kind),
        ...(kind === "playlist" && editInAppleMusic
          ? editInAppleMusicAttribute(
              resourceSource(resource),
              canEditOf(resource.raw),
            )
          : {}),
      }}
      catalogUrl={resource.catalogUrl}
    >
      <button className="library-card" type="button" onClick={onOpen}>
        {kind === "artist" && !resource.artwork ? (
          <span
            className="library-card-art library-card-art-icon"
            aria-hidden="true"
          >
            <Icon size={27} strokeWidth={1.5} />
          </span>
        ) : (
          <Artwork
            track={trackLike}
            size="lg"
            alt={`${resource.title} artwork`}
            className="library-card-art"
          />
        )}
        <span className="library-card-copy">
          <strong title={resource.title}>{resource.title}</strong>
          <small title={resource.artistName}>
            {resource.artistName ?? kind}
          </small>
        </span>
      </button>
      <CardActions
        title={resource.title}
        onPlay={
          collectionKind && resource.playable !== false
            ? () =>
                act(() =>
                  appController.playCollection(
                    collectionKind,
                    resource.id,
                    "library",
                    0,
                  ),
                )
            : undefined
        }
      />
    </CardShell>
  );
}
