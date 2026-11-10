import { ArrowLeft, LoaderCircle } from "lucide-preact";
import type { JSX } from "preact";
import {
  SEARCH_OVERVIEW_LIMIT,
  type PagedSearchGroupKind,
} from "../musickit/search.ts";
import { GROUP_TITLES } from "./search-view-model.ts";
import {
  searchGroupItems,
  type SearchGroupsContext,
} from "./search-view-groups.tsx";

/** Overview-only groups: first page only, no "See all" page. */
export function overviewSection(
  ctx: SearchGroupsContext,
  kind: "record-labels" | "activities",
): JSX.Element | null {
  const { groups } = ctx;
  const count =
    kind === "record-labels"
      ? (groups.recordLabels?.length ?? 0)
      : (groups.activities?.length ?? 0);
  if (!count) return null;
  return (
    <section
      className="home-feed-section"
      aria-labelledby={`search-${kind}-heading`}
      data-search-group={kind}
    >
      <div className="section-heading">
        <h2 id={`search-${kind}-heading`}>{GROUP_TITLES[kind]}</h2>
      </div>
      {searchGroupItems(ctx, kind, SEARCH_OVERVIEW_LIMIT)}
    </section>
  );
}

export function groupSection(
  ctx: SearchGroupsContext,
  kind: PagedSearchGroupKind,
  onSeeAll: (kind: PagedSearchGroupKind) => void,
): JSX.Element | null {
  const { groups, source } = ctx;
  if (!groups[kind].length) return null;
  const seeAll =
    source === "catalog" ? (
      <button
        className="search-see-all"
        type="button"
        aria-label={`See all ${GROUP_TITLES[kind].toLowerCase()}`}
        onClick={() => onSeeAll(kind)}
      >
        See all
      </button>
    ) : null;
  const heading = <h2 id={`search-${kind}-heading`}>{GROUP_TITLES[kind]}</h2>;
  if (kind === "songs") {
    return (
      <section
        className="search-results-panel"
        aria-labelledby="search-songs-heading"
      >
        <div className="results-toolbar">
          {heading}
          {seeAll}
        </div>
        {searchGroupItems(ctx, kind, SEARCH_OVERVIEW_LIMIT)}
      </section>
    );
  }
  return (
    <section
      className="home-feed-section"
      aria-labelledby={`search-${kind}-heading`}
    >
      <div className="section-heading">
        {heading}
        {seeAll}
      </div>
      {searchGroupItems(ctx, kind, SEARCH_OVERVIEW_LIMIT)}
    </section>
  );
}

export function seeAllView(
  ctx: SearchGroupsContext,
  kind: PagedSearchGroupKind,
  onBack: () => void,
): JSX.Element {
  const { groups, controller } = ctx;
  const paging = groups.paging[kind];
  const count = groups[kind].length;
  return (
    <section
      className="search-see-all-view"
      aria-labelledby="search-see-all-heading"
    >
      <div className="section-heading search-see-all-heading">
        <button
          className="secondary-button"
          type="button"
          onClick={() => onBack()}
        >
          <ArrowLeft aria-hidden="true" size={16} /> Back to results
        </button>
        <h2 id="search-see-all-heading">{GROUP_TITLES[kind]}</h2>
      </div>
      {count ? searchGroupItems(ctx, kind) : null}
      {paging?.status === "loading" ? (
        <div className="search-feedback" role="status">
          <LoaderCircle className="spin" size={22} /> Loading more…
        </div>
      ) : null}
      {paging?.status === "error" ? (
        <p className="library-stale-note" role="alert">
          More {GROUP_TITLES[kind].toLowerCase()} could not be loaded:{" "}
          {paging.error ?? "Try again in a moment."}
        </p>
      ) : null}
      {paging && (paging.status === "idle" || paging.status === "error") ? (
        <div className="search-see-all-more">
          <button
            className="secondary-button"
            type="button"
            onClick={() => void controller.loadMoreSearch(kind)}
          >
            Load more
          </button>
        </div>
      ) : null}
      {paging?.status === "done" ? (
        <p className="search-see-all-end">
          All {count} {GROUP_TITLES[kind].toLowerCase()} are shown.
        </p>
      ) : null}
    </section>
  );
}
