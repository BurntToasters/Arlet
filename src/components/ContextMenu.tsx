import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  useAppController,
  useAppRouter,
  useAppSelector,
} from "../app/context.tsx";
import { ratingKeyOf } from "../app/ratings.ts";
import type { TrackNavigation } from "../musickit/song-navigation.ts";
import {
  CONTEXT_MENU_REQUEST,
  type ContextMenuRequestDetail,
} from "./context-menu-events.ts";
import { safeErrorMessage } from "../app/controller-support.ts";
import {
  closestContextTarget,
  parseTarget,
  ratingTargetOf,
  targetTrack,
  type ContextTarget,
} from "./context-target.ts";
import {
  buildItems,
  isSeparator,
  type MenuEntry,
  type MenuItem,
} from "./context-menu-items.ts";

interface MenuState {
  x: number;
  y: number;
  requestId: number;
  target: ContextTarget;
  items: MenuEntry[];
  /** Resolved song navigation, kept so a rebuild does not drop it. */
  navigation?: TrackNavigation;
  /** Store key of the target rating; the open menu rebuilds when it changes. */
  ratingKey?: string;
  build: (navigation?: TrackNavigation) => MenuEntry[];
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
  /** The item that last had focus, so a rebuild can hand focus back to it. */
  const focusedItemRef = useRef<string | undefined>(undefined);
  /** The element the menu opened on, and where it sat at that moment. */
  const anchorRef = useRef<
    { element: HTMLElement; top: number; left: number } | undefined
  >(undefined);

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
      // The page body does not move when an inner pane scrolls, so it cannot
      // serve as an anchor; without one, any scroll closes the menu as before.
      const anchorRect = eventTarget.getBoundingClientRect();
      anchorRef.current =
        eventTarget === document.body
          ? undefined
          : {
              element: eventTarget,
              top: anchorRect.top,
              left: anchorRect.left,
            };
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
      const makeItems = (navigation?: TrackNavigation): MenuEntry[] =>
        buildItems({
          controller,
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
      const ratingTarget = ratingTargetOf(target);
      setMenu({
        x,
        y,
        requestId,
        target,
        items: makeItems(),
        ratingKey: ratingTarget ? ratingKeyOf(ratingTarget) : undefined,
        build: makeItems,
      });
      setPosition({ x, y });
      let resolvedNavigation: TrackNavigation | undefined;
      if (track) {
        void controller
          .resolveTrackNavigation(track)
          .then((navigation) => {
            if (menuRequestRef.current !== requestId) return;
            resolvedNavigation = navigation;
            setMenu((current) =>
              current?.requestId === requestId
                ? { ...current, navigation, items: makeItems(navigation) }
                : current,
            );
          })
          .catch((error: unknown) => {
            // A background lookup (offline, or a library-only song) must not
            // toast just because the menu opened; the menu keeps its items.
            controller.log(
              `Song navigation lookup failed: ${safeErrorMessage(error)}`,
            );
          });
      }
      // Rebuild once the rating is known so Love/Dislike labels are current.
      if (ratingTarget) {
        void controller.loadRating(ratingTarget).then(() => {
          if (menuRequestRef.current !== requestId) return;
          setMenu((current) =>
            current?.requestId === requestId
              ? { ...current, items: makeItems(resolvedNavigation) }
              : current,
          );
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

  // Keyed on the request, not the menu: items refresh as lookups finish and
  // must not re-register listeners or move focus.
  const openRequestId = menu?.requestId;
  // The Love/Dislike labels read the store, so the open menu is rebuilt when
  // the target's rating lands or changes, not only when the menu opens.
  const menuRatingKey = menu?.ratingKey;
  const liveRating = useAppSelector((state) =>
    menuRatingKey === undefined ? undefined : state.ratings[menuRatingKey],
  );
  useEffect(() => {
    if (menuRatingKey === undefined) return;
    setMenu((current) =>
      current?.ratingKey === menuRatingKey
        ? { ...current, items: current.build(current.navigation) }
        : current,
    );
  }, [menuRatingKey, liveRating]);
  useEffect(() => {
    if (openRequestId === undefined) return undefined;
    focusedItemRef.current = undefined;
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
      // Tab moves focus out of the menu, so the menu closes with it.
      if (event.key === "Tab") {
        close();
        return;
      }
      // Separators are not buttons, so arrow keys and Home/End skip them.
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
    // Scrolling the page moves the anchor away; scrolling a menu that
    // overflows is just reading it.
    // Only movement of the anchor counts. A scroll that began before the menu
    // opened (for example the Tab that scrolled a card into view) can still
    // deliver its event afterwards, and that must not close a fresh menu.
    const onScroll = (event: Event): void => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      const anchor = anchorRef.current;
      if (anchor?.element.isConnected) {
        const rect = anchor.element.getBoundingClientRect();
        if (rect.top === anchor.top && rect.left === anchor.left) return;
      }
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      "button.context-menu-item:not(:disabled)",
    );
    // A caller may already have moved focus into the menu; the first-item focus
    // must not take it back. preventScroll stops this focus from scrolling the
    // page, and that scroll would close the menu.
    if (!menuRef.current?.contains(document.activeElement)) {
      first?.focus({ preventScroll: true });
    }
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [openRequestId]);

  // Rebuilding the items can move a focused button, and the browser then drops
  // its focus. Put focus back on the same item when that happens.
  useLayoutEffect(() => {
    const id = focusedItemRef.current;
    const container = menuRef.current;
    if (!menu || !id || !container) return;
    if (container.contains(document.activeElement)) return;
    container
      .querySelector<HTMLButtonElement>(
        `button.context-menu-item[data-menu-item="${CSS.escape(id)}"]:not(:disabled)`,
      )
      ?.focus({ preventScroll: true });
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
      onFocusIn={(event) => {
        const id = (event.target as HTMLElement).dataset.menuItem;
        if (id) focusedItemRef.current = id;
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {menu.items.map((entry) =>
        isSeparator(entry) ? (
          <div
            key={entry.id}
            className="context-menu-separator"
            role="separator"
          />
        ) : (
          <ContextMenuItem key={entry.id} item={entry} />
        ),
      )}
    </div>
  );
}
