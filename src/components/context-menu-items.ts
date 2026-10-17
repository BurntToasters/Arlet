import {
  ArrowLeft,
  ArrowRight,
  Clipboard,
  Copy,
  Disc3,
  FolderPlus,
  Forward,
  Heart,
  LibraryBig,
  Link,
  ListPlus,
  Music2,
  Pin,
  PinOff,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Scissors,
  Settings,
  Shuffle,
  SkipForward,
  SquareStack,
  ThumbsDown,
  UserRound,
  X,
} from "lucide-preact";
import type { LucideIcon } from "lucide-preact";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { useAppRouter } from "../app/context.tsx";
import type { AppController } from "../app/controller.ts";
import { isLibraryTarget, ratingResourceType } from "../app/ratings.ts";
import type { Track } from "../domain/music.ts";
import type { TrackNavigation } from "../musickit/song-navigation.ts";
import type { Route } from "../routing/router.ts";
import { getState, ratingKey } from "../state.ts";
import { requestPlaylistDialog } from "./playlist-events.ts";
import {
  reportActionError,
  reportNotice,
  reportQueueEdit,
} from "./action-errors.ts";
import { nameArtistLinks } from "./artist-links.ts";
import {
  ratingTargetOf,
  type ContextKind,
  type ContextTarget,
} from "./context-target.ts";

export interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  icon: LucideIcon;
  disabled?: boolean;
  targetId?: string;
  action: () => void;
}

/** A visual divider between groups. Arrow keys skip it. */
export interface MenuSeparator {
  separator: true;
  id: string;
}

export type MenuEntry = MenuItem | MenuSeparator;

export function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return "separator" in entry;
}

/** Kinds whose Apple Music web link can be copied. */
const COPYABLE_KINDS: ReadonlySet<ContextKind> = new Set<ContextKind>([
  "track",
  "album",
  "artist",
  "playlist",
]);

function executeCommand(command: "cut" | "copy" | "paste" | "selectAll"): void {
  try {
    document.execCommand(command);
  } catch {
    // WebView2 may reject execCommand for an unfocused target. Clipboard
    // actions below still use the Tauri permissioned adapter where needed.
  }
}

function insertClipboardText(text: string): void {
  if (!text) return;
  try {
    if (document.execCommand("insertText", false, text)) return;
  } catch {
    // Fall through to the native input value path below.
  }
  const active = document.activeElement;
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement
  ) {
    const start = active.selectionStart ?? active.value.length;
    const end = active.selectionEnd ?? start;
    active.value = `${active.value.slice(0, start)}${text}${active.value.slice(end)}`;
    active.setSelectionRange(start + text.length, start + text.length);
    active.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/**
 * Joins item groups with one separator between each non-empty pair. Empty
 * groups are dropped, so the menu never starts or ends with a divider.
 */
function joinGroups(groups: readonly (readonly MenuItem[])[]): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const group of groups) {
    if (!group.length) continue;
    if (entries.length) {
      // Keyed by the item that follows, so a rebuild does not remount the
      // dividers around items that did not change.
      entries.push({ separator: true, id: `separator-${group[0]?.id}` });
    }
    entries.push(...group);
  }
  return entries;
}

export function buildItems({
  controller,
  router,
  target,
  track,
  navigation,
  editable,
  selected,
  close,
  restoreFocus,
  restoreTarget,
}: {
  controller: AppController;
  router: ReturnType<typeof useAppRouter>;
  target: ContextTarget;
  track?: Track;
  navigation?: TrackNavigation;
  editable: boolean;
  selected: boolean;
  close: () => void;
  restoreFocus: () => void;
  restoreTarget?: HTMLElement;
}): MenuEntry[] {
  const run =
    (action: () => void): (() => void) =>
    () => {
      action();
      close();
    };
  const navigationItems: MenuItem[] = [
    {
      id: "back",
      label: "Back",
      shortcut: "Alt+Left",
      icon: ArrowLeft,
      action: run(router.back),
    },
    {
      id: "forward",
      label: "Forward",
      shortcut: "Alt+Right",
      icon: ArrowRight,
      action: run(router.forward),
    },
    {
      id: "refresh",
      label: "Refresh current data",
      shortcut: "Ctrl+R",
      icon: RefreshCw,
      action: run(() => {
        void controller.refreshCurrentData().catch(() => undefined);
      }),
    },
  ];

  const editItems: MenuItem[] = [];
  if (editable || selected) {
    editItems.push(
      {
        id: "cut",
        label: "Cut",
        shortcut: "Ctrl+X",
        icon: Scissors,
        disabled: !editable,
        action: run(() => {
          restoreFocus();
          executeCommand("cut");
        }),
      },
      {
        id: "copy",
        label: "Copy",
        shortcut: "Ctrl+C",
        icon: Copy,
        action: run(() => {
          restoreFocus();
          const text = window.getSelection()?.toString();
          if (text)
            void controller.copyText(text).catch(() => executeCommand("copy"));
          else executeCommand("copy");
        }),
      },
      {
        id: "paste",
        label: "Paste",
        shortcut: "Ctrl+V",
        icon: Clipboard,
        disabled: !editable,
        action: run(() => {
          void readText()
            .then((text: string) => {
              // execCommand lets WebView2 insert into the focused native input;
              // the read is intentionally permissioned through the Tauri plugin.
              if (editable) {
                restoreFocus();
                insertClipboardText(text);
              }
            })
            .catch(() => undefined);
        }),
      },
      {
        id: "select-all",
        label: "Select all",
        shortcut: "Ctrl+A",
        icon: SquareStack,
        disabled: !editable,
        action: run(() => {
          restoreFocus();
          executeCommand("selectAll");
        }),
      },
    );
  }

  const playbackItems: MenuItem[] = [];
  const libraryItems: MenuItem[] = [];
  const goToItems: MenuItem[] = [];
  const createItems: MenuItem[] = [];

  if (track) {
    const playNow = (): void => {
      const parentAction =
        target.parentKind === "playlist"
          ? controller.playPlaylist
          : target.parentKind === "album"
            ? controller.playAlbum
            : undefined;
      if (
        target.parentId &&
        target.parentIndex !== undefined &&
        typeof parentAction === "function"
      ) {
        void parentAction(
          target.parentId,
          target.parentSource,
          target.parentIndex,
          track.id,
        ).catch(reportActionError);
        return;
      }
      void statefulPlay(controller, track).catch(reportActionError);
    };
    playbackItems.push(
      {
        id: "play-now",
        label: "Play now",
        icon: Play,
        action: run(playNow),
      },
      {
        id: "play-next",
        label: "Play next",
        icon: SkipForward,
        action: run(() => {
          void controller.playNextTracks([track]).catch(reportActionError);
        }),
      },
      {
        id: "play-later",
        label: "Play later",
        icon: Forward,
        action: run(() => {
          void controller.playLaterTracks([track]).catch(reportActionError);
        }),
      },
      {
        id: "start-station",
        label: "Start Station",
        icon: Radio,
        action: run(() => {
          void controller
            .startStation({
              kind: "song",
              id: track.id,
              catalogId: track.catalogId,
            })
            .catch(reportActionError);
        }),
      },
      {
        id: "add-to-playlist",
        label: "Add to playlist…",
        icon: ListPlus,
        action: run(() => {
          requestPlaylistDialog("picker", [track], restoreTarget);
        }),
      },
    );
    const queueIndex = target.queueIndex;
    if (queueIndex !== undefined) {
      playbackItems.push({
        id: "remove-from-queue",
        label: "Remove from queue",
        icon: X,
        action: run(() => {
          reportQueueEdit(controller.removeQueueItem(queueIndex, track.id));
        }),
      });
    }

    const trackNavigation = navigation ?? {
      album: track.albumRef,
      artists: track.artistRefs ?? [],
    };
    if (trackNavigation.album) {
      const album = trackNavigation.album;
      goToItems.push({
        id: "go-to-album",
        label: album.name ? `Go to album: ${album.name}` : "Go to album",
        icon: Disc3,
        targetId: album.id,
        action: run(() =>
          router.navigate({
            kind: "album",
            id: album.id,
            ...(album.source === "catalog" ? { source: "catalog" } : {}),
          }),
        ),
      });
    }
    // The same artist can be listed twice with one source; one entry each.
    const artists = nameArtistLinks(
      trackNavigation.artists,
      track.artistName,
    ).filter(
      (artist, index, all) =>
        all.findIndex(
          (other) => other.id === artist.id && other.source === artist.source,
        ) === index,
    );
    const artistCounts = new Map<string, number>();
    for (const artist of artists) {
      artistCounts.set(artist.id, (artistCounts.get(artist.id) ?? 0) + 1);
    }
    for (const artist of artists) {
      goToItems.push({
        id: `go-to-artist-${encodeURIComponent(artist.id)}${
          artistCounts.get(artist.id) === 1 ? "" : `-${artist.source}`
        }`,
        label: artist.name ? `Go to artist: ${artist.name}` : "Go to artist",
        icon: UserRound,
        targetId: artist.id,
        action: run(() =>
          router.navigate({
            kind: "artist",
            id: artist.id,
            ...(artist.source === "catalog" ? { source: "catalog" } : {}),
          }),
        ),
      });
    }
  }

  const ratingTarget = ratingTargetOf(target);
  const ratingType = ratingTarget && ratingResourceType(ratingTarget);
  if (ratingTarget && ratingType) {
    const liked = getState().ratings[ratingKey(ratingType, ratingTarget.id)];
    // Toggle against the value at click time, not at menu build time.
    const toggle = (value: 1 | -1): (() => void) =>
      run(() => {
        const current =
          getState().ratings[ratingKey(ratingType, ratingTarget.id)];
        void controller.rate(ratingTarget, current === value ? 0 : value);
      });
    libraryItems.push(
      {
        id: "love",
        label: liked === 1 ? "Unlove" : "Love",
        icon: Heart,
        action: toggle(1),
      },
      {
        id: "dislike",
        label: liked === -1 ? "Remove dislike" : "Dislike",
        icon: ThumbsDown,
        action: toggle(-1),
      },
    );
    if (!isLibraryTarget(ratingTarget) && target.source !== "library") {
      libraryItems.push({
        id: "add-to-library",
        label: "Add to Library",
        icon: LibraryBig,
        action: run(() => {
          void controller.addToLibrary(ratingTarget);
        }),
      });
    }
  }

  if (target.route) {
    goToItems.push({
      id: "open-resource",
      label: `Open ${target.route.kind}`,
      icon: Music2,
      action: run(() => router.navigate(target.route as Route)),
    });
  }

  const playlistId =
    target.kind === "playlist"
      ? target.id
      : target.route?.kind === "playlist"
        ? target.route.id
        : undefined;
  if (playlistId) {
    const source =
      target.source ??
      (target.route?.kind === "playlist" ? target.route.source : undefined) ??
      "library";
    const pinned = controller.isPinned(playlistId);
    goToItems.push({
      id: pinned ? "unpin-playlist" : "pin-playlist",
      label: pinned ? "Unpin playlist" : "Pin playlist",
      icon: pinned ? PinOff : Pin,
      action: run(() => {
        if (pinned) void controller.unpin(playlistId).catch(reportActionError);
        else
          void controller
            .togglePin(playlistId, source)
            .catch(reportActionError);
      }),
    });
  }

  const catalogUrl = target.catalogUrl;
  if (catalogUrl && target.kind && COPYABLE_KINDS.has(target.kind)) {
    goToItems.push({
      id: "copy-link",
      label: "Copy Apple Music link",
      icon: Link,
      action: run(() => {
        // Through the controller, so a busy clipboard times out into the error toast.
        void controller
          .copyText(catalogUrl)
          .then(() => reportNotice("Link copied."))
          .catch(() => reportActionError("Could not copy the link."));
      }),
    });
  }

  if ((target.kind === "playlist" || target.kind === "album") && target.id) {
    const kind = target.kind;
    const collectionId = target.id;
    const source =
      target.source ??
      (target.route?.kind === "playlist" || target.route?.kind === "album"
        ? target.route.source
        : undefined) ??
      "library";
    playbackItems.push(
      {
        id: "play-now",
        label: "Play now",
        icon: Play,
        action: run(() => {
          void controller
            .playCollection(kind, collectionId, source, 0)
            .catch(reportActionError);
        }),
      },
      {
        id: "shuffle-collection",
        label: "Shuffle",
        icon: Shuffle,
        action: run(() => {
          void controller
            .playCollection(kind, collectionId, source, 0, { shuffle: true })
            .catch(reportActionError);
        }),
      },
      {
        id: "play-next-collection",
        label: "Play next",
        icon: SkipForward,
        action: run(() => {
          void controller
            .queueCollection(kind, collectionId, source, "next")
            .catch(reportActionError);
        }),
      },
      {
        id: "play-later-collection",
        label: "Play later",
        icon: Forward,
        action: run(() => {
          void controller
            .queueCollection(kind, collectionId, source, "later")
            .catch(reportActionError);
        }),
      },
    );
  }

  if (target.kind === "artist" && target.id) {
    const artistId = target.id;
    playbackItems.push({
      id: "start-station",
      label: "Start Station",
      icon: Radio,
      action: run(() => {
        void controller
          .startStation({
            kind: "artist",
            id: artistId,
            catalogId: target.catalogId,
            source: target.source,
          })
          .catch(reportActionError);
      }),
    });
  }

  if (target.kind === "playlist" || target.kind === "folder" || !target.kind) {
    createItems.push(
      {
        id: "new-playlist",
        label: "New playlist",
        icon: Plus,
        action: run(() => {
          requestPlaylistDialog("create", [], restoreTarget);
        }),
      },
      {
        id: "new-folder",
        label: "New playlist folder",
        icon: FolderPlus,
        action: run(() => requestPlaylistDialog("folder")),
      },
    );
  }

  const appItems: MenuItem[] = [
    {
      id: "search",
      label: "Search Apple Music",
      shortcut: "Ctrl+K",
      icon: Search,
      action: run(() => router.navigate({ kind: "search", query: "" })),
    },
    {
      id: "settings",
      label: "Settings",
      icon: Settings,
      action: run(() => router.navigate({ kind: "settings" })),
    },
  ];

  return joinGroups([
    navigationItems,
    editItems,
    playbackItems,
    libraryItems,
    goToItems,
    createItems,
    appItems,
  ]);
}

async function statefulPlay(
  controller: AppController,
  track: Track,
): Promise<void> {
  await controller.playTracks([track]);
}
