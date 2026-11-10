import { ListMusic } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import {
  useAppController,
  useAppRouter,
  useAppSlices,
} from "../app/context.tsx";
import { reportActionError } from "../components/action-errors.ts";
import { Artwork } from "../components/Artwork.tsx";
import { CardActions, CardShell } from "../components/CardActions.tsx";
import type { Activity, Playlist } from "../domain/music.ts";
import { CatalogPage, type CatalogLoad } from "./CatalogPage.tsx";
import { EmptyState } from "./EmptyState.tsx";

const ACTIVITY_TEXTS = {
  heading: "Activity",
  loadingLabel: "Loading activity",
  signInTitle: "Sign in to open this activity",
  signInDescription: "Connect your Apple Music account to see its playlists.",
  errorTitle: "Activity could not be loaded",
};

function playlistContextData(playlist: Playlist): Record<string, string> {
  return {
    "data-context-kind": "playlist",
    "data-context-id": playlist.id,
    "data-context-title": playlist.name,
    "data-context-route-kind": "playlist",
    "data-context-source": "catalog",
  };
}

/** Card for one of the activity's playlists; opens it and offers Play and "...". */
function ActivityPlaylistCard({
  playlist,
}: {
  playlist: Playlist;
}): JSX.Element {
  const router = useAppRouter();
  const controller = useAppController();
  const subtitle = playlist.curatorName ?? "Playlist";
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
            artistName: subtitle,
            artwork: playlist.artwork,
          }}
          size="lg"
          alt={`${playlist.name} artwork`}
          className="library-card-art"
        />
        <span className="library-card-copy">
          <strong>{playlist.name}</strong>
          <small>{subtitle}</small>
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

/**
 * An Apple Music activity: header, then its playlists. Only the loaded activity
 * whose ID matches the route is shown, so another activity's playlists never
 * appear while this one loads.
 */
export function ActivityView({ id }: { id: string }): JSX.Element {
  const state = useAppSlices("auth", "initialization", "activity");
  const controller = useAppController();
  const authorized =
    state.auth.status === "authorized" &&
    state.initialization.status === "ready";

  useEffect(() => {
    if (!authorized) return;
    // A failed read is kept in state and shown with a retry, not rethrown here.
    void controller.loadActivity(id).catch(() => undefined);
  }, [authorized, controller, id]);

  const retry = (): void => {
    void controller.loadActivity(id).catch(() => undefined);
  };

  const current = state.activity.id === id ? state.activity : undefined;
  const load: CatalogLoad<Activity> | undefined =
    current?.status === "error"
      ? {
          status: "error",
          message: current.error ?? "Apple Music did not return this activity.",
        }
      : current?.status === "success" && current.page
        ? { status: "ready", page: current.page }
        : undefined;

  const renderPage = (page: Activity): JSX.Element => (
    <div className="curator-page activity-page">
      <header className="library-detail-hero curator-header">
        <div className="library-detail-art">
          <Artwork
            track={{
              title: page.name,
              artistName: "Activity",
              artwork: page.artwork,
            }}
            size="hero"
            alt={`${page.name} artwork`}
            priority
          />
        </div>
        <div className="library-detail-copy">
          <span className="eyebrow">Apple Music activity</span>
          <h1 tabIndex={-1}>{page.name}</h1>
        </div>
      </header>
      {page.playlists.length > 0 ? (
        <section
          className="curator-shelf"
          aria-labelledby="activity-playlists-heading"
        >
          <h2 id="activity-playlists-heading">Playlists</h2>
          <div className="library-card-grid" aria-label="Activity playlists">
            {page.playlists.map((playlist) => (
              <ActivityPlaylistCard key={playlist.id} playlist={playlist} />
            ))}
          </div>
        </section>
      ) : (
        <EmptyState
          icon={ListMusic}
          title="No playlists"
          description="Apple Music did not return playlists for this activity."
          compact
        />
      )}
    </div>
  );

  return (
    <CatalogPage
      texts={ACTIVITY_TEXTS}
      authorized={authorized}
      signInPending={state.auth.pending === true}
      signInDisabled={
        state.initialization.status !== "ready" || state.auth.pending === true
      }
      onSignIn={() => void controller.authorize().catch(reportActionError)}
      load={load}
      onRetry={retry}
      renderPage={renderPage}
    />
  );
}
