import { useEffect, useRef } from "preact/hooks";
import type { JSX } from "preact";
import type { Route } from "../routing/router.ts";
import { serializeRoute } from "../routing/router.ts";
import { HomeView } from "./HomeView.tsx";
import { PlaceholderView } from "./PlaceholderView.tsx";
import { SearchView } from "./SearchView.tsx";
import { SettingsView } from "./SettingsView.tsx";
import { LibraryView } from "./LibraryView.tsx";
import { LibraryDetailView } from "./LibraryDetailView.tsx";
import { BrowseView } from "./BrowseView.tsx";
import { RadioView } from "./RadioView.tsx";
import { useOptionalAppController } from "../app/context.tsx";

type DetailSource = "library" | "catalog";

function routeSource(route: Route): DetailSource | undefined {
  const source = (route as Route & { source?: unknown }).source;
  return source === "library" || source === "catalog" ? source : undefined;
}

export function RouteView({ route }: { route: Route }): JSX.Element {
  const page = useRef<HTMLElement>(null);
  const hasAppProvider = Boolean(useOptionalAppController());
  const hasMounted = useRef(false);
  const routeKey = serializeRoute(route);

  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    const heading = page.current?.querySelector<HTMLElement>("h1");
    heading?.focus();
  }, [routeKey]);

  const view = (() => {
    switch (route.kind) {
      case "home":
        return <HomeView />;
      case "browse":
        return hasAppProvider ? (
          <BrowseView />
        ) : (
          <PlaceholderView route={route} />
        );
      case "new":
        // Keep legacy direct callers renderable outside AppProvider while
        // sending old URLs through the replacement Browse experience.
        return hasAppProvider ? (
          <BrowseView />
        ) : (
          <PlaceholderView route={route} />
        );
      case "radio":
        return hasAppProvider ? (
          <RadioView />
        ) : (
          <PlaceholderView route={route} />
        );
      case "search":
        return <SearchView />;
      case "settings":
        return <SettingsView />;
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
      <div className="content-scroll">{view}</div>
    </main>
  );
}
