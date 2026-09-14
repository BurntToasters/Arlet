import { useEffect, useRef } from "preact/hooks";
import type { JSX } from "preact";
import type { Route } from "../routing/router.ts";
import { serializeRoute } from "../routing/router.ts";
import { HomeView } from "./HomeView.tsx";
import { PlaceholderView } from "./PlaceholderView.tsx";
import { SearchView } from "./SearchView.tsx";
import { SettingsView } from "./SettingsView.tsx";

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
