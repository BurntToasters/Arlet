import { ListMusic, LoaderCircle } from "lucide-preact";
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
import type { Playlist } from "../domain/music.ts";
import type { CuratorPage } from "../musickit/curators.ts";
import {
  ARTWORK_BACKDROP_BUCKET,
  normalizeArtworkUrl,
} from "../musickit/normalize.ts";
import type { CuratorKind } from "../routing/router.ts";
import { EmptyState } from "./EmptyState.tsx";
import { CatalogNotes, CatalogPage, type CatalogLoad } from "./CatalogPage.tsx";

type CuratorLoad = CatalogLoad<CuratorPage>;

const CURATOR_TEXTS = {
  heading: "Curator",
  loadingLabel: "Loading curator",
  signInTitle: "Sign in to open this curator",
  signInDescription: "Connect your Apple Music account to see its playlists.",
  errorTitle: "Curator could not be loaded",
};

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

  const renderPage = (page: CuratorPage): JSX.Element => {
    const curatorBackdrop = page.artwork?.url;
    // Apple's groups replace the flat list, so an empty group is not shown.
    const groups = page.groups.filter((group) => group.playlists.length > 0);
    const playlists = [...page.playlists, ...(moreFor?.playlists ?? [])];
    const nextPath = moreFor ? moreFor.next : page.next;
    const hasFlatShelf = playlists.length > 0 || nextPath !== undefined;

    return (
      <div className="curator-page" data-curator-kind={page.kind}>
        <header
          className={`library-detail-hero curator-header${
            curatorBackdrop ? " has-hero-backdrop" : ""
          }`}
        >
          {curatorBackdrop ? (
            <img
              className="detail-hero-backdrop"
              src={normalizeArtworkUrl(
                curatorBackdrop,
                ARTWORK_BACKDROP_BUCKET,
              )}
              alt=""
              aria-hidden="true"
              decoding="async"
            />
          ) : null}
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
              <CatalogNotes
                key={page.id}
                notes={page.notes}
                label="About"
                panelId="curator-notes-panel"
                className="curator-notes"
              />
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
                    <LoaderCircle
                      className="spin"
                      aria-hidden="true"
                      size={16}
                    />
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
  };

  return (
    <CatalogPage
      texts={CURATOR_TEXTS}
      authorized={authorized}
      signInPending={state.auth.pending === true}
      signInDisabled={
        state.initialization.status !== "ready" || state.auth.pending === true
      }
      onSignIn={() => void controller.authorize().catch(reportActionError)}
      load={current}
      onRetry={() => setAttempt((value) => value + 1)}
      renderPage={renderPage}
    />
  );
}
