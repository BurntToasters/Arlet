import type { AppleMusicLibraryClient } from "../musickit/library.ts";
import type { CachedPage } from "../library/cache.ts";
import { safeNextPath } from "../musickit/response.ts";
import type { LibraryDetailState, LibraryEntity } from "../state.ts";
import type { ControllerContext } from "./controller-support.ts";
import type { LibraryCacheCoordinator } from "./library-cache-coordinator.ts";

/**
 * Detail request keys kept for stale checks. A newer request for one key
 * replaces its entry; the oldest keys fall out once the map is past this cap.
 */
const DETAIL_REQUEST_LIMIT = 200;

export interface DetailLoadOptions {
  refresh?: boolean;
}

export type DetailKind = "album" | "artist" | "playlist";

export const OFFLINE_MESSAGE =
  "You're offline. Reconnect to load the latest from Apple Music.";

/**
 * Apple's next cursor when it is a relative path in either Apple area a
 * paged read can resolve to: `/v1/me/` (library) or `/v1/catalog/` (a library
 * item enriched through its catalog twin pages catalog paths). Anything else is
 * undefined, which means there are no more pages, so nothing is requested.
 */
export function followableCursor(next: string | undefined): string | undefined {
  return safeNextPath(next, ["/v1/me/", "/v1/catalog/"]);
}

export function detailLabels(kind: DetailKind): {
  read: string;
  write: string;
  load: string;
} {
  return kind === "playlist"
    ? {
        read: "Playlist cache read failed",
        write: "Playlist cache write failed",
        load: "Playlist load failed",
      }
    : {
        read: `Library detail cache read failed (${kind})`,
        write: `Library detail cache write failed (${kind})`,
        load: `Library detail load failed (${kind})`,
      };
}

/** Playlists expose `tracks`; albums expose `tracks`; artists expose `albums`. */
export function detailChildren(
  kind: DetailKind,
  items: LibraryEntity[],
): Partial<LibraryDetailState> {
  return kind === "playlist"
    ? { tracks: items }
    : {
        tracks: kind === "album" ? items : undefined,
        albums: kind === "artist" ? items : undefined,
      };
}

export function cachedDetailPatch(
  kind: DetailKind,
  page: CachedPage<LibraryEntity>,
  error: string | undefined,
): Partial<LibraryDetailState> {
  const items = page.items.slice(1);
  return {
    status: "success",
    source: "cache",
    item: page.items[0],
    resource: page.items[0],
    items,
    ...detailChildren(kind, items),
    next: page.next,
    lastUpdatedAt: page.updatedAt,
    stale: true,
    error,
  };
}

export function createDetailRequests() {
  const requests = new Map<string, number>();
  // Every detail request gets a fresh number. A key can leave the map without
  // its old number being handed out again, so stale continuations stay stale.
  let sequence = 0;
  return {
    begin(requestKey: string): number {
      sequence += 1;
      requests.delete(requestKey);
      requests.set(requestKey, sequence);
      while (requests.size > DETAIL_REQUEST_LIMIT) {
        const oldest = requests.keys().next().value;
        if (oldest === undefined) break;
        requests.delete(oldest);
      }
      return sequence;
    },
    isLatest(requestKey: string, requestId: number): boolean {
      return requests.get(requestKey) === requestId;
    },
    clear(): void {
      requests.clear();
    },
  };
}

export type DetailRequests = ReturnType<typeof createDetailRequests>;

/** Shared dependencies every library loader group receives. */
export interface LibraryLoaderDeps {
  context: ControllerContext;
  cache: LibraryCacheCoordinator;
  getLibraryClient: () => AppleMusicLibraryClient | null;
  requireLibrary: () => AppleMusicLibraryClient;
  requireMusicClient: () => AppleMusicLibraryClient;
  isOffline: () => boolean;
}
