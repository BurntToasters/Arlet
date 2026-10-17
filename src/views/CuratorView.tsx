import {
  AlertCircle,
  ChevronDown,
  ListMusic,
  LoaderCircle,
  UserRound,
} from "lucide-preact";
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  useAppController,
  useAppRouter,
  useAppSlices,
} from "../app/context.tsx";
import { safeErrorMessage } from "../app/controller-support.ts";
import { reportActionError } from "../components/action-errors.ts";
import { Artwork } from "../components/Artwork.tsx";
import { CardActions, CardShell } from "../components/CardActions.tsx";
import { SkeletonCardGrid, SkeletonStatus } from "../components/Skeleton.tsx";
import type { Playlist } from "../domain/music.ts";
import type { CuratorPage } from "../musickit/curators.ts";
import type { CuratorKind } from "../routing/router.ts";
import { EmptyState } from "./EmptyState.tsx";

type CuratorLoad =
  { status: "error"; message: string } | { status: "ready"; page: CuratorPage };

/** Playlists read past the first page, with the state of the next request. */
interface MoreState {
  key: string;
  playlists: Playlist[];
  /** The path of the next page, or undefined once Apple has no more. */
  next?: string;
  busy: boolean;
  error?: string;
}

function playlistContextData(playlist: Playlist): Record<string, string> {
  return {
    "data-context-kind": "playlist",
    "data-context-id": playlist.id,
    "data-context-title": playlist.name,
    "data-context-route-kind": "playlist",
    "data-context-source": "catalog",
  };
}

/** Card for a playlist; opens its page and offers Play and "...". */
function CuratorPlaylistCard({
  playlist,
}: {
  playlist: Playlist;
}): JSX.Element {
  const router = useAppRouter();
  const controller = useAppController();
  const curator = playlist.curatorName ?? "Playlist";
  return (
    <CardShell
      contextData={playlistContextData(playlist)}
      catalogUrl={playlist.catalogUrl}
    >
      <button
        className="library-card"
        type="button"
        onClick={() =>
          router.navigate({
            kind: "playlist",
            id: playlist.id,
            source: "catalog",
          })
        }
      >
        <Artwork
          track={{
            title: playlist.name,
            artistName: curator,
            artwork: playlist.artwork,
          }}
          size="lg"
          alt={`${playlist.name} artwork`}
          className="library-card-art"
        />
        <span className="library-card-copy">
          <strong>{playlist.name}</strong>
          <small>{curator}</small>
        </span>
      </button>
      <CardActions
        title={playlist.name}
        onPlay={() =>
          void Promise.resolve(
            controller.playCollection("playlist", playlist.id, "catalog", 0),
          ).catch(reportActionError)
        }
      />
    </CardShell>
  );
}

function PlaylistGrid({ playlists }: { playlists: Playlist[] }): JSX.Element {
  return (
    <div className="library-card-grid curator-card-grid">
      {playlists.map((playlist) => (
        <CuratorPlaylistCard key={playlist.id} playlist={playlist} />
      ))}
    </div>
  );
}

/** Titled region; the heading names it for assistive tech. */
function CuratorShelf({
  id,
  title,
  shelf,
  children,
}: {
  id: string;
  title: string;
  shelf: "group" | "playlists";
  children: ComponentChildren;
}): JSX.Element {
  return (
    <section
      className="curator-shelf"
      aria-labelledby={`${id}-heading`}
      data-curator-shelf={shelf}
    >
      <h2 id={`${id}-heading`}>{title}</h2>
      {children}
    </section>
  );
}

/** Collapsed notes under the header, like an album's "More". */
function CuratorNotes({ notes }: { notes: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <section className="library-detail-more curator-notes">
      <button
        className="library-detail-more-toggle"
        type="button"
        aria-expanded={open}
        aria-controls="curator-notes-panel"
        onClick={() => setOpen((value) => !value)}
      >
        About <ChevronDown aria-hidden="true" size={14} />
      </button>
      <div
        id="curator-notes-panel"
        className="library-detail-more-body"
        hidden={!open}
      >
        {/* Plain text: Apple's line breaks survive, its markup does not. */}
        <p className="library-detail-notes">{notes}</p>
      </div>
    </section>
  );
}

/** An Apple Music curator: header, then grouped shelves or one playlist grid. */
export function CuratorView({
  id,
  kind,
}: {
  id: string;
  kind: CuratorKind;
}): JSX.Element {
  const state = useAppSlices("auth", "initialization");
  const controller = useAppController();
  const authorized =
    state.auth.status === "authorized" &&
    state.initialization.status === "ready";
  // Bumped by "Try again" so the same page reads again.
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; load: CuratorLoad }>();
  const [more, setMore] = useState<MoreState>();
  const key = `${kind}:${id}:${attempt}`;

  useEffect(() => {
    if (!authorized) return;
    let current = true;
    const finish = (load: CuratorLoad): void => {
      if (current) setLoaded({ key, load });
    };
    Promise.resolve()
      .then(() => controller.loadCurator(id, kind))
      .then(
        (page) => finish({ status: "ready", page }),
        (error: unknown) =>
          finish({ status: "error", message: safeErrorMessage(error) }),
      );
    return () => {
      current = false;
    };
  }, [authorized, controller, id, kind, key]);

  const current = loaded?.key === key ? loaded.load : undefined;
  const moreFor = more?.key === key ? more : undefined;

  const loadMore = (from: string): void => {
    const base = moreFor?.playlists ?? [];
    setMore({ key, playlists: base, next: from, busy: true });
    Promise.resolve()
      .then(() => controller.loadMoreCuratorPlaylists(from))
      .then(
        (result) =>
          setMore({
            key,
            playlists: [...base, ...result.playlists],
            next: result.next,
            busy: false,
          }),
        (error: unknown) =>
          setMore({
            key,
            playlists: base,
            next: from,
            busy: false,
            error: safeErrorMessage(error),
          }),
      );
  };

  if (!authorized) {
    return (
      <EmptyState
        icon={UserRound}
        title="Sign in to open this curator"
        description="Connect your Apple Music account to see its playlists."
        action={
          <button
            className="primary-button"
            type="button"
            disabled={
              state.initialization.status !== "ready" ||
              state.auth.pending === true
            }
            onClick={() => void controller.authorize().catch(reportActionError)}
          >
            {state.auth.pending === true ? "Signing in…" : "Sign in"}
          </button>
        }
      />
    );
  }

  if (!current) {
    return (
      <>
        <h1 className="sr-only" tabIndex={-1}>
          Curator
        </h1>
        <SkeletonStatus label="Loading curator">
          <SkeletonCardGrid count={6} />
        </SkeletonStatus>
      </>
    );
  }

  if (current.status === "error") {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Curator could not be loaded"
        description={current.message}
        action={
          <button
            className="secondary-button"
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </button>
        }
      />
    );
  }

  const { page } = current;
  // Apple's groups replace the flat list, so an empty group is not shown.
  const groups = page.groups.filter((group) => group.playlists.length > 0);
  const playlists = [...page.playlists, ...(moreFor?.playlists ?? [])];
  const nextPath = moreFor ? moreFor.next : page.next;
  const hasFlatShelf = playlists.length > 0 || nextPath !== undefined;

  return (
    <div className="curator-page" data-curator-kind={page.kind}>
      <header className="library-detail-hero curator-header">
        <div className="library-detail-art">
          <Artwork
            track={{
              title: page.name,
              artistName: "Curator",
              artwork: page.artwork,
            }}
            size="hero"
            alt={`${page.name} artwork`}
            priority
          />
        </div>
        <div className="library-detail-copy">
          <span className="eyebrow">
            {page.kind === "apple" ? "Apple Music curator" : "Curator"}
          </span>
          <h1 tabIndex={-1}>{page.name}</h1>
          {page.notes ? (
            <CuratorNotes key={page.id} notes={page.notes} />
          ) : null}
        </div>
      </header>
      {groups.length ? (
        groups.map((group, index) => (
          <CuratorShelf
            key={group.id}
            id={`curator-group-${index}`}
            title={group.name}
            shelf="group"
          >
            <PlaylistGrid playlists={group.playlists} />
          </CuratorShelf>
        ))
      ) : hasFlatShelf ? (
        <CuratorShelf
          id="curator-playlists"
          title="Playlists"
          shelf="playlists"
        >
          <PlaylistGrid playlists={playlists} />
          {nextPath ? (
            <div className="curator-more">
              <button
                className="secondary-button curator-load-more"
                type="button"
                aria-busy={moreFor?.busy ? true : undefined}
                disabled={moreFor?.busy}
                onClick={() => loadMore(nextPath)}
              >
                {moreFor?.busy ? (
                  <LoaderCircle className="spin" aria-hidden="true" size={16} />
                ) : null}{" "}
                Load more
              </button>
              {moreFor?.error ? (
                <p className="curator-more-error" role="status">
                  Could not load more playlists. {moreFor.error}
                </p>
              ) : null}
            </div>
          ) : null}
        </CuratorShelf>
      ) : (
        <EmptyState
          icon={ListMusic}
          title="No playlists"
          description="Apple Music did not return playlists for this curator."
          compact
        />
      )}
    </div>
  );
}
