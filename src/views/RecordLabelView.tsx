import { AlertCircle, Disc3, UserRound } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import { useAppController, useAppSlices } from "../app/context.tsx";
import { reportActionError } from "../components/action-errors.ts";
import { Artwork } from "../components/Artwork.tsx";
import { SkeletonCardGrid, SkeletonStatus } from "../components/Skeleton.tsx";
import type { Album } from "../domain/music.ts";
import { AlbumCardGrid, shelfResources } from "./AlbumShelves.tsx";
import { EmptyState } from "./EmptyState.tsx";

/** A titled album shelf; hidden when Apple returned no albums for it. */
function LabelShelf({
  id,
  title,
  albums,
}: {
  id: string;
  title: string;
  albums: Album[];
}): JSX.Element | null {
  const cards = shelfResources(albums);
  if (cards.length === 0) return null;
  return (
    <section
      className="curator-shelf"
      aria-labelledby={`${id}-heading`}
      data-label-shelf={id}
    >
      <h2 id={`${id}-heading`}>{title}</h2>
      <AlbumCardGrid albums={cards} label={title} fallbackSource="catalog" />
    </section>
  );
}

/**
 * An Apple Music record label: header, then its latest and top releases. The
 * page only shows the loaded label whose ID matches the route, so a previous
 * label's releases never appear while this one loads.
 */
export function RecordLabelView({ id }: { id: string }): JSX.Element {
  const state = useAppSlices("auth", "initialization", "recordLabel");
  const controller = useAppController();
  const authorized =
    state.auth.status === "authorized" &&
    state.initialization.status === "ready";

  useEffect(() => {
    if (!authorized) return;
    // A failed read is kept in state and shown with a retry, not rethrown here.
    void controller.loadRecordLabel(id).catch(() => undefined);
  }, [authorized, controller, id]);

  const retry = (): void => {
    void controller.loadRecordLabel(id).catch(() => undefined);
  };

  if (!authorized) {
    return (
      <EmptyState
        icon={UserRound}
        title="Sign in to open this record label"
        description="Connect your Apple Music account to see its releases."
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

  const current = state.recordLabel.id === id ? state.recordLabel : undefined;

  if (current?.status === "error") {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Record label could not be loaded"
        description={
          current.error ?? "Apple Music did not return this record label."
        }
        action={
          <button className="secondary-button" type="button" onClick={retry}>
            Try again
          </button>
        }
      />
    );
  }

  const page = current?.status === "success" ? current.page : undefined;
  if (!page) {
    return (
      <>
        <h1 className="sr-only" tabIndex={-1}>
          Record label
        </h1>
        <SkeletonStatus label="Loading record label">
          <SkeletonCardGrid count={6} />
        </SkeletonStatus>
      </>
    );
  }

  return (
    <div className="curator-page record-label-page">
      <header className="library-detail-hero curator-header">
        <div className="library-detail-art">
          <Artwork
            track={{
              title: page.name,
              artistName: "Record label",
              artwork: page.artwork,
            }}
            size="hero"
            alt={`${page.name} artwork`}
            priority
          />
        </div>
        <div className="library-detail-copy">
          <span className="eyebrow">Record label</span>
          <h1 tabIndex={-1}>{page.name}</h1>
          {/* Plain text: Apple's line breaks survive, its markup does not. */}
          {page.description ? (
            <p className="library-detail-notes">{page.description}</p>
          ) : null}
        </div>
      </header>
      <LabelShelf
        id="latest-releases"
        title="Latest Releases"
        albums={page.latestReleases}
      />
      <LabelShelf
        id="top-releases"
        title="Top Releases"
        albums={page.topReleases}
      />
      {page.latestReleases.length === 0 && page.topReleases.length === 0 ? (
        <EmptyState
          icon={Disc3}
          title="No releases"
          description="Apple Music did not return releases for this record label."
          compact
        />
      ) : null}
    </div>
  );
}
