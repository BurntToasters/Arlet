import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  Album,
  Clock3,
  Heart,
  History as HistoryIcon,
  House,
  ListMusic,
  Music2,
  Radio,
  Search,
  Settings,
  Sparkles,
  UserRound,
} from "lucide-preact";
import type { LucideIcon } from "lucide-preact";
import type { JSX, TargetedEvent } from "preact";
import { useAppRouter, useAppSlices } from "../app/context.tsx";
import {
  libraryDetailKey,
  setUiState,
  type RuntimeAppState,
} from "../state.ts";
import { openSupportPage } from "../platform/support.ts";
import { reportActionError } from "./action-errors.ts";
import type { PinnedPlaylist } from "../domain/music.ts";
import type { LibrarySection, Route } from "../routing/router.ts";

interface NavItem {
  label: string;
  route: Route;
  icon: LucideIcon;
}

const primaryItems: NavItem[] = [
  { label: "Home", route: { kind: "home" }, icon: House },
  { label: "Browse", route: { kind: "browse" }, icon: Sparkles },
  { label: "Radio", route: { kind: "radio" }, icon: Radio },
];

const libraryItems: Array<
  NavItem & { route: { kind: "library"; section: LibrarySection } }
> = [
  {
    label: "Recently Added",
    route: { kind: "library", section: "recent" },
    icon: Clock3,
  },
  {
    label: "Recently Played",
    route: { kind: "library", section: "history" },
    icon: HistoryIcon,
  },
  {
    label: "Artists",
    route: { kind: "library", section: "artists" },
    icon: UserRound,
  },
  {
    label: "Albums",
    route: { kind: "library", section: "albums" },
    icon: Album,
  },
  {
    label: "Songs",
    route: { kind: "library", section: "songs" },
    icon: Music2,
  },
  {
    label: "Playlists",
    route: { kind: "library", section: "playlists" },
    icon: ListMusic,
  },
];

function sameRoute(left: Route, right: Route): boolean {
  if (
    (left.kind === "new" && right.kind === "browse") ||
    (left.kind === "browse" && right.kind === "new")
  ) {
    return true;
  }
  if (left.kind !== right.kind) return false;
  if (left.kind === "search" && right.kind === "search") {
    return left.query === right.query;
  }
  if (left.kind === "library" && right.kind === "library") {
    return left.section === right.section;
  }
  if (
    (left.kind === "album" ||
      left.kind === "artist" ||
      left.kind === "playlist") &&
    right.kind === left.kind
  ) {
    return (
      left.id === right.id &&
      (left.source ?? "library") === (right.source ?? "library")
    );
  }
  return true;
}

function displayNameOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const direct = record.name ?? record.title;
  if (typeof direct === "string" && direct.trim().length > 0) return direct;
  const attributes = record.attributes;
  if (attributes && typeof attributes === "object") {
    const name = (attributes as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim().length > 0) return name;
  }
  return undefined;
}

function artworkUrlOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const artwork = record.artwork;
  if (artwork && typeof artwork === "object") {
    const url = (artwork as Record<string, unknown>).url;
    if (typeof url === "string" && url.trim().length > 0) return url;
  }
  const attributes = record.attributes;
  if (attributes && typeof attributes === "object") {
    const nested = (attributes as Record<string, unknown>).artwork;
    if (nested && typeof nested === "object") {
      const url = (nested as Record<string, unknown>).url;
      if (typeof url === "string" && url.trim().length > 0) return url;
    }
  }
  return undefined;
}

/** Playlists by id, in lookup priority order, built once per state change. */
function playlistIndex(
  sources: readonly (readonly unknown[] | undefined)[],
): Map<string, unknown[]> {
  const index = new Map<string, unknown[]>();
  for (const items of sources) {
    for (const item of items ?? []) {
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string") continue;
      const list = index.get(id);
      if (list) list.push(item);
      else index.set(id, [item]);
    }
  }
  return index;
}

function resolvePinDisplay(
  state: Pick<RuntimeAppState, "library">,
  index: Map<string, unknown[]>,
  pin: PinnedPlaylist,
): { name?: string; artworkUrl?: string } {
  // A pinned playlist that is open but not in the loaded list still has a name.
  const opened = (
    state.library?.details?.playlist as Record<string, unknown> | undefined
  )?.[libraryDetailKey(pin.id, pin.source)] as { item?: unknown } | undefined;
  const candidates = [
    ...(opened?.item ? [opened.item] : []),
    ...(index.get(pin.id) ?? []),
  ];
  for (const item of candidates) {
    // An item that names its source must match the pin's source.
    const source = (item as { source?: unknown }).source;
    if (source !== undefined && source !== pin.source) continue;
    const name = displayNameOf(item);
    if (name) return { name, artworkUrl: artworkUrlOf(item) ?? pin.artworkUrl };
  }
  // Saved with the pin, so a playlist outside the loaded list keeps its name.
  return pin.name ? { name: pin.name, artworkUrl: pin.artworkUrl } : {};
}

function renderPinIcon(artworkUrl?: string): JSX.Element {
  if (artworkUrl) {
    return (
      <img
        className="sidebar-pin-art"
        src={artworkUrl}
        alt=""
        aria-hidden="true"
        loading="lazy"
        draggable={false}
      />
    );
  }
  return <ListMusic aria-hidden="true" size={18} strokeWidth={1.8} />;
}

// Matches the breakpoint in 13-responsive.css, where the sidebar is a drawer.
const compactQuery = "(max-width: 720px)";

/** Read live at each use, so focus and keys follow the rendered layout. */
function isCompactShell(): boolean {
  return window.matchMedia(compactQuery).matches;
}

/** Re-renders when the breakpoint changes; the value itself is not cached. */
function useCompactShell(): boolean {
  const [compact, setCompact] = useState(
    () => window.matchMedia(compactQuery).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(compactQuery);
    const sync = (): void => setCompact(query.matches);
    query.addEventListener("change", sync);
    sync();
    return () => query.removeEventListener("change", sync);
  }, []);
  return compact;
}

/** Enabled buttons and inputs in the drawer, in tab order. */
function drawerControls(drawer: HTMLElement | null): HTMLElement[] {
  return Array.from(
    drawer?.querySelectorAll<HTMLElement>("button, input") ?? [],
  ).filter((node) => !node.matches(":disabled, [aria-disabled='true']"));
}

export function Sidebar(): JSX.Element {
  const state = useAppSlices(
    "account",
    "auth",
    "home",
    "library",
    "navigation",
    "pins",
    "ui",
  );
  const router = useAppRouter();
  const account = state.account;
  const [query, setQuery] = useState(
    state.navigation.kind === "search" ? state.navigation.query : "",
  );
  const drawerRef = useRef<HTMLElement>(null);
  // Only a re-render trigger; the checks below read the live breakpoint.
  const compactShell = useCompactShell();
  const drawerOpen = state.ui.sidebarOpen;
  const drawerWasOpen = useRef(drawerOpen);

  useEffect(() => {
    if (state.navigation.kind === "search") setQuery(state.navigation.query);
  }, [state.navigation]);

  // Layout effects run in the same commit as the open class, so the drawer is
  // already focusable (not inert) when focus and key handling are set up.
  // A closed compact drawer is inert: off-screen, but kept out of Tab order.
  useLayoutEffect(() => {
    if (drawerRef.current) {
      drawerRef.current.inert = isCompactShell() && !drawerOpen;
    }
  }, [compactShell, drawerOpen]);

  // Opening the drawer moves focus into it. Closing it returns focus to the
  // menu button, unless focus already went somewhere else (such as the page
  // heading after a route change).
  useLayoutEffect(() => {
    const wasOpen = drawerWasOpen.current;
    drawerWasOpen.current = drawerOpen;
    if (!isCompactShell() || wasOpen === drawerOpen) return;
    if (drawerOpen) {
      drawerRef.current?.querySelector<HTMLElement>(".sidebar-link")?.focus();
      return;
    }
    const active = document.activeElement;
    if (
      !active ||
      active === document.body ||
      drawerRef.current?.contains(active)
    ) {
      document.querySelector<HTMLElement>(".mobile-menu-button")?.focus();
    }
  }, [compactShell, drawerOpen]);

  // While the drawer is open it is modal: Esc closes it and Tab cycles inside.
  useLayoutEffect(() => {
    if (!drawerOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      const drawer = drawerRef.current;
      if (event.defaultPrevented || !drawer || !isCompactShell()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setUiState({ sidebarOpen: false });
        document.querySelector<HTMLElement>(".mobile-menu-button")?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = drawerControls(drawer);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      const inside = active instanceof Node && drawer.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [compactShell, drawerOpen]);

  const navigate = (route: Route): void => {
    router.navigate(route);
    if (state.ui.sidebarOpen) setUiState({ sidebarOpen: false });
  };

  const submitSearch = (event: TargetedEvent<HTMLFormElement>): void => {
    event.preventDefault();
    navigate({ kind: "search", query: query.trim() });
  };

  const renderItem = (item: NavItem): JSX.Element => {
    const Icon = item.icon;
    return (
      <button
        className={`sidebar-link ${sameRoute(state.navigation, item.route) ? "is-active" : ""}`.trim()}
        type="button"
        aria-label={item.label}
        title={item.label}
        aria-current={
          sameRoute(state.navigation, item.route) ? "page" : undefined
        }
        onClick={() => navigate(item.route)}
      >
        <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
        <span>{item.label}</span>
      </button>
    );
  };

  const pins = state.pins ?? [];
  const playlistItems = state.library?.collections?.playlists?.items;
  const folderItems = state.library?.details?.playlistFolder?.items;
  const recentPlaylists = state.home?.recentPlaylists;
  const heavyRotation = state.home?.heavyRotation;
  const pinIndex = useMemo(
    () =>
      playlistIndex([
        playlistItems,
        folderItems,
        recentPlaylists,
        heavyRotation,
      ]),
    [playlistItems, folderItems, recentPlaylists, heavyRotation],
  );
  const playlistsStatus = state.library?.collections?.playlists?.status;
  const pinsSettled =
    playlistsStatus === "success" || playlistsStatus === "refreshing";

  const renderPin = (pin: PinnedPlaylist): JSX.Element => {
    const route: Route =
      pin.source === "catalog"
        ? { kind: "playlist", id: pin.id, source: "catalog" }
        : { kind: "playlist", id: pin.id };
    const active = sameRoute(state.navigation, route);
    const display = resolvePinDisplay(state, pinIndex, pin);
    const name = display.name;
    if (name) {
      return (
        <button
          key={`${pin.source}:${pin.id}`}
          className={`sidebar-link ${active ? "is-active" : ""}`.trim()}
          type="button"
          aria-label={name}
          title={name}
          aria-current={active ? "page" : undefined}
          data-context-kind="playlist"
          data-context-id={pin.id}
          data-context-route-kind="playlist"
          data-context-source={pin.source}
          onClick={() => navigate(route)}
        >
          {renderPinIcon(display.artworkUrl)}
          <span>{name}</span>
        </button>
      );
    }
    if (!pinsSettled) {
      return (
        <button
          key={`${pin.source}:${pin.id}`}
          className="sidebar-link"
          type="button"
          aria-label="Pinned playlist"
          title="Pinned playlist"
          style={{ opacity: 0.55 }}
          data-context-kind="playlist"
          data-context-id={pin.id}
          data-context-route-kind="playlist"
          data-context-source={pin.source}
          onClick={() => navigate(route)}
        >
          <ListMusic aria-hidden="true" size={18} strokeWidth={1.8} />
          <span>Playlist</span>
        </button>
      );
    }
    return (
      <button
        key={`${pin.source}:${pin.id}`}
        className="sidebar-link"
        type="button"
        aria-label="Unknown playlist"
        title="Unknown playlist"
        aria-disabled="true"
        style={{ opacity: 0.55 }}
        data-context-kind="playlist"
        data-context-id={pin.id}
        data-context-route-kind="playlist"
        data-context-source={pin.source}
      >
        <ListMusic aria-hidden="true" size={18} strokeWidth={1.8} />
        <span>Unknown playlist</span>
      </button>
    );
  };

  return (
    <aside
      ref={drawerRef}
      className={`sidebar ${state.ui.sidebarOpen ? "is-open" : ""}`.trim()}
      aria-label="Main navigation"
    >
      <form className="sidebar-search" role="search" onSubmit={submitSearch}>
        <Search aria-hidden="true" size={17} strokeWidth={1.8} />
        <input
          aria-label="Search Apple Music"
          type="search"
          value={query}
          placeholder="Search"
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <kbd>Ctrl K</kbd>
      </form>

      <nav className="sidebar-nav" aria-label="Library navigation">
        <div className="sidebar-group">{primaryItems.map(renderItem)}</div>
        {pins.length > 0 ? (
          <>
            <div className="sidebar-heading">Pinned</div>
            <div
              className="sidebar-group"
              role="group"
              aria-label="Pinned playlists"
            >
              {pins.map(renderPin)}
            </div>
          </>
        ) : null}
        <div className="sidebar-heading">Library</div>
        <div className="sidebar-group">{libraryItems.map(renderItem)}</div>
      </nav>

      <div className="sidebar-footer">
        <button
          className="sidebar-link sidebar-support"
          type="button"
          aria-label="Support me (opens rosie.run/support in your browser)"
          title="Support me"
          onClick={() => void openSupportPage().catch(reportActionError)}
        >
          <Heart aria-hidden="true" size={18} strokeWidth={1.8} />
          <span>Support Me</span>
        </button>
        <button
          className={`sidebar-link ${state.navigation.kind === "settings" ? "is-active" : ""}`.trim()}
          type="button"
          aria-label="Settings"
          title="Settings"
          aria-current={
            state.navigation.kind === "settings" ? "page" : undefined
          }
          onClick={() => navigate({ kind: "settings" })}
        >
          <Settings aria-hidden="true" size={18} strokeWidth={1.8} />
          <span>Settings</span>
        </button>
        <button
          className="account-link"
          type="button"
          aria-label={
            state.auth.status === "authorized"
              ? "Apple Music account"
              : "Sign in to Apple Music"
          }
          title={
            state.auth.status === "authorized"
              ? "Apple Music account"
              : "Sign in to Apple Music"
          }
          onClick={() => navigate({ kind: "settings" })}
        >
          <span className="account-avatar" aria-hidden="true">
            <UserRound size={16} strokeWidth={1.8} />
          </span>
          <span className="account-copy">
            <strong>
              {state.auth.status === "authorized" ? "Apple Music" : "Sign in"}
            </strong>
            <small>
              {state.auth.status === "authorized"
                ? account.storefront
                  ? `${account.storefront} · Connected`
                  : "Connected"
                : "Connect account"}
            </small>
          </span>
        </button>
      </div>
    </aside>
  );
}
