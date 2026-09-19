import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  ArrowLeft,
  ArrowRight,
  Clipboard,
  Copy,
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
  SkipForward,
  SquareStack,
} from "lucide-preact";
import type { LucideIcon } from "lucide-preact";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useAppController, useAppRouter } from "../app/context.tsx";
import type { Track } from "../domain/music.ts";
import type { Route } from "../routing/router.ts";
import {
  CONTEXT_MENU_REQUEST,
  type ContextMenuRequestDetail,
} from "./context-menu-events.ts";
import { requestPlaylistDialog } from "./playlist-events.ts";

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
}

interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  icon: LucideIcon;
  disabled?: boolean;
  action: () => void;
}

interface MenuState {
  x: number;
  y: number;
  target: ContextTarget;
  items: MenuItem[];
}

function closestContextTarget(node: EventTarget | null): HTMLElement | null {
  return node instanceof HTMLElement
    ? node.closest<HTMLElement>("[data-context-kind], [data-context-track-id]")
    : null;
}

function parseTarget(node: HTMLElement | null): ContextTarget {
  if (!node) return {};
  const kind = node.dataset.contextKind as ContextKind | undefined;
  const routeKind = node.dataset.contextRouteKind as Route["kind"] | undefined;
  const source =
    node.dataset.contextSource === "catalog" ? "catalog" : undefined;
  let route: Route | undefined;
  if (
    routeKind === "album" ||
    routeKind === "artist" ||
    routeKind === "playlist"
  ) {
    const id = node.dataset.contextId;
    if (id) {
      route =
        routeKind !== "artist" && source === "catalog"
          ? { kind: routeKind, id, source }
          : { kind: routeKind, id };
    }
  }
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

function promptName(label: string): string | undefined {
  const value = window.prompt(label);
  const trimmed = value?.trim();
  return trimmed ?? undefined;
}

function ContextMenuItem({ item }: { item: MenuItem }): JSX.Element {
  const Icon = item.icon;
  return (
    <button
      className="context-menu-item"
      type="button"
      role="menuitem"
      data-menu-item={item.id}
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
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const extendedController = controller as unknown as AppControllerWithContext;

  useEffect(() => {
    const open = ({
      target: eventTarget,
      x,
      y,
      restoreFocus,
    }: ContextMenuRequestDetail): void => {
      const contextNode = closestContextTarget(eventTarget) ?? eventTarget;
      const target = parseTarget(contextNode);
      const track = targetTrack(target);
      restoreFocusRef.current =
        restoreFocus ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
      setMenu({
        x,
        y,
        target,
        items: buildItems({
          controller: extendedController,
          router,
          target,
          track,
          editable: false,
          selected: false,
          close: () => setMenu(null),
          restoreFocus: () => restoreFocusRef.current?.focus(),
          restoreTarget: restoreFocusRef.current ?? undefined,
        }),
      });
      setPosition({ x, y });
    };
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      const eventTarget =
        event.target instanceof HTMLElement ? event.target : document.body;
      const contextNode = closestContextTarget(event.target) ?? eventTarget;
      const target = parseTarget(contextNode);
      const track = targetTrack(target);
      restoreFocusRef.current =
        eventTarget.closest<HTMLElement>("button, [tabindex]") ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
      setMenu({
        x: event.clientX,
        y: event.clientY,
        target,
        items: buildItems({
          controller: extendedController,
          router,
          target,
          track,
          editable: isEditableTarget(event.target),
          selected: hasSelection(),
          close: () => setMenu(null),
          restoreFocus: () => restoreFocusRef.current?.focus(),
          restoreTarget: restoreFocusRef.current ?? undefined,
        }),
      });
      setPosition({ x: event.clientX, y: event.clientY });
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
    const close = (): void => setMenu(null);
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
  }, [menu]);

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
}

function buildItems({
  controller,
  router,
  target,
  track,
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
    items.push(
      {
        id: "play-now",
        label: "Play now",
        icon: Play,
        action: run(() => void statefulPlay(controller, track)),
      },
      {
        id: "play-next",
        label: "Play next",
        icon: SkipForward,
        action: run(() => {
          const playNext = controller.playNextTracks;
          if (playNext) void playNext([track]).catch(() => undefined);
          else void statefulPlay(controller, track).catch(() => undefined);
        }),
      },
      {
        id: "play-later",
        label: "Play later",
        icon: Forward,
        action: run(() => {
          const playLater = controller.playLaterTracks;
          if (playLater) void playLater([track]).catch(() => undefined);
          else void statefulPlay(controller, track).catch(() => undefined);
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
        if (pinned) void controller.unpin?.(playlistId).catch(() => undefined);
        else
          void controller
            .togglePin?.(playlistId, source)
            .catch(() => undefined);
      }),
    });
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
        action: run(() => {
          const name = promptName("Playlist folder name");
          if (name && controller.createPlaylistFolder)
            void controller.createPlaylistFolder(name).catch(() => undefined);
        }),
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
