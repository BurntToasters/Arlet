import { useEffect, useState } from "preact/hooks";
import {
  Album,
  Clock3,
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
import type { JSX } from "preact";
import { useAppRouter, useAppState } from "../app/context.tsx";
import { setUiState } from "../state.ts";
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

interface AccountSummaryLike {
  displayName?: string;
  name?: string;
  storefront?: string;
}

function readAccountSummary(
  state: ReturnType<typeof useAppState>,
): AccountSummaryLike | undefined {
  const value = (state as unknown as { account?: unknown }).account;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  return {
    displayName:
      typeof candidate.displayName === "string"
        ? candidate.displayName
        : undefined,
    name: typeof candidate.name === "string" ? candidate.name : undefined,
    storefront:
      typeof candidate.storefront === "string"
        ? candidate.storefront
        : undefined,
  };
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

function resolvePinDisplay(
  state: ReturnType<typeof useAppState>,
  pin: PinnedPlaylist,
): { name?: string; artworkUrl?: string } {
  const candidates = [
    ...(state.library?.collections?.playlists?.items ?? []),
    ...(state.library?.details?.playlistFolder?.items ?? []),
    ...(state.home?.recentPlaylists ?? []),
    ...(state.home?.heavyRotation ?? []),
  ];
  for (const item of candidates) {
    if ((item as { id?: unknown }).id !== pin.id) continue;
    const name = displayNameOf(item);
    if (name) return { name, artworkUrl: artworkUrlOf(item) };
  }
  return {};
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

export function Sidebar(): JSX.Element {
  const state = useAppState();
  const router = useAppRouter();
  const account = readAccountSummary(state);
  const [query, setQuery] = useState(
    state.navigation.kind === "search" ? state.navigation.query : "",
  );

  useEffect(() => {
    if (state.navigation.kind === "search") setQuery(state.navigation.query);
  }, [state.navigation]);

  const navigate = (route: Route): void => {
    router.navigate(route);
    if (state.ui.sidebarOpen) setUiState({ sidebarOpen: false });
  };

  const submitSearch = (event: JSX.TargetedEvent<HTMLFormElement>): void => {
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
  const playlistsStatus = state.library?.collections?.playlists?.status;
  const pinsSettled =
    playlistsStatus === "success" || playlistsStatus === "refreshing";

  const renderPin = (pin: PinnedPlaylist): JSX.Element => {
    const route: Route =
      pin.source === "catalog"
        ? { kind: "playlist", id: pin.id, source: "catalog" }
        : { kind: "playlist", id: pin.id };
    const active = sameRoute(state.navigation, route);
    const display = resolvePinDisplay(state, pin);
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
            <div className="sidebar-group" aria-label="Pinned playlists">
              {pins.map(renderPin)}
            </div>
          </>
        ) : null}
        <div className="sidebar-heading">Library</div>
        <div className="sidebar-group">{libraryItems.map(renderItem)}</div>
      </nav>

      <div className="sidebar-footer">
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
              {state.auth.status === "authorized"
                ? (account?.displayName ?? account?.name ?? "Apple Music")
                : "Sign in"}
            </strong>
            <small>
              {state.auth.status === "authorized"
                ? account?.storefront
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
