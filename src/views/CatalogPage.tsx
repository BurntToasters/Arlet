import { AlertCircle, ChevronDown, UserRound } from "lucide-preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { SkeletonCardGrid, SkeletonStatus } from "../components/Skeleton.tsx";
import { EmptyState } from "./EmptyState.tsx";

/** The read of one catalog page: a failure message, or the loaded page. */
export type CatalogLoad<T> =
  { status: "error"; message: string } | { status: "ready"; page: T };

/** The per-page strings shown for each state; the page's own wording. */
export interface CatalogTexts {
  /** Hidden heading shown while the page loads. */
  heading: string;
  loadingLabel: string;
  signInTitle: string;
  signInDescription: string;
  errorTitle: string;
}

export interface CatalogPageProps<T> {
  texts: CatalogTexts;
  authorized: boolean;
  signInPending: boolean;
  signInDisabled: boolean;
  onSignIn: () => void;
  /** undefined while the page is still loading. */
  load: CatalogLoad<T> | undefined;
  onRetry: () => void;
  renderPage: (page: T) => JSX.Element;
}

/**
 * Signed-out, error, and loading states for an Apple Music catalog page. Once
 * the page is ready, it renders the page itself through renderPage.
 */
export function CatalogPage<T>({
  texts,
  authorized,
  signInPending,
  signInDisabled,
  onSignIn,
  load,
  onRetry,
  renderPage,
}: CatalogPageProps<T>): JSX.Element {
  if (!authorized) {
    return (
      <EmptyState
        icon={UserRound}
        title={texts.signInTitle}
        description={texts.signInDescription}
        action={
          <button
            className="primary-button"
            type="button"
            disabled={signInDisabled}
            onClick={onSignIn}
          >
            {signInPending ? "Signing in…" : "Sign in"}
          </button>
        }
      />
    );
  }

  if (!load) {
    return (
      <>
        <h1 className="sr-only" tabIndex={-1}>
          {texts.heading}
        </h1>
        <SkeletonStatus label={texts.loadingLabel}>
          <SkeletonCardGrid count={6} />
        </SkeletonStatus>
      </>
    );
  }

  if (load.status === "error") {
    return (
      <EmptyState
        icon={AlertCircle}
        title={texts.errorTitle}
        description={load.message}
        action={
          <button className="secondary-button" type="button" onClick={onRetry}>
            Try again
          </button>
        }
      />
    );
  }

  return renderPage(load.page);
}

/** Collapsed plain-text notes under a catalog header, like an album's "More". */
export function CatalogNotes({
  notes,
  label,
  panelId,
  className,
}: {
  notes: string;
  label: string;
  panelId: string;
  className?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <section className={`library-detail-more ${className ?? ""}`.trim()}>
      <button
        className="library-detail-more-toggle"
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {label} <ChevronDown aria-hidden="true" size={14} />
      </button>
      <div id={panelId} className="library-detail-more-body" hidden={!open}>
        {/* Plain text: Apple's line breaks survive, its markup does not. */}
        <p className="library-detail-notes">{notes}</p>
      </div>
    </section>
  );
}
