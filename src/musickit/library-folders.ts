/**
 * Playlist folder reads, and playlist and folder creation, for the Apple
 * library client. Folder trees load their children in parallel, capped per
 * client.
 */
import {
  asRecord,
  findNextValue,
  findResourceArray,
  safeNextPath,
} from "./response.ts";
import {
  APPLE_PAGE_PREFIXES,
  encodePathPart,
  firstResource,
  mutationOptions,
  nonEmptyString,
  resourceLike,
  type MusicRequest,
} from "./library-pages.ts";
import { normalizedRefs } from "./library-mutations.ts";
import {
  normalizeLibraryItemResource,
  normalizePlaylistFolderResource,
  normalizePlaylistResource,
  type AppleMusicResource,
} from "./normalize.ts";
import type {
  LibraryItem,
  MusicResourceRef,
  Playlist,
  PlaylistFolder,
} from "../domain/music.ts";

export interface CreatePlaylistInput {
  name: string;
  description?: string;
  isPublic?: boolean;
  parentFolderId?: string;
  /** Alias accepted for callers that use the API's parent terminology. */
  parentId?: string;
  tracks?: readonly MusicResourceRef[];
}

export interface CreatePlaylistFolderInput {
  name: string;
  parentFolderId?: string;
  /** Alias accepted for callers that use the API's parent terminology. */
  parentId?: string;
}

export type PlaylistCreationInput = CreatePlaylistInput;
export type PlaylistFolderCreationInput = CreatePlaylistFolderInput;

function isPlaylistFolderResource(
  value: AppleMusicResource | undefined,
): value is AppleMusicResource {
  const type = nonEmptyString(asRecord(value)?.type);
  return type === "library-playlist-folders" || type === "playlist-folders";
}

function findResourceDeep(
  value: unknown,
  depth = 0,
): AppleMusicResource | undefined {
  if (depth > 10) return undefined;
  if (resourceLike(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findResourceDeep(entry, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const entry of Object.values(record)) {
    const found = findResourceDeep(entry, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** 100 children per page; 50 pages is far beyond any real folder. */
const MAX_FOLDER_PAGES = 50;

function requiredName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Playlist name is required.");
  return name;
}

function appendParentRelationship(
  relationships: Record<string, unknown>,
  parentId: string | undefined,
): void {
  if (!parentId?.trim()) return;
  relationships.parent = {
    data: [
      {
        id: parentId.trim(),
        type: "library-playlist-folders",
      },
    ],
  };
}

const FOLDER_REQUEST_CONCURRENCY = 4;

/** Runs at most `limit` tasks at once, the rest in call order. */
function createRequestLimiter(
  limit: number,
): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    // A finished task hands its slot straight to the next waiter.
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

export function createFolderMethods(request: MusicRequest) {
  // Sibling folders load in parallel; this caps the requests in flight.
  // Only network calls take a slot, so a parent waiting on its children
  // never holds one.
  const folderRequests = createRequestLimiter(FOLDER_REQUEST_CONCURRENCY);

  async function folderChildren(
    folderId: string,
    visited: Set<string>,
  ): Promise<LibraryItem[]> {
    const children: LibraryItem[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      pages += 1;
      const pageCursor = cursor;
      const raw = await folderRequests(() =>
        pageCursor
          ? request(pageCursor)
          : request(
              `/v1/me/library/playlist-folders/${encodePathPart(folderId)}/children`,
              { limit: 100 },
            ),
      );
      const resources = findResourceArray(raw) ?? [];
      const pageChildren = await Promise.all(
        resources.map(async (value): Promise<LibraryItem | undefined> => {
          const resource = asRecord(value) as AppleMusicResource | undefined;
          if (!resource) return undefined;
          const item = normalizeLibraryItemResource(resource);
          if (!item) return undefined;
          if (item.resourceType?.includes("playlist-folder")) {
            return hydrateFolder(item as PlaylistFolder, folderId, visited);
          }
          return { ...item, parentId: folderId } as LibraryItem;
        }),
      );
      for (const child of pageChildren) if (child) children.push(child);
      cursor = safeNextPath(findNextValue(raw), APPLE_PAGE_PREFIXES);
      // A repeated or endless cursor must not hang the folder tree.
      if (cursor && seenCursors.has(cursor)) break;
      if (cursor) seenCursors.add(cursor);
    } while (cursor && pages < MAX_FOLDER_PAGES);
    return children;
  }

  async function hydrateFolder(
    folder: PlaylistFolder,
    parentId: string | undefined,
    visited: Set<string>,
  ): Promise<PlaylistFolder> {
    const hydrated: PlaylistFolder = {
      ...folder,
      ...(parentId ? { parentId } : {}),
    };
    if (visited.has(folder.id)) return { ...hydrated, children: [] };
    visited.add(folder.id);
    hydrated.children = await folderChildren(folder.id, visited);
    return hydrated;
  }

  async function getFolder(
    id: string,
    raw?: unknown,
  ): Promise<PlaylistFolder | undefined> {
    const response =
      raw ??
      (await request(`/v1/me/library/playlist-folders/${encodePathPart(id)}`));
    const resource = firstResource(response) ?? findResourceDeep(response);
    const folder = isPlaylistFolderResource(resource)
      ? normalizePlaylistFolderResource(resource)
      : undefined;
    return folder ? hydrateFolder(folder, undefined, new Set()) : undefined;
  }

  return {
    async getRootPlaylistFolder(): Promise<PlaylistFolder | undefined> {
      const raw = await request("/v1/me/library/playlist-folders", {
        "filter[identity]": "playlistsroot",
        limit: 1,
      });
      const resource = firstResource(raw) ?? findResourceDeep(raw);
      const folder = isPlaylistFolderResource(resource)
        ? normalizePlaylistFolderResource(resource)
        : undefined;
      return folder ? hydrateFolder(folder, undefined, new Set()) : undefined;
    },
    getPlaylistFolder: (id: string) => getFolder(id),

    async createPlaylist(
      input: CreatePlaylistInput | string,
      legacyDescription?: string,
    ): Promise<Playlist> {
      const normalizedInput: CreatePlaylistInput =
        typeof input === "string"
          ? { name: input, description: legacyDescription }
          : input;
      const attributes: Record<string, unknown> = {
        name: requiredName(normalizedInput.name),
      };
      if (normalizedInput.description !== undefined) {
        attributes.description = normalizedInput.description;
      }
      if (normalizedInput.isPublic !== undefined) {
        attributes.isPublic = normalizedInput.isPublic;
      }
      const relationships: Record<string, unknown> = {};
      appendParentRelationship(
        relationships,
        normalizedInput.parentFolderId ?? normalizedInput.parentId,
      );
      if (normalizedInput.tracks && normalizedInput.tracks.length > 0) {
        relationships.tracks = { data: normalizedRefs(normalizedInput.tracks) };
      }
      const body: Record<string, unknown> = { attributes };
      if (Object.keys(relationships).length > 0)
        body.relationships = relationships;
      const raw = await request(
        "/v1/me/library/playlists",
        undefined,
        mutationOptions("POST", body),
      );
      const resource = firstResource(raw);
      const playlist = resource
        ? normalizePlaylistResource(resource)
        : undefined;
      if (!playlist) throw new Error("Apple Music returned no playlist.");
      return playlist;
    },
    async createPlaylistFolder(
      input: CreatePlaylistFolderInput | string,
    ): Promise<PlaylistFolder> {
      const normalizedInput: CreatePlaylistFolderInput =
        typeof input === "string" ? { name: input } : input;
      const body: Record<string, unknown> = {
        attributes: { name: requiredName(normalizedInput.name) },
      };
      const relationships: Record<string, unknown> = {};
      appendParentRelationship(
        relationships,
        normalizedInput.parentFolderId ?? normalizedInput.parentId,
      );
      if (Object.keys(relationships).length > 0)
        body.relationships = relationships;
      const raw = await request(
        "/v1/me/library/playlist-folders",
        undefined,
        mutationOptions("POST", body),
      );
      const resource = firstResource(raw);
      const folder = resource
        ? normalizePlaylistFolderResource(resource)
        : undefined;
      if (!folder) throw new Error("Apple Music returned no playlist folder.");
      return folder;
    },
  };
}
