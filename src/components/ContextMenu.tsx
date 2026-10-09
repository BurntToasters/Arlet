import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  ArrowLeft,
  ArrowRight,
  Clipboard,
  Copy,
  Disc3,
  FolderPlus,
  Forward,
  ListPlus,
  Music2,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  Search,
  Scissors,
  Settings,
  Shuffle,
  SkipForward,
  SquareStack,
  UserRound,
  X,
} from "lucide-preact";
import type { LucideIcon } from "lucide-preact";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useAppController, useAppRouter } from "../app/context.tsx";
import type { MusicEntityRef, MusicSource, Track } from "../domain/music.ts";
import type { TrackNavigation } from "../musickit/song-navigation.ts";
import type { CollectionPlayOptions } from "../app/collection-playback.ts";
import type { Route } from "../routing/router.ts";
import {
  CONTEXT_MENU_REQUEST,
  type ContextMenuRequestDetail,
} from "./context-menu-events.ts";
import { requestPlaylistDialog } from "./playlist-events.ts";
import { reportActionError, reportQueueEdit } from "./action-errors.ts";
import type { QueueEditTier } from "../musickit/queue-edit.ts";

type ContextKind = "track" | "album" | "artist" | "playlist" | "folder";

interface ContextTarget {
  kind?: ContextKind;
  id?: string;
  title?: string;
  artistName?: string;
  albumTitle?: string;
  artworkUrl?: string;
  resourceType?: string;
  catalogId?: string;
  source?: "library" | "catalog";
  route?: Route;
  albumRef?: MusicEntityRef;
  artistRefs?: MusicEntityRef[];
  parentKind?: "album" | "playlist";
  parentId?: string;
  parentSource?: MusicSource;
  parentIndex?: number;
  queueIndex?: number;
}

interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  icon: LucideIcon;
  disabled?: boolean;
  targetId?: string;
  action: () => void;
}

interface MenuState {
  x: number;
  y: number;
  requestId: number;
  target: ContextTarget;
  items: MenuItem[];
}

function closestContextTarget(node: EventTarget | null): HTMLElement | null {
  return node instanceof HTMLElement
    ? node.closest<HTMLElement>("[data-context-kind], [data-context-track-id]")
    : null;
}

function parseEntityRef(value: unknown): MusicEntityRef | undefined {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) return undefined;
  const type = typeof record.type === "string" ? record.type : "";
  const source =
    record.source === "catalog" || type.startsWith("catalog")
      ? "catalog"
      : "library";
  const name =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : undefined;
  return { id: record.id, source, ...(name ? { name } : {}) };
}

function parseEntityRefs(value: unknown): MusicEntityRef[] {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(candidate)) return [];
  return candidate
    .map(parseEntityRef)
    .filter((ref): ref is MusicEntityRef => ref !== undefined);
}

function parseTarget(node: HTMLElement | null): ContextTarget {
  if (!node) return {};
  const kind = node.dataset.contextKind as ContextKind | undefined;
  const routeKind = node.dataset.contextRouteKind as Route["kind"] | undefined;
  const source =
    node.dataset.contextSource === "catalog"
      ? "catalog"
      : node.dataset.contextSource === "library"
        ? "library"
        : undefined;
  const parentKind =
    node.dataset.contextParentKind === "album" ||
    node.dataset.contextParentKind === "playlist"
      ? node.dataset.contextParentKind
      : undefined;
  const parentIndex = Number(node.dataset.contextParentIndex);
  const queueIndex = Number(node.dataset.contextQueueIndex);
  let route: Route | undefined;
  if (
    routeKind === "album" ||
    routeKind === "artist" ||
    routeKind === "playlist"
  ) {
    const id = node.dataset.contextId;
    if (id) {
      route =
        source === "catalog"
          ? { kind: routeKind, id, source }
          : { kind: routeKind, id };
    }
  }
  const rawAlbumRef = parseEntityRef(node.dataset.contextAlbumRef);
  const albumRef =
    rawAlbumRef ??
    (node.dataset.contextAlbumId
      ? parseEntityRef({
          id: node.dataset.contextAlbumId,
          name: node.dataset.contextAlbum,
          source: node.dataset.contextAlbumSource,
        })
      : undefined);
  return {
    kind,
    id: node.dataset.contextId ?? node.dataset.contextTrackId,
    title: node.dataset.contextTitle,
    artistName: node.dataset.contextArtist,
    albumTitle: node.dataset.contextAlbum,
    artworkUrl: node.dataset.contextArtwork,
    resourceType: node.dataset.contextResourceType,
    catalogId: node.dataset.contextCatalogId,
    source,
    route,
    albumRef,
    artistRefs: parseEntityRefs(node.dataset.contextArtistRefs),
    parentKind,
    parentId: node.dataset.contextParentId,
    parentSource:
      node.dataset.contextParentSource === "catalog" ? "catalog" : "library",
    parentIndex:
      Number.isInteger(parentIndex) && parentIndex >= 0
        ? parentIndex
        : undefined,
    queueIndex:
      Number.isInteger(queueIndex) && queueIndex >= 0 ? queueIndex : undefined,
  };
}

function targetTrack(target: ContextTarget): Track | undefined {
  if (!target.id || target.kind !== "track") return undefined;
  return {
    id: target.id,
    title: target.title ?? "Unknown song",
    artistName: target.artistName ?? "Unknown artist",
    albumTitle: target.albumTitle,
    artwork: target.artworkUrl
      ? { url: target.artworkUrl, width: 300, height: 300 }
      : undefined,
    resourceType: target.resourceType,
    catalogId: target.catalogId,
    albumRef: target.albumRef,
    artistRefs: target.artistRefs,
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

function hasSelection(): boolean {
  return Boolean(window.getSelection()?.toString());
}

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

function ContextMenuItem({ item }: { item: MenuItem }): JSX.Element {
  const Icon = item.icon;
  return (
    <button
      className="context-menu-item"
      type="button"
      role="menuitem"
      data-menu-item={item.id}
      data-menu-target-id={item.targetId}
      disabled={item.disabled}
      onClick={item.action}
    >
      <Icon aria-hidden="true" size={15} strokeWidth={1.8} />
      <span>{item.label}</span>
      {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
    </button>
  );
}

export function ContextMenu(): JSX.Element | null {
  const controller = useAppController();
  const router = useAppRouter();
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const menuRequestRef = useRef(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const extendedController = controller as unknown as AppControllerWithContext;

  useEffect(() => {
    const showMenu = (
      eventTarget: HTMLElement,
      x: number,
      y: number,
      options: {
        restoreFocus?: HTMLElement;
        editable: boolean;
        selected: boolean;
      },
    ): void => {
      const contextNode = closestContextTarget(eventTarget) ?? eventTarget;
      const target = parseTarget(contextNode);
      const track = targetTrack(target);
      restoreFocusRef.current =
        options.restoreFocus ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
      const requestId = ++menuRequestRef.current;
      const close = (): void => {
        if (menuRequestRef.current === requestId) menuRequestRef.current += 1;
        setMenu(null);
      };
      const restoreFocus = (): void => restoreFocusRef.current?.focus();
      const makeItems = (navigation?: TrackNavigation): MenuItem[] =>
        buildItems({
          controller: extendedController,
          router,
          target,
          track,
          navigation,
          editable: options.editable,
          selected: options.selected,
          close,
          restoreFocus,
          restoreTarget: restoreFocusRef.current ?? undefined,
        });
      setMenu({
        x,
        y,
        requestId,
        target,
        items: makeItems(),
      });
      setPosition({ x, y });
      if (track && extendedController.resolveTrackNavigation) {
        void extendedController
          .resolveTrackNavigation(track)
          .then((navigation) => {
            if (menuRequestRef.current !== requestId) return;
            setMenu((current) =>
              current?.requestId === requestId
                ? { ...current, items: makeItems(navigation) }
                : current,
            );
          })
          .catch((error: unknown) => {
            if (menuRequestRef.current === requestId) reportActionError(error);
          });
      }
    };
    const open = ({
      target,
      x,
      y,
      restoreFocus,
    }: ContextMenuRequestDetail): void => {
      showMenu(target, x, y, {
        restoreFocus,
        editable: false,
        selected: false,
      });
    };
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      const eventTarget =
        event.target instanceof HTMLElement ? event.target : document.body;
      showMenu(eventTarget, event.clientX, event.clientY, {
        restoreFocus:
          eventTarget.closest<HTMLElement>("button, [tabindex]") ??
          (document.activeElement instanceof HTMLElement
            ? document.activeElement
            : undefined),
        editable: isEditableTarget(event.target),
        selected: hasSelection(),
      });
    };
    const onRequest = (event: Event): void => {
      const detail = (event as CustomEvent<ContextMenuRequestDetail>).detail;
      if (detail?.target) open(detail);
    };
    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener(CONTEXT_MENU_REQUEST, onRequest);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener(CONTEXT_MENU_REQUEST, onRequest);
    };
  }, [controller, router]);

  useEffect(() => {
    if (!menu) return undefined;
    const close = (): void => {
      menuRequestRef.current += 1;
      setMenu(null);
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (
        !(event.target instanceof Node) ||
        !menuRef.current?.contains(event.target)
      ) {
        close();
        restoreFocusRef.current?.focus();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        restoreFocusRef.current?.focus();
        return;
      }
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          "button.context-menu-item:not(:disabled)",
        ) ?? [],
      );
      if (!items.length) return;
      const active = document.activeElement;
      const currentIndex = items.indexOf(active as HTMLButtonElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        items[(currentIndex + delta + items.length) % items.length]?.focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        (event.key === "Home" ? items[0] : items.at(-1))?.focus();
      } else if (event.key === "Enter" || event.key === " ") {
        if (currentIndex >= 0) {
          event.preventDefault();
          items[currentIndex]?.click();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      "button.context-menu-item:not(:disabled)",
    );
    first?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [menu?.requestId]);

  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const rect = menuRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({
        x: Math.max(6, Math.min(menu.x, window.innerWidth - rect.width - 6)),
        y: Math.max(6, Math.min(menu.y, window.innerHeight - rect.height - 6)),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [menu]);

  if (!menu) return null;
  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label="Arlet context menu"
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {menu.items.map((item) => (
        <ContextMenuItem key={item.id} item={item} />
      ))}
    </div>
  );
}

interface AppControllerWithContext extends Record<string, unknown> {
  playTracks?: (tracks: readonly Track[], startIndex?: number) => Promise<void>;
  playAlbum?: (
    id: string,
    source?: MusicSource,
    startIndex?: number,
  ) => Promise<void>;
  playPlaylist?: (
    id: string,
    source?: MusicSource,
    startIndex?: number,
  ) => Promise<void>;
  playCollection?: (
    kind: "playlist" | "album",
    id: string,
    source?: MusicSource,
    startIndex?: number,
    options?: CollectionPlayOptions,
  ) => Promise<void>;
  playNextTracks?: (tracks: readonly Track[]) => Promise<void>;
  playLaterTracks?: (tracks: readonly Track[]) => Promise<void>;
  refreshCurrentData?: () => Promise<void>;
  refreshCurrentView?: () => Promise<void>;
  createPlaylist?: (...args: unknown[]) => Promise<unknown>;
  createPlaylistFolder?: (name: string) => Promise<unknown>;
  addTracksToPlaylist?: (
    playlistId: string,
    tracks: readonly Track[],
  ) => Promise<unknown>;
  isPinned?: (id: string) => boolean;
  togglePin?: (id: string, source?: "library" | "catalog") => Promise<void>;
  unpin?: (id: string) => Promise<void>;
  resolveTrackNavigation?: (track: Track) => Promise<TrackNavigation>;
  removeQueueItem?: (index: number) => Promise<QueueEditTier>;
}

function buildItems({
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
  controller: AppControllerWithContext;
  router: ReturnType<typeof useAppRouter>;
  target: ContextTarget;
  track?: Track;
  navigation?: TrackNavigation;
  editable: boolean;
  selected: boolean;
  close: () => void;
  restoreFocus: () => void;
  restoreTarget?: HTMLElement;
}): MenuItem[] {
  const run =
    (action: () => void): (() => void) =>
    () => {
      action();
      close();
    };
  const items: MenuItem[] = [
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
        const refresh =
          controller.refreshCurrentData ?? controller.refreshCurrentView;
        if (refresh) void refresh().catch(() => undefined);
      }),
    },
  ];

  if (editable || selected) {
    items.push(
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
          if (text) void writeText(text).catch(() => executeCommand("copy"));
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
        ).catch(reportActionError);
        return;
      }
      void statefulPlay(controller, track).catch(reportActionError);
    };
    items.push(
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
          const playNext = controller.playNextTracks;
          if (playNext) void playNext([track]).catch(reportActionError);
          else void statefulPlay(controller, track).catch(reportActionError);
        }),
      },
      {
        id: "play-later",
        label: "Play later",
        icon: Forward,
        action: run(() => {
          const playLater = controller.playLaterTracks;
          if (playLater) void playLater([track]).catch(reportActionError);
          else void statefulPlay(controller, track).catch(reportActionError);
        }),
      },
      {
        id: "add-to-playlist",
        label: "Add to playlist…",
        icon: ListPlus,
        disabled: !controller.addTracksToPlaylist,
        action: run(() => {
          if (controller.addTracksToPlaylist)
            requestPlaylistDialog("picker", [track], restoreTarget);
        }),
      },
    );
    const removeQueueItem = controller.removeQueueItem;
    const queueIndex = target.queueIndex;
    if (queueIndex !== undefined) {
      items.push({
        id: "remove-from-queue",
        label: "Remove from queue",
        icon: X,
        disabled: !removeQueueItem,
        action: run(() => {
          if (removeQueueItem) reportQueueEdit(removeQueueItem(queueIndex));
        }),
      });
    }

    const trackNavigation = navigation ?? {
      album: track.albumRef,
      artists: track.artistRefs ?? [],
    };
    if (trackNavigation.album) {
      const album = trackNavigation.album;
      items.push({
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
    const artistCounts = new Map<string, number>();
    for (const artist of trackNavigation.artists) {
      artistCounts.set(artist.id, (artistCounts.get(artist.id) ?? 0) + 1);
    }
    for (const artist of trackNavigation.artists) {
      items.push({
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

  if (target.route) {
    items.push({
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
  if (playlistId && (controller.togglePin ?? controller.unpin)) {
    const source =
      target.source ??
      (target.route?.kind === "playlist" ? target.route.source : undefined) ??
      "library";
    const pinned =
      typeof controller.isPinned === "function"
        ? controller.isPinned(playlistId)
        : false;
    items.push({
      id: pinned ? "unpin-playlist" : "pin-playlist",
      label: pinned ? "Unpin playlist" : "Pin playlist",
      icon: pinned ? PinOff : Pin,
      disabled: pinned ? !controller.unpin : !controller.togglePin,
      action: run(() => {
        if (pinned)
          void controller.unpin?.(playlistId).catch(reportActionError);
        else
          void controller
            .togglePin?.(playlistId, source)
            .catch(reportActionError);
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
    items.push(
      {
        id: "play-now",
        label: "Play now",
        icon: Play,
        disabled: !controller.playCollection,
        action: run(() => {
          if (controller.playCollection)
            void controller
              .playCollection(kind, collectionId, source, 0)
              .catch(reportActionError);
        }),
      },
      {
        id: "shuffle-collection",
        label: "Shuffle",
        icon: Shuffle,
        disabled: !controller.playCollection,
        action: run(() => {
          if (controller.playCollection)
            void controller
              .playCollection(kind, collectionId, source, 0, { shuffle: true })
              .catch(reportActionError);
        }),
      },
    );
  }

  if (target.kind === "playlist" || target.kind === "folder" || !target.kind) {
    items.push(
      {
        id: "new-playlist",
        label: "New playlist",
        icon: Plus,
        disabled: !controller.createPlaylist,
        action: run(() => {
          if (controller.createPlaylist)
            requestPlaylistDialog("create", [], restoreTarget);
        }),
      },
      {
        id: "new-folder",
        label: "New playlist folder",
        icon: FolderPlus,
        disabled: !controller.createPlaylistFolder,
        action: run(() => requestPlaylistDialog("folder")),
      },
    );
  }

  items.push(
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
  );
  return items;
}

async function statefulPlay(
  controller: AppControllerWithContext,
  track: Track,
): Promise<void> {
  const playTracks = controller.playTracks;
  if (typeof playTracks === "function") await playTracks([track]);
}
