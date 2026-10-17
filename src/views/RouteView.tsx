import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { AlertCircle } from "lucide-preact";
import type { Route } from "../routing/router.ts";
import { serializeRoute } from "../routing/router.ts";
import { HomeView } from "./HomeView.tsx";
import { PlaceholderView } from "./PlaceholderView.tsx";
import { SearchView } from "./SearchView.tsx";
import { LibraryView } from "./LibraryView.tsx";
import { LibraryDetailView } from "./LibraryDetailView.tsx";
import { useOptionalAppController } from "../app/context.tsx";
import { safeErrorMessage } from "../app/controller-support.ts";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { lazyView } from "../components/lazy.tsx";
import {
  SkeletonCardGrid,
  SkeletonRows,
  SkeletonStatus,
} from "../components/Skeleton.tsx";
import { EmptyState } from "./EmptyState.tsx";

type DetailSource = "library" | "catalog";

// Rarely opened surfaces load their chunk on first visit, keeping the entry
// bundle small. Each keeps its skeleton while loading and its error boundary.
const SettingsRoute = lazyView(
  () => import("./SettingsView.tsx").then((module) => module.SettingsView),
  {
    name: "Settings",
    loading: () => (
      <SkeletonStatus label="Loading Settings…">
        <SkeletonRows count={6} />
      </SkeletonStatus>
    ),
  },
);
const CuratorRoute = lazyView(
  () => import("./CuratorView.tsx").then((module) => module.CuratorView),
  {
    name: "Curator",
    loading: () => (
      <SkeletonStatus label="Loading curator…">
        <SkeletonCardGrid count={6} />
      </SkeletonStatus>
    ),
  },
);
const BrowseRoute = lazyView(
  () => import("./BrowseView.tsx").then((module) => module.BrowseView),
  {
    name: "Browse",
    loading: () => (
      <SkeletonStatus label="Loading Browse…">
        <SkeletonRows count={6} />
      </SkeletonStatus>
    ),
  },
);
const RadioRoute = lazyView(
  () => import("./RadioView.tsx").then((module) => module.RadioView),
  {
    name: "Radio",
    loading: () => (
      <SkeletonStatus label="Loading Radio…">
        <SkeletonCardGrid count={6} />
      </SkeletonStatus>
    ),
  },
);

function routeSource(route: Route): DetailSource | undefined {
  const source = (route as Route & { source?: unknown }).source;
  return source === "library" || source === "catalog" ? source : undefined;
}

export function RouteView({ route }: { route: Route }): JSX.Element {
  const page = useRef<HTMLElement>(null);
  const controller = useOptionalAppController();
  const hasAppProvider = Boolean(controller);
  const hasMounted = useRef(false);
  const focusPending = useRef(false);
  const [loadedCount, setLoadedCount] = useState(0);
  const routeKey = serializeRoute(route);
  const onViewReady = (): void => setLoadedCount((count) => count + 1);

  const focusPage = (): void => {
    // A shortcut such as Ctrl+K may already have focused a field on the new page.
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      page.current?.contains(active) &&
      active.matches("input, textarea, select")
    ) {
      return;
    }
    // Signed-out, loading and error states have no h1, so they fall back to
    // the EmptyState heading and then to the page itself.
    const target =
      page.current?.querySelector<HTMLElement>("h1") ??
      page.current?.querySelector<HTMLElement>(".empty-state h2") ??
      page.current;
    target?.focus();
  };

  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    focusPending.current = true;
    focusPage();
  }, [routeKey]);

  // A lazy view renders after the navigation focus, so its h1 is focused once
  // it loads. Initial load never sets focusPending, so startup keeps focus.
  useEffect(() => {
    if (focusPending.current && loadedCount > 0) focusPage();
  }, [loadedCount]);

  const view = (() => {
    switch (route.kind) {
      case "home":
        return <HomeView />;
      case "browse":
        return hasAppProvider ? (
          <BrowseRoute onReady={onViewReady} />
        ) : (
          <PlaceholderView route={route} />
        );
      case "new":
        // Keep legacy direct callers renderable outside AppProvider while
        // sending old URLs through the replacement Browse experience.
        return hasAppProvider ? (
          <BrowseRoute onReady={onViewReady} />
        ) : (
          <PlaceholderView route={route} />
        );
      case "radio":
        return hasAppProvider ? (
          <RadioRoute onReady={onViewReady} />
        ) : (
          <PlaceholderView route={route} />
        );
      case "search":
        return <SearchView />;
      case "curator":
        return (
          <CuratorRoute
            id={route.id}
            kind={route.curatorKind}
            onReady={onViewReady}
          />
        );
      case "settings":
        return <SettingsRoute onReady={onViewReady} />;
      case "library":
        return <LibraryView section={route.section} />;
      case "album":
        return (
          <LibraryDetailView
            kind="album"
            id={route.id}
            source={routeSource(route)}
          />
        );
      case "artist":
        return (
          <LibraryDetailView
            kind="artist"
            id={route.id}
            source={routeSource(route)}
          />
        );
      case "playlist":
        return (
          <LibraryDetailView
            kind="playlist"
            id={route.id}
            source={routeSource(route)}
          />
        );
      default:
        return <PlaceholderView route={route} />;
    }
  })();

  return (
    <main
      ref={page}
      className="content-area"
      data-route={route.kind}
      tabIndex={-1}
    >
      <div className="content-scroll">
        {/* Keyed by route: navigating away always clears a failed page. */}
        <ErrorBoundary
          key={routeKey}
          onError={(error) => {
            const message = `Page failed to render (${route.kind}): ${safeErrorMessage(error)}`;
            if (controller) controller.log(message);
            else console.error(message);
          }}
          fallback={(retry) => (
            <EmptyState
              icon={AlertCircle}
              title="This page couldn't be shown"
              description="Something went wrong while showing it. The rest of Arlet still works; try again or go to another page."
              action={
                <button
                  className="secondary-button"
                  type="button"
                  onClick={retry}
                >
                  Try again
                </button>
              }
            />
          )}
        >
          {view}
        </ErrorBoundary>
      </div>
    </main>
  );
}
