import { ChevronDown, ChevronRight, Folder } from "lucide-preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { useAppRouter } from "../app/context.tsx";
import { sortItems, type LibrarySort } from "../library/view-options.ts";
import type { ResourceLike } from "./library-view-convert.ts";
import { ResourceCard } from "./library-view-cards.tsx";
import { contextData } from "./library-view-shared.ts";

export function PlaylistTree({
  resources,
  router,
  sort,
  filtered,
}: {
  resources: ResourceLike[];
  router: ReturnType<typeof useAppRouter>;
  sort: LibrarySort;
  /** A text or favorites filter is on, so folders with no match are hidden. */
  filtered: boolean;
}): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const folders = resources.filter((resource) => resource.isFolder);
  const playlists = resources.filter((resource) => !resource.isFolder);
  const childrenOf = (parentId?: string): ResourceLike[] =>
    resources.filter((resource) => resource.parentId === parentId);
  // Folders sort by title only for title sorts; otherwise they keep their order.
  const orderFolders = (list: ResourceLike[]): ResourceLike[] =>
    sort === "title-asc" || sort === "title-desc"
      ? sortItems(list, sort)
      : list;
  // Only matching playlists are in `resources`, so a folder shows when one sits below it.
  const hasShownContent = (folder: ResourceLike): boolean =>
    childrenOf(folder.id).some(
      (child) => !child.isFolder || hasShownContent(child),
    );
  const shownFolders = (list: ResourceLike[]): ResourceLike[] =>
    orderFolders(filtered ? list.filter(hasShownContent) : list);
  const renderPlaylist = (playlist: ResourceLike): JSX.Element => (
    <ResourceCard
      key={playlist.id}
      resource={playlist}
      kind="playlist"
      editInAppleMusic
      onOpen={() => router.navigate({ kind: "playlist", id: playlist.id })}
    />
  );
  const renderFolder = (folder: ResourceLike, depth = 0): JSX.Element => {
    const isOpen = open[folder.id] ?? true;
    const nestedPlaylists = childrenOf(folder.id).filter(
      (child) => !child.isFolder,
    );
    const nestedFolders = shownFolders(
      childrenOf(folder.id).filter((child) => child.isFolder),
    );
    return (
      <div
        className="playlist-folder"
        key={folder.id}
        style={{ "--folder-depth": depth }}
      >
        <button
          className="playlist-folder-heading"
          type="button"
          aria-expanded={isOpen}
          {...contextData(folder, "folder")}
          onClick={() =>
            setOpen((current) => ({ ...current, [folder.id]: !isOpen }))
          }
        >
          {isOpen ? (
            <ChevronDown size={16} aria-hidden="true" />
          ) : (
            <ChevronRight size={16} aria-hidden="true" />
          )}
          <Folder size={16} aria-hidden="true" />
          <span>{folder.title}</span>
        </button>
        {isOpen ? (
          <div className="library-card-grid playlist-folder-content">
            {nestedFolders.map((child) => renderFolder(child, depth + 1))}
            {nestedPlaylists.map(renderPlaylist)}
          </div>
        ) : null}
      </div>
    );
  };
  const rootFolders = shownFolders(
    folders.filter(
      (folder) =>
        !folder.parentId ||
        !folders.some((candidate) => candidate.id === folder.parentId),
    ),
  );
  const rootPlaylists = playlists.filter(
    (playlist) =>
      !playlist.parentId ||
      !folders.some((folder) => folder.id === playlist.parentId),
  );
  return (
    <div className="playlist-tree">
      {rootFolders.map((folder) => renderFolder(folder))}
      {rootPlaylists.length ? (
        <div className="library-card-grid">
          {rootPlaylists.map(renderPlaylist)}
        </div>
      ) : null}
    </div>
  );
}
