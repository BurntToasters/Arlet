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

export function RouteView({ route }: { route: Route }): JSX.Element {
  const page = useRef<HTMLElement>(null);
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
      case "search":
        return <SearchView />;
      case "settings":
        return <SettingsView />;
      case "library":
        return <LibraryView section={route.section} />;
      case "album":
        return <LibraryDetailView kind="album" id={route.id} />;
      case "artist":
        return <LibraryDetailView kind="artist" id={route.id} />;
      case "playlist":
        return <LibraryDetailView kind="playlist" id={route.id} />;
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
