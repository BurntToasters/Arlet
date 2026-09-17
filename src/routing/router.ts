export type LibrarySection =
  "recent" | "history" | "artists" | "albums" | "songs" | "playlists";

export type Route =
  | { kind: "home" }
  | { kind: "new" }
  | { kind: "radio" }
  | { kind: "search"; query: string }
  | { kind: "library"; section: LibrarySection }
  | { kind: "album"; id: string }
  | { kind: "artist"; id: string }
  | { kind: "playlist"; id: string }
  | { kind: "settings" };

const librarySections = new Set<LibrarySection>([
  "recent",
  "history",
  "artists",
  "albums",
  "songs",
  "playlists",
]);

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

export function parseRoute(hash: string): Route {
  const normalized = hash.trim().replace(/^#/, "");
  const [pathPart, queryPart = ""] = normalized.split("?", 2);
  const segments = pathPart.split("/").filter(Boolean).map(decode);
  const head = segments[0] ?? "home";

  if (head === "search") {
    const params = new URLSearchParams(queryPart);
    return { kind: "search", query: params.get("q")?.trim() ?? "" };
  }
  if (
    head === "library" &&
    librarySections.has(segments[1] as LibrarySection)
  ) {
    return { kind: "library", section: segments[1] as LibrarySection };
  }
  if (
    (head === "album" || head === "artist" || head === "playlist") &&
    segments[1]
  ) {
    return { kind: head, id: segments[1] };
  }
  if (head === "new") return { kind: "new" };
  if (head === "radio") return { kind: "radio" };
  if (head === "settings") return { kind: "settings" };
  return { kind: "home" };
}

export function serializeRoute(route: Route): string {
  switch (route.kind) {
    case "home":
      return "#/home";
    case "new":
      return "#/new";
    case "radio":
      return "#/radio";
    case "search": {
      const query = route.query.trim();
      return query ? `#/search?q=${encode(query)}` : "#/search";
    }
    case "library":
      return `#/library/${encode(route.section)}`;
    case "album":
    case "artist":
    case "playlist":
      return `#/${route.kind}/${encode(route.id)}`;
    case "settings":
      return "#/settings";
  }
}

export function routeToHash(route: Route): string {
  return serializeRoute(route);
}

export function hashToRoute(hash: string): Route {
  return parseRoute(hash);
}

export interface HashRouter {
  getRoute(): Route;
  navigate(route: Route, replace?: boolean): void;
  back(): void;
  forward(): void;
  subscribe(listener: (route: Route) => void): () => void;
  start(): () => void;
}

export function createHashRouter(
  target: Pick<
    Window,
    "location" | "history" | "addEventListener" | "removeEventListener"
  > = window,
): HashRouter {
  let current = parseRoute(target.location.hash);
  const listeners = new Set<(route: Route) => void>();

  const emit = (): void => {
    current = parseRoute(target.location.hash);
    for (const listener of listeners) listener(current);
  };

  const onHashChange = (): void => emit();

  return {
    getRoute: () => current,
    navigate(route, replace = false) {
      const hash = serializeRoute(route);
      if (replace) {
        target.history.replaceState(null, "", hash);
        emit();
      } else if (target.location.hash !== hash) {
        target.location.hash = hash;
      }
    },
    back: () => target.history.back(),
    forward: () => target.history.forward(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      target.addEventListener("hashchange", onHashChange);
      if (!target.location.hash) {
        target.history.replaceState(null, "", serializeRoute(current));
      }
      emit();
      return () => target.removeEventListener("hashchange", onHashChange);
    },
  };
}
