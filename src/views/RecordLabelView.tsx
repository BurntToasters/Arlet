import { Disc3 } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import { useAppController, useAppSlices } from "../app/context.tsx";
import { reportActionError } from "../components/action-errors.ts";
import { Artwork } from "../components/Artwork.tsx";
import type { Album, RecordLabel } from "../domain/music.ts";
import { AlbumCardGrid, shelfResources } from "./AlbumShelves.tsx";
import { CatalogNotes, CatalogPage, type CatalogLoad } from "./CatalogPage.tsx";
import { EmptyState } from "./EmptyState.tsx";

/** Descriptions up to this many characters stay in the hero; longer ones collapse. */
const INLINE_DESCRIPTION_MAX = 160;

const RECORD_LABEL_TEXTS = {
  heading: "Record label",
  loadingLabel: "Loading record label",
  signInTitle: "Sign in to open this record label",
  signInDescription: "Connect your Apple Music account to see its releases.",
  errorTitle: "Record label could not be loaded",
};

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

  const current = state.recordLabel.id === id ? state.recordLabel : undefined;
  const load: CatalogLoad<RecordLabel> | undefined =
    current?.status === "error"
      ? {
          status: "error",
          message:
            current.error ?? "Apple Music did not return this record label.",
        }
      : current?.status === "success" && current.page
        ? { status: "ready", page: current.page }
        : undefined;

  const renderPage = (page: RecordLabel): JSX.Element => {
    const description = page.description ?? "";
    const longDescription = description.length > INLINE_DESCRIPTION_MAX;
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
            {description && !longDescription ? (
              <p className="library-detail-notes">{description}</p>
            ) : null}
          </div>
        </header>
        {longDescription ? (
          <CatalogNotes
            key={id}
            notes={description}
            label="More"
            panelId="record-label-notes-panel"
            className="record-label-notes"
          />
        ) : null}
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
  };

  return (
    <CatalogPage
      texts={RECORD_LABEL_TEXTS}
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
