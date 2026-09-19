import {
  Album,
  Clock3,
  Disc3,
  ListMusic,
  Music2,
  Radio,
  Sparkles,
  UserRound,
} from "lucide-preact";
import type { JSX } from "preact";
import type { Route } from "../routing/router.ts";
import { EmptyState } from "./EmptyState.tsx";

interface PlaceholderCopy {
  eyebrow: string;
  title: string;
  description: string;
  icon: typeof Radio;
}

function copyForRoute(
  route: Exclude<
    Route,
    { kind: "home" } | { kind: "search" } | { kind: "settings" }
  >,
): PlaceholderCopy {
  switch (route.kind) {
    case "new":
    case "browse":
      return {
        eyebrow: "Discover",
        title: "New music",
        description:
          "Curated releases will appear here when the catalog view is connected.",
        icon: Sparkles,
      };
    case "radio":
      return {
        eyebrow: "Listen live",
        title: "Radio",
        description:
          "Stations and live programming will appear here in a future catalog pass.",
        icon: Radio,
      };
    case "library":
      switch (route.section) {
        case "recent":
          return {
            eyebrow: "Library",
            title: "Recently Added",
            description:
              "Your recently added music will appear here after the library service is connected.",
            icon: Clock3,
          };
        case "artists":
          return {
            eyebrow: "Library",
            title: "Artists",
            description:
              "Artists from your Apple Music library will appear here.",
            icon: UserRound,
          };
        case "albums":
          return {
            eyebrow: "Library",
            title: "Albums",
            description:
              "Albums from your Apple Music library will appear here.",
            icon: Album,
          };
        case "songs":
          return {
            eyebrow: "Library",
            title: "Songs",
            description:
              "Songs from your Apple Music library will appear here.",
            icon: Music2,
          };
        case "playlists":
          return {
            eyebrow: "Library",
            title: "Playlists",
            description:
              "Your playlists will appear here after the library service is connected.",
            icon: ListMusic,
          };
      }
      return {
        eyebrow: "Library",
        title: "Library",
        description: "Your Apple Music library will appear here.",
        icon: Music2,
      };
    case "album":
      return {
        eyebrow: "Album",
        title: "Album details",
        description: `Album ${route.id} is ready for a catalog detail view.`,
        icon: Disc3,
      };
    case "artist":
      return {
        eyebrow: "Artist",
        title: "Artist details",
        description: `Artist ${route.id} is ready for a catalog detail view.`,
        icon: UserRound,
      };
    case "playlist":
      return {
        eyebrow: "Playlist",
        title: "Playlist details",
        description: `Playlist ${route.id} is ready for a catalog detail view.`,
        icon: ListMusic,
      };
  }
}

export function PlaceholderView({
  route,
}: {
  route: Exclude<
    Route,
    { kind: "home" } | { kind: "search" } | { kind: "settings" }
  >;
}): JSX.Element {
  const copy = copyForRoute(route);
  const Icon = copy.icon;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{copy.eyebrow}</span>
          <h1 tabIndex={-1}>{copy.title}</h1>
        </div>
      </div>
      <EmptyState
        icon={Icon}
        title="This view is coming together"
        description={copy.description}
      />
    </>
  );
}
