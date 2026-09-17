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
import type { LibrarySection, Route } from "../routing/router.ts";

interface NavItem {
  label: string;
  route: Route;
  icon: LucideIcon;
}

const primaryItems: NavItem[] = [
  { label: "Home", route: { kind: "home" }, icon: House },
  { label: "New", route: { kind: "new" }, icon: Sparkles },
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
    return left.id === right.id;
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
