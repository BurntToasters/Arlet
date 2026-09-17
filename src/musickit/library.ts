import { resolveMusicKitMusicRequest } from "./catalog.ts";
import {
  normalizeAlbumResource,
  normalizeArtistResource,
  normalizeLibraryItemResource,
  normalizeMusicResourceRef,
  normalizePlaylistFolderResource,
  normalizePlaylistResource,
  normalizeTrackResource,
  type AppleMusicResource,
} from "./normalize.ts";
import type {
  Album,
  Artist,
  LibraryItem,
  MusicResourceRef,
  Playlist,
  PlaylistFolder,
  Track,
} from "../domain/music.ts";

export interface Page<T> {
  items: T[];
  /** Opaque path supplied by Apple for the next page. */
  next?: string;
  total?: number;
}

export interface LibraryPageOptions {
  cursor?: string;
  limit?: number;
}

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

export interface AppleMusicLibraryClient {
  getSongs(cursor?: string | LibraryPageOptions): Promise<Page<Track>>;
  getAlbums(cursor?: string | LibraryPageOptions): Promise<Page<Album>>;
  getArtists(cursor?: string | LibraryPageOptions): Promise<Page<Artist>>;
  getPlaylists(cursor?: string | LibraryPageOptions): Promise<Page<Playlist>>;
  getRecentlyAdded(
    cursor?: string | LibraryPageOptions,
  ): Promise<Page<LibraryItem>>;
  getRecentlyPlayedTracks(
    cursor?: string | LibraryPageOptions,
  ): Promise<Page<Track>>;
  getAlbum(id: string): Promise<Album | undefined>;
  getArtist(id: string): Promise<Artist | undefined>;
  getPlaylist(id: string): Promise<Playlist | undefined>;
  getPlaylistTracks(
    id: string,
    cursor?: string | LibraryPageOptions,
  ): Promise<Page<Track>>;
  getRootPlaylistFolder(): Promise<PlaylistFolder | undefined>;
  getPlaylistFolder(id: string): Promise<PlaylistFolder | undefined>;
  searchPlaylists(
    term: string,
    cursor?: string | LibraryPageOptions,
  ): Promise<Page<Playlist>>;
  createPlaylist(input: CreatePlaylistInput): Promise<Playlist>;
  createPlaylistFolder(
    input: CreatePlaylistFolderInput,
  ): Promise<PlaylistFolder>;
  addTracksToPlaylist(
    playlistId: string,
    refs: readonly (MusicResourceRef | string)[],
  ): Promise<void>;
}

type Query = Record<string, unknown>;
type RequestOptions = {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
};
type MusicRequest = (
  path: string,
  query?: Query,
  options?: RequestOptions,
) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resourceLike(value: unknown): value is AppleMusicResource {
  const record = asRecord(value);
  return Boolean(
    record &&
    nonEmptyString(record.id) &&
    (nonEmptyString(record.type) ?? record.attributes !== undefined),
  );
}

function isPlaylistFolderResource(
  value: AppleMusicResource | undefined,
): value is AppleMusicResource {
  const type = nonEmptyString(asRecord(value)?.type);
  return type === "library-playlist-folders" || type === "playlist-folders";
}

function resourceArray(value: unknown, depth = 0): unknown[] | undefined {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return undefined;

  // Standard Apple response shape and common SDK envelope shape.
  if (Array.isArray(record.data)) return record.data;
  for (const key of [
    "data",
    "results",
    "resources",
    "items",
    "songs",
    "albums",
    "artists",
    "playlists",
    "tracks",
    "library-songs",
    "library-albums",
    "library-artists",
    "library-playlists",
    "library-music-videos",
  ]) {
    const found = resourceArray(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

function firstResource(
  value: unknown,
  depth = 0,
): AppleMusicResource | undefined {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstResource(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (resourceLike(value)) return value;
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of [
    "data",
    "results",
    "resource",
    "item",
    "playlist",
    "album",
    "artist",
    "library-playlists",
    "library-playlist-folders",
  ]) {
    const found = firstResource(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
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

function nextValue(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || Array.isArray(value)) return undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  const next = nonEmptyString(record.next);
  if (next) return next;
  const links = asRecord(record.links);
  const linkNext = nonEmptyString(links?.next);
  if (linkNext) return linkNext;
  for (const key of [
    "data",
    "results",
    "resources",
    "items",
    "meta",
    "songs",
    "albums",
    "artists",
    "playlists",
    "tracks",
    "library-playlists",
    "library-songs",
  ]) {
    const found = nextValue(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

function totalValue(value: unknown, depth = 0): number | undefined {
  if (depth > 8 || Array.isArray(value)) return undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  const directTotal = record.total;
  if (
    typeof directTotal === "number" &&
    Number.isFinite(directTotal) &&
    directTotal >= 0
  ) {
    return directTotal;
  }
  const meta = asRecord(record.meta);
  if (
    typeof meta?.total === "number" &&
    Number.isFinite(meta.total) &&
    meta.total >= 0
  ) {
    return meta.total;
  }
  for (const key of [
    "data",
    "results",
    "resources",
    "items",
    "songs",
    "albums",
    "artists",
    "playlists",
    "tracks",
    "library-playlists",
    "library-songs",
  ]) {
    const found = totalValue(record[key], depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function withPageMetadata<T>(items: T[], raw: unknown): Page<T> {
  const page: Page<T> = { items };
  const next = nextValue(raw);
  if (next) page.next = next;
  const total = totalValue(raw);
  if (total !== undefined) page.total = total;
  return page;
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value.trim());
}

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

function normalizedRefs(
  refs: readonly (MusicResourceRef | string)[],
): MusicResourceRef[] {
  return refs.map((ref) => {
    const normalized = normalizeMusicResourceRef(
      typeof ref === "string" ? { id: ref, type: "songs" } : ref,
    );
    if (!normalized) {
      throw new Error("Unsupported playlist track resource reference.");
    }
    return normalized;
  });
}

function postOptions(body: unknown): RequestOptions {
  return {
    method: "POST",
    body: JSON.stringify(body),
  };
}

export function createAppleMusicLibraryClient(
  instance: MusicKit.MusicKitInstance,
): AppleMusicLibraryClient {
  const request = resolveMusicKitMusicRequest(instance) as MusicRequest;

  async function getPage<T>(
    path: string,
    cursor: string | LibraryPageOptions | undefined,
    query: Query | undefined,
    normalize: (resource: AppleMusicResource) => T | undefined,
  ): Promise<Page<T>> {
    const cursorValue = typeof cursor === "string" ? cursor : cursor?.cursor;
    const limit = typeof cursor === "object" ? cursor.limit : undefined;
    const firstQuery =
      limit === undefined ? query : { ...(query ?? {}), limit };
    const raw = cursorValue?.trim()
      ? await request(cursorValue)
      : firstQuery === undefined
        ? await request(path)
        : await request(path, firstQuery);
    const resources = resourceArray(raw) ?? [];
    const items: T[] = [];
    for (const value of resources) {
      const resource = asRecord(value) as AppleMusicResource | undefined;
      if (!resource) continue;
      const item = normalize(resource);
      if (item !== undefined) items.push(item);
    }
    return withPageMetadata(items, raw);
  }

  async function getOne<T>(
    path: string,
    normalize: (resource: AppleMusicResource) => T | undefined,
    query?: Query,
  ): Promise<T | undefined> {
    const raw =
      query === undefined ? await request(path) : await request(path, query);
    const resource = firstResource(raw);
    return resource ? normalize(resource) : undefined;
  }

  async function folderChildren(
    folderId: string,
    visited: Set<string>,
  ): Promise<LibraryItem[]> {
    const children: LibraryItem[] = [];
    let cursor: string | undefined;
    do {
      const raw = cursor
        ? await request(cursor)
        : await request(
            `/v1/me/library/playlist-folders/${encodePathPart(folderId)}/children`,
            { limit: 100 },
          );
      const resources = resourceArray(raw) ?? [];
      for (const value of resources) {
        const resource = asRecord(value) as AppleMusicResource | undefined;
        if (!resource) continue;
        const item = normalizeLibraryItemResource(resource);
        if (!item) continue;
        if (item.resourceType?.includes("playlist-folder")) {
          children.push(
            await hydrateFolder(item as PlaylistFolder, folderId, visited),
          );
        } else {
          children.push({ ...item, parentId: folderId } as LibraryItem);
        }
      }
      cursor = nextValue(raw);
    } while (cursor);
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
    getSongs: (cursor) =>
      getPage(
        "/v1/me/library/songs",
        cursor,
        undefined,
        normalizeTrackResource,
      ),
    getAlbums: (cursor) =>
      getPage(
        "/v1/me/library/albums",
        cursor,
        undefined,
        normalizeAlbumResource,
      ),
    getArtists: (cursor) =>
      getPage(
        "/v1/me/library/artists",
        cursor,
        undefined,
        normalizeArtistResource,
      ),
    getPlaylists: (cursor) =>
      getPage(
        "/v1/me/library/playlists",
        cursor,
        undefined,
        normalizePlaylistResource,
      ),
    getRecentlyAdded: (cursor) =>
      getPage(
        "/v1/me/library/recently-added",
        cursor,
        undefined,
        normalizeLibraryItemResource,
      ),
    getRecentlyPlayedTracks: (cursor) =>
      getPage(
        "/v1/me/recent/played/tracks",
        cursor,
        {
          types: "library-music-videos,library-songs,music-videos,songs",
        },
        normalizeTrackResource,
      ),
    getAlbum: (id) =>
      getOne(
        `/v1/me/library/albums/${encodePathPart(id)}`,
        normalizeAlbumResource,
      ),
    getArtist: (id) =>
      getOne(
        `/v1/me/library/artists/${encodePathPart(id)}`,
        normalizeArtistResource,
      ),
    getPlaylist: (id) =>
      getOne(
        `/v1/me/library/playlists/${encodePathPart(id)}`,
        normalizePlaylistResource,
      ),
    getPlaylistTracks: (id, cursor) =>
      getPage(
        `/v1/me/library/playlists/${encodePathPart(id)}/tracks`,
        cursor,
        undefined,
        normalizeTrackResource,
      ),
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
    getPlaylistFolder: (id) => getFolder(id),
    searchPlaylists: (term, cursor) => {
      const normalizedTerm = term.trim();
      if (!normalizedTerm) return Promise.resolve({ items: [] });
      return getPage(
        "/v1/me/library/search",
        cursor,
        { term: normalizedTerm, types: "library-playlists" },
        normalizePlaylistResource,
      );
    },
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
        postOptions(body),
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
        postOptions(body),
      );
      const resource = firstResource(raw);
      const folder = resource
        ? normalizePlaylistFolderResource(resource)
        : undefined;
      if (!folder) throw new Error("Apple Music returned no playlist folder.");
      return folder;
    },
    async addTracksToPlaylist(
      playlistId: string,
      refs: readonly (MusicResourceRef | string)[],
    ): Promise<void> {
      if (!playlistId.trim()) throw new Error("Playlist id is required.");
      if (refs.length === 0) return;
      await request(
        `/v1/me/library/playlists/${encodePathPart(playlistId)}/tracks`,
        undefined,
        postOptions({ data: normalizedRefs(refs) }),
      );
    },
  };
}
