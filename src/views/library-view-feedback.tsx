import {
  AlertCircle,
  Disc3,
  History as HistoryIcon,
  ListMusic,
  Music2,
  UserRound,
} from "lucide-preact";
import type { JSX } from "preact";
import type { LibrarySection } from "../routing/router.ts";
import {
  SkeletonCardGrid,
  SkeletonRows,
  SkeletonStatus,
} from "../components/Skeleton.tsx";
import { EmptyState } from "./EmptyState.tsx";
import type { CollectionLike } from "./library-view-convert.ts";
import { SECTION_COPY } from "./library-view-shared.ts";

export function CollectionFeedback({
  collection,
  section,
  onRetry,
}: {
  collection: CollectionLike;
  section: LibrarySection;
  onRetry: () => void;
}): JSX.Element | null {
  if (collection.status === "loading" && collection.items.length === 0) {
    const label = `Loading ${SECTION_COPY[section].title}…`;
    if (section === "recent") {
      return (
        <SkeletonStatus label={label}>
          <SkeletonRows count={5} />
          <SkeletonCardGrid count={4} />
        </SkeletonStatus>
      );
    }
    if (
      section === "artists" ||
      section === "albums" ||
      section === "playlists"
    ) {
      return (
        <SkeletonStatus label={label}>
          <SkeletonCardGrid count={8} />
        </SkeletonStatus>
      );
    }
    return (
      <SkeletonStatus label={label}>
        <SkeletonRows count={8} />
      </SkeletonStatus>
    );
  }
  if (collection.error && collection.items.length === 0) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Library could not be loaded"
        description={collection.error}
        action={
          <button className="secondary-button" type="button" onClick={onRetry}>
            Try again
          </button>
        }
      />
    );
  }
  if (collection.status !== "loading" && collection.items.length === 0) {
    const Icon =
      section === "history"
        ? HistoryIcon
        : section === "artists"
          ? UserRound
          : section === "albums"
            ? Disc3
            : section === "playlists"
              ? ListMusic
              : Music2;
    return (
      <EmptyState
        icon={Icon}
        title={
          section === "history"
            ? "No recent listening yet"
            : "Your library is empty"
        }
        description={SECTION_COPY[section].description}
        compact
      />
    );
  }
  return null;
}
