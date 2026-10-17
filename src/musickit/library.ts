import {
  normalizeStation,
  resolveMusicKitMusicRequest,
  resolveStorefront,
  responseDataArray,
} from "./catalog.ts";
import {
  normalizeAlbumResource,
  normalizeArtistResource,
  normalizeLibraryItemResource,
  normalizeMusicResourceRef,
  normalizePlaylistFolderResource,
  normalizePlaylistResource,
  normalizeTrackResource,
  viewBlockOf,
  type AppleMusicResource,
} from "./normalize.ts";
import type {
  Album,
  AlbumShelves,
  Artist,
  ArtistShelves,
  LibraryItem,
  MusicResourceRef,
  Playlist,
  PlaylistFolder,
  Track,
  DiscoveryResource,
  MusicSource,
  RatingValue,
  RecommendationSection,
  Station,
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

/**
 * Largest page Apple accepts for library and catalog song, album, artist,
 * playlist and track lists. Recent-history endpoints cap lower, so they
 * keep Apple's default.
 */
export const LIBRARY_PAGE_LIMIT = 100;

/** Largest page Apple accepts for recent played resources. */
const RECENT_PLAYED_PAGE_LIMIT = 10;

/** Most ids Apple takes in one library multi-get or ratings request. */
const MAX_BATCH_IDS = 100;

/** Most ids Apple takes in one catalog multi-get request. */
const MAX_CATALOG_BATCH_IDS = 25;

/** A record plus its first track page, when the response carried a full one. */
export interface DetailWithTracks<T> {
  item?: T;
  firstTracks?: Page<Track>;
}

/** An artist with the albums from its views request, when Apple returned them. */
export interface ArtistDetail {
  item?: Artist;
  /** The full-albums view's first page; `next` pages through the rest. */
  albums?: Page<Album>;
}

/** Catalog artist views the artist page reads in its one request. */
const ARTIST_PAGE_VIEWS = [
  "latest-release",
  "top-songs",
  "full-albums",
  "singles",
  "live-albums",
  "compilation-albums",
  "appears-on-albums",
  "similar-artists",
  "featured-playlists",
] as const;

/** Artist attributes the bio and banner need beyond the default record. */
const ARTIST_PAGE_EXTEND = "editorialArtwork,editorialNotes";

/** Catalog album views the album page reads beside its track list. */
const ALBUM_PAGE_VIEWS = [
  "other-versions",
  "related-albums",
  "more-by-artist",
] as const;

interface DetailRequestOptions<T> {
  /** Relationships to include; albums and playlists default to `tracks`. */
  include?: string;
  /** Views to read on the same request; the record loads without them on failure. */
  views?: readonly string[];
  /** Attaches what the views returned to the record. */
  decorate?: (item: T, resource: AppleMusicResource) => T;
}

/** Entries of one view, normalized; undefined when Apple left the view out. */
function viewItems<T>(
  resource: AppleMusicResource,
  name: string,
  normalize: (resource: AppleMusicResource) => T | undefined,
): T[] | undefined {
  const block = viewBlockOf(resource, name);
  if (!block) return undefined;
  const items: T[] = [];
  for (const value of block.data) {
    const entry = asRecord(value) as AppleMusicResource | undefined;
    const item = entry ? normalize(entry) : undefined;
    if (item !== undefined) items.push(item);
  }
  return items;
}

/** Artist shelves from the views; undefined when none of them came back. */
function artistShelvesOf(
  resource: AppleMusicResource,
): ArtistShelves | undefined {
  const shelves: ArtistShelves = {
    latestRelease: viewItems(
      resource,
      "latest-release",
      normalizeAlbumResource,
    ),
    topSongs: viewItems(resource, "top-songs", normalizeTrackResource),
    singles: viewItems(resource, "singles", normalizeAlbumResource),
    liveAlbums: viewItems(resource, "live-albums", normalizeAlbumResource),
    compilations: viewItems(
      resource,
      "compilation-albums",
      normalizeAlbumResource,
    ),
    appearsOn: viewItems(resource, "appears-on-albums", normalizeAlbumResource),
    playlists: viewItems(
      resource,
      "featured-playlists",
      normalizePlaylistResource,
    ),
    similarArtists: viewItems(
      resource,
      "similar-artists",
      normalizeArtistResource,
    ),
  };
  return Object.values(shelves).some((items) => items !== undefined)
    ? shelves
    : undefined;
}

/** Album shelves from the views; the album itself is left out of its own shelves. */
function albumShelvesOf(
  resource: AppleMusicResource,
): AlbumShelves | undefined {
  const ownId = typeof resource.id === "string" ? resource.id : undefined;
  const others = (name: string): Album[] | undefined =>
    viewItems(resource, name, normalizeAlbumResource)?.filter(
      (album) => album.id !== ownId,
    );
  const shelves: AlbumShelves = {
    moreByArtist: others("more-by-artist"),
    otherVersions: others("other-versions"),
    relatedAlbums: others("related-albums"),
  };
  return Object.values(shelves).some((items) => items !== undefined)
    ? shelves
    : undefined;
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

/** A Home card: an album, a playlist, or a station. */
export type HomeResource = DiscoveryResource | Station;

/** A recommendation shelf whose items can be any Home resource. */
export type HomeRecommendationSection = Omit<RecommendationSection, "items"> & {
  items: HomeResource[];
};

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
  getRecentlyPlayed(limit?: number): Promise<Page<HomeResource>>;
  getHeavyRotation(limit?: number): Promise<Page<HomeResource>>;
  getRecommendations(limit?: number): Promise<HomeRecommendationSection[]>;
  getAlbum(id: string, source?: MusicSource): Promise<Album | undefined>;
  /** One request for the album and, when complete, its first track page. */
  getAlbumDetail(
    id: string,
    source?: MusicSource,
  ): Promise<DetailWithTracks<Album>>;
  getAlbumTracks(
    id: string,
    source?: MusicSource,
    cursor?: string | LibraryPageOptions,
  ): Promise<Page<Track>>;
  getArtist(id: string, source?: MusicSource): Promise<Artist | undefined>;
  /**
   * The artist page's shelves in one catalog request. A library artist first
   * resolves its catalog ID; without one it returns the library record alone.
   */
  getArtistDetail(id: string, source?: MusicSource): Promise<ArtistDetail>;
  getArtistAlbums(
    id: string,
    cursor?: string | LibraryPageOptions,
    source?: MusicSource,
  ): Promise<Page<Album>>;
  getPlaylist(id: string, source?: MusicSource): Promise<Playlist | undefined>;
  /** One request for the playlist and, when complete, its first track page. */
  getPlaylistDetail(
    id: string,
    source?: MusicSource,
  ): Promise<DetailWithTracks<Playlist>>;
  /** Batched lookup: 25 ids per catalog request, 100 per library request. */
  getPlaylistsByIds(
    ids: readonly string[],
    source?: MusicSource,
  ): Promise<Playlist[]>;
  getPlaylistTracks(
    id: string,
    cursor?: string | LibraryPageOptions,
    source?: MusicSource,
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
export type MusicRequest = (
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

function supportedDiscoveryType(value: unknown): boolean {
  const type = nonEmptyString(asRecord(value)?.type);
  return (
    type === "albums" ||
    type === "library-albums" ||
    type === "playlists" ||
    type === "library-playlists"
  );
}

function resourceKey(value: unknown): string | undefined {
  const record = asRecord(value);
  const id = nonEmptyString(record?.id);
  const type = nonEmptyString(record?.type);
  return id && type ? `${type}:${id}` : undefined;
}

function recommendationAttributes(value: unknown): Record<string, unknown> {
  return asRecord(asRecord(value)?.attributes) ?? {};
}

function displayString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  return (
    nonEmptyString(record?.stringForDisplay) ??
    nonEmptyString(record?.standard) ??
    nonEmptyString(record?.short) ??
    nonEmptyString(record?.name)
  );
}

const RECOMMENDATION_KEYS = [
  "contents",
  "recommendations",
  "items",
  "resources",
];

/**
 * Child entries of a recommendation group, taken from every relationship it
 * names (contents, nested recommendations) and deduplicated by type and id.
 */
function recommendationChildren(group: unknown): unknown[] {
  const record = asRecord(group);
  const relationships = asRecord(record?.relationships);
  const children: unknown[] = [];
  for (const key of RECOMMENDATION_KEYS) {
    const relationshipValue = relationships?.[key];
    const data = Array.isArray(relationshipValue)
      ? relationshipValue
      : asRecord(relationshipValue)?.data;
    if (Array.isArray(data)) children.push(...data);
    else if (Array.isArray(record?.[key]))
      children.push(...(record[key] as unknown[]));
  }
  const seen = new Set<string>();
  return children.filter((child) => {
    const key = resourceKey(child);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Nested recommendation groups carry a "recommendation" resource type. */
function isRecommendationGroup(value: unknown): boolean {
  return (
    nonEmptyString(asRecord(value)?.type)?.includes("recommendation") === true
  );
}

/**
 * Home resources: albums and playlists, plus stations. Other types (music
 * videos, songs, folders) and unknown types are skipped.
 */
function normalizeHomeResource(value: unknown): HomeResource | undefined {
  if (nonEmptyString(asRecord(value)?.type) === "stations") {
    return normalizeStation(value as AppleMusicResource);
  }
  if (!supportedDiscoveryType(value)) return undefined;
  return normalizeLibraryItemResource(value as AppleMusicResource) as
    DiscoveryResource | undefined;
}

/** Nested recommendation groups deeper than this are not read. */
const MAX_RECOMMENDATION_DEPTH = 3;

interface RecommendationReadContext {
  includedByKey: Map<string, unknown>;
  limit: number;
  sections: HomeRecommendationSection[];
  sectionIds: Set<string>;
}

/**
 * Appends one shelf per group that has displayable items, then reads its
 * nested groups in order, so nesting becomes a flat list of titled shelves.
 */
function readRecommendationGroup(
  group: unknown,
  context: RecommendationReadContext,
  fallbackTitle: string,
  depth: number,
): void {
  const groupRecord = asRecord(group);
  if (!groupRecord) return;
  const items: HomeResource[] = [];
  const nested: unknown[] = [];
  for (const child of recommendationChildren(group)) {
    const key = resourceKey(child);
    const resolved = (key && context.includedByKey.get(key)) ?? child;
    if (isRecommendationGroup(resolved)) {
      nested.push(resolved);
      continue;
    }
    const item = normalizeHomeResource(resolved);
    if (item && items.length < context.limit) items.push(item);
  }
  if (items.length === 0 && nested.length === 0) {
    const direct = normalizeHomeResource(group);
    if (direct) items.push(direct);
  }
  const attributes = recommendationAttributes(group);
  const title =
    displayString(attributes.title) ??
    displayString(attributes.name) ??
    fallbackTitle;
  if (items.length > 0) {
    const baseId =
      nonEmptyString(groupRecord.id) ??
      `recommendation-${context.sections.length}`;
    const id = context.sectionIds.has(baseId)
      ? `${baseId}-${context.sections.length}`
      : baseId;
    context.sectionIds.add(id);
    const kind = displayString(attributes.kind);
    const reason = displayString(attributes.reason);
    context.sections.push({
      id,
      title,
      items,
      ...(kind ? { kind } : {}),
      ...(reason ? { reason } : {}),
    });
  }
  if (depth >= MAX_RECOMMENDATION_DEPTH) return;
  for (const child of nested) {
    readRecommendationGroup(child, context, title, depth + 1);
  }
}

/**
 * Normalize Apple's recommendation envelope into titled shelves of albums,
 * playlists, and stations. Nested recommendation groups become their own
 * shelves; other resource types are skipped.
 */
export function normalizeRecommendationGroups(
  raw: unknown,
  limit = 10,
): HomeRecommendationSection[] {
  // MusicKit resolves to an envelope around Apple's body; accept either shape.
  const envelope = asRecord(raw);
  const body = asRecord(envelope?.data) ?? envelope;
  const data = responseDataArray(raw);
  const included = Array.isArray(body?.included) ? body.included : [];
  const includedByKey = new Map<string, unknown>();
  for (const resource of included) {
    const key = resourceKey(resource);
    if (key) includedByKey.set(key, resource);
  }
  const context: RecommendationReadContext = {
    includedByKey,
    limit,
    sections: [],
    sectionIds: new Set(),
  };
  for (const group of data) {
    readRecommendationGroup(group, context, "Recommendations", 0);
  }
  if (context.sections.length > 0) return context.sections;

  const fallback = data
    .map(normalizeHomeResource)
    .filter((item): item is HomeResource => Boolean(item))
    .slice(0, limit);
  return fallback.length > 0
    ? [{ id: "recommendations", title: "Recommendations", items: fallback }]
    : [];
}

/** 100 children per page; 50 pages is far beyond any real folder. */
const MAX_FOLDER_PAGES = 50;

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

/**
 * Options for a non-GET call. MusicKit v3 sends only `fetchOptions` to
 * `fetch`; the top-level `method` tells the retry wrapper not to retry.
 */
function mutationOptions(method: string, body?: unknown): RequestOptions {
  const init: RequestOptions = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  // MusicKit merges these headers with its auth headers.
  const fetchOptions =
    body === undefined
      ? { ...init }
      : { ...init, headers: { "Content-Type": "application/json" } };
  return { ...init, fetchOptions };
}

/**
 * Apple's `next` cursor does not always repeat the page size, so later pages
 * would fall back to 25 items; the requested limit is carried over.
 */
function withLimit(cursor: string, limit: number | undefined): string {
  if (limit === undefined || /[?&]limit=/u.test(cursor)) return cursor;
  return `${cursor}${cursor.includes("?") ? "&" : "?"}limit=${limit}`;
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
      ? await request(withLimit(cursorValue, limit))
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

  /**
   * Reads one album or playlist with its `tracks` relationship included. The
   * first track page is returned only when it is provably whole: no `next`,
   * every entry resolvable, and not fewer than the declared track count.
   * Otherwise the caller pages the track endpoint as before.
   */
  async function getWithFirstTracks<T>(
    path: string,
    normalize: (resource: AppleMusicResource) => T | undefined,
    options: DetailRequestOptions<T> = {},
  ): Promise<DetailWithTracks<T>> {
    const query: Query = { include: options.include ?? "tracks" };
    const raw = options.views
      ? await requestWithViews(path, query, options.views)
      : await request(path, query);
    const resource = firstResource(raw);
    const built = resource ? normalize(resource) : undefined;
    const item =
      built !== undefined && resource && options.decorate
        ? options.decorate(built, resource)
        : built;
    const declared = asRecord(resource?.attributes)?.trackCount;
    const relationship = asRecord(asRecord(resource?.relationships)?.tracks);
    const data = Array.isArray(relationship?.data)
      ? relationship.data
      : undefined;
    if (!data || data.length === 0 || nonEmptyString(relationship?.next)) {
      return { item };
    }
    if (typeof declared === "number" && data.length < declared) return { item };
    const includedByKey = new Map<string, unknown>();
    const included = asRecord(raw)?.included;
    for (const value of Array.isArray(included) ? included : []) {
      const key = resourceKey(value);
      if (key) includedByKey.set(key, value);
    }
    const items: Track[] = [];
    for (const entry of data) {
      const record = asRecord(entry);
      // Apple sends full objects here, or only identifiers with the bodies in `included`.
      const full =
        record?.attributes !== undefined
          ? record
          : includedByKey.get(resourceKey(record) ?? "");
      const track = full
        ? normalizeTrackResource(full as AppleMusicResource)
        : undefined;
      if (!track) return { item };
      items.push(track);
    }
    return { item, firstTracks: { items } };
  }

  /**
   * Adds views (and `extend`) to a read. Views are an extra: when Apple
   * rejects them, the same read runs again without them, so the record still
   * loads and the caller falls back to its separate requests.
   */
  async function requestWithViews(
    path: string,
    query: Query | undefined,
    views: readonly string[],
    extend?: string,
  ): Promise<unknown> {
    const withViews: Query = {
      ...(query ?? {}),
      views: views.join(","),
      ...(extend ? { extend } : {}),
    };
    try {
      return await request(path, withViews);
    } catch {
      return query === undefined ? request(path) : request(path, query);
    }
  }

  async function catalogArtistPath(id: string): Promise<string> {
    return `/v1/catalog/${encodePathPart(await resolveStorefront(instance))}/artists/${encodePathPart(id)}`;
  }

  /** One catalog artist request carries its shelves and the first album page. */
  async function catalogArtistDetail(id: string): Promise<ArtistDetail> {
    const raw = await requestWithViews(
      await catalogArtistPath(id),
      undefined,
      ARTIST_PAGE_VIEWS,
      ARTIST_PAGE_EXTEND,
    );
    const resource = firstResource(raw);
    const item = resource ? normalizeArtistResource(resource) : undefined;
    if (!resource || !item) return { item };
    const shelves = artistShelvesOf(resource);
    const fullAlbums = viewBlockOf(resource, "full-albums");
    return {
      item: shelves ? { ...item, shelves } : item,
      albums: fullAlbums
        ? {
            items:
              viewItems(resource, "full-albums", normalizeAlbumResource) ?? [],
            next: fullAlbums.next,
          }
        : undefined,
    };
  }

  /** A library album's views come from its catalog twin; a failed read leaves them out. */
  async function catalogAlbumShelves(
    catalogId: string,
  ): Promise<AlbumShelves | undefined> {
    try {
      const raw = await request(await albumPath(catalogId, "catalog"), {
        views: ALBUM_PAGE_VIEWS.join(","),
      });
      const resource = firstResource(raw);
      return resource ? albumShelvesOf(resource) : undefined;
    } catch {
      return undefined;
    }
  }

  async function albumPath(id: string, source: MusicSource): Promise<string> {
    return source === "catalog"
      ? `/v1/catalog/${encodePathPart(await resolveStorefront(instance))}/albums/${encodePathPart(id)}`
      : `/v1/me/library/albums/${encodePathPart(id)}`;
  }

  async function playlistPath(
    id: string,
    source: MusicSource,
  ): Promise<string> {
    return source === "catalog"
      ? `/v1/catalog/${encodePathPart(await resolveStorefront(instance))}/playlists/${encodePathPart(id)}`
      : `/v1/me/library/playlists/${encodePathPart(id)}`;
  }

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
      const resources = resourceArray(raw) ?? [];
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
      cursor = nextValue(raw);
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
    /**
     * Apple caps recent-played pages at 10, so one more page is read through
     * its `next` link. The second page is optional: if it fails, the first
     * page is still returned.
     */
    async getRecentlyPlayed(limit = 20): Promise<Page<HomeResource>> {
      const query = {
        types: "albums,playlists,library-playlists,stations",
        limit: RECENT_PLAYED_PAGE_LIMIT,
      };
      const first = await getPage(
        "/v1/me/recent/played",
        undefined,
        query,
        normalizeHomeResource,
      );
      const items = [...first.items];
      const seen = new Set(items.map((item) => item.id));
      if (first.next && items.length < limit) {
        try {
          const second = await getPage(
            "/v1/me/recent/played",
            first.next,
            undefined,
            normalizeHomeResource,
          );
          for (const item of second.items) {
            if (items.length >= limit) break;
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            items.push(item);
          }
        } catch {
          // The first page stands on its own.
        }
      }
      return { items: items.slice(0, limit) };
    },
    getHeavyRotation: (limit = 10) =>
      getPage(
        "/v1/me/history/heavy-rotation",
        undefined,
        { limit },
        normalizeHomeResource,
      ),
    async getRecommendations(limit = 10): Promise<HomeRecommendationSection[]> {
      // Default recommendations endpoint does not expose a limit query. Slice
      // normalized groups locally and apply limit to each content section.
      const raw = await request("/v1/me/recommendations");
      return normalizeRecommendationGroups(raw, limit);
    },
    async getAlbum(
      id: string,
      source: MusicSource = "library",
    ): Promise<Album | undefined> {
      return getOne(await albumPath(id, source), normalizeAlbumResource);
    },
    async getAlbumDetail(
      id: string,
      source: MusicSource = "library",
    ): Promise<DetailWithTracks<Album>> {
      // A library album asks for its catalog ID too, to find its views.
      const detail = await getWithFirstTracks(
        await albumPath(id, source),
        normalizeAlbumResource,
        {
          include: source === "catalog" ? "tracks" : "tracks,catalog",
          ...(source === "catalog" ? { views: ALBUM_PAGE_VIEWS } : {}),
          decorate: (album, resource) => {
            const shelves = albumShelvesOf(resource);
            return shelves ? { ...album, shelves } : album;
          },
        },
      );
      const catalogId =
        source === "library" ? detail.item?.catalogId : undefined;
      if (!detail.item || !catalogId) return detail;
      const shelves = await catalogAlbumShelves(catalogId);
      return shelves
        ? { ...detail, item: { ...detail.item, shelves } }
        : detail;
    },
    async getAlbumTracks(
      id: string,
      source: MusicSource = "library",
      cursor?: string | LibraryPageOptions,
    ): Promise<Page<Track>> {
      const path =
        source === "catalog"
          ? `/v1/catalog/${encodePathPart(await resolveStorefront(instance))}/albums/${encodePathPart(id)}/tracks`
          : `/v1/me/library/albums/${encodePathPart(id)}/tracks`;
      return getPage(path, cursor, undefined, normalizeTrackResource);
    },
    async getArtist(
      id: string,
      source: MusicSource = "library",
    ): Promise<Artist | undefined> {
      const path =
        source === "catalog"
          ? `/v1/catalog/${encodePathPart(await resolveStorefront(instance))}/artists/${encodePathPart(id)}`
          : `/v1/me/library/artists/${encodePathPart(id)}`;
      return getOne(path, normalizeArtistResource);
    },
    async getArtistDetail(
      id: string,
      source: MusicSource = "library",
    ): Promise<ArtistDetail> {
      if (source === "catalog") return catalogArtistDetail(id);
      const library = await getOne(
        `/v1/me/library/artists/${encodePathPart(id)}`,
        normalizeArtistResource,
        { include: "catalog" },
      );
      if (!library?.catalogId) return { item: library };
      // Without the catalog artist the library record still renders, as before.
      const catalog = await catalogArtistDetail(library.catalogId).catch(
        () => undefined,
      );
      if (!catalog) return { item: library };
      return {
        item: {
          ...library,
          editorialNotes: catalog.item?.editorialNotes,
          editorialBanner: catalog.item?.editorialBanner,
          shelves: catalog.item?.shelves,
        },
        albums: catalog.albums,
      };
    },
    async getArtistAlbums(
      id: string,
      cursor?: string | LibraryPageOptions,
      source: MusicSource = "library",
    ): Promise<Page<Album>> {
      const path =
        source === "catalog"
          ? `/v1/catalog/${encodePathPart(await resolveStorefront(instance))}/artists/${encodePathPart(id)}/albums`
          : `/v1/me/library/artists/${encodePathPart(id)}/albums`;
      return getPage(path, cursor, undefined, normalizeAlbumResource);
    },
    async getPlaylist(
      id: string,
      source: MusicSource = "library",
    ): Promise<Playlist | undefined> {
      return getOne(await playlistPath(id, source), normalizePlaylistResource);
    },
    async getPlaylistDetail(
      id: string,
      source: MusicSource = "library",
    ): Promise<DetailWithTracks<Playlist>> {
      return getWithFirstTracks(
        await playlistPath(id, source),
        normalizePlaylistResource,
      );
    },
    async getPlaylistsByIds(
      ids: readonly string[],
      source: MusicSource = "library",
    ): Promise<Playlist[]> {
      const list = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
      // Apple documents a per-type multi-fetch for each root, with its own cap.
      const path =
        source === "catalog"
          ? `/v1/catalog/${encodePathPart(await resolveStorefront(instance))}/playlists`
          : "/v1/me/library/playlists";
      const maxIds =
        source === "catalog" ? MAX_CATALOG_BATCH_IDS : MAX_BATCH_IDS;
      const chunks: string[][] = [];
      for (let start = 0; start < list.length; start += maxIds) {
        chunks.push(list.slice(start, start + maxIds));
      }
      const responses = await Promise.all(
        chunks.map((chunk) => request(path, { ids: chunk.join(",") })),
      );
      const playlists: Playlist[] = [];
      for (const raw of responses) {
        for (const value of resourceArray(raw) ?? []) {
          const resource = asRecord(value) as AppleMusicResource | undefined;
          const item = resource
            ? normalizePlaylistResource(resource)
            : undefined;
          if (item) playlists.push(item);
        }
      }
      return playlists;
    },
    async getPlaylistTracks(
      id: string,
      cursor?: string | LibraryPageOptions,
      source: MusicSource = "library",
    ): Promise<Page<Track>> {
      // Permit the convenient getPlaylistTracks(id, "catalog") form while
      // retaining the existing opaque-cursor position in the API.
      if (cursor === "catalog" || cursor === "library") {
        source = cursor;
        cursor = undefined;
      }
      const path =
        source === "catalog"
          ? `/v1/catalog/${encodePathPart(await resolveStorefront(instance))}/playlists/${encodePathPart(id)}/tracks`
          : `/v1/me/library/playlists/${encodePathPart(id)}/tracks`;
      return getPage(path, cursor, undefined, normalizeTrackResource);
    },
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
    async addTracksToPlaylist(
      playlistId: string,
      refs: readonly (MusicResourceRef | string)[],
    ): Promise<void> {
      if (!playlistId.trim()) throw new Error("Playlist id is required.");
      if (refs.length === 0) return;
      await request(
        `/v1/me/library/playlists/${encodePathPart(playlistId)}/tracks`,
        undefined,
        mutationOptions("POST", { data: normalizedRefs(refs) }),
      );
    },
  };
}

/** Library and catalog kinds Apple accepts for rating endpoints. */
export type RatingResourceType =
  | "songs"
  | "library-songs"
  | "albums"
  | "library-albums"
  | "playlists"
  | "library-playlists";

/** Catalog kinds accepted by `POST /v1/me/library`. */
export interface AddToLibraryIds {
  songs?: readonly string[];
  albums?: readonly string[];
  playlists?: readonly string[];
}

function ratingPath(type: RatingResourceType, id: string): string {
  const trimmed = id.trim();
  if (!trimmed) throw new Error("Rating item id is required.");
  return `/v1/me/ratings/${type}/${encodePathPart(trimmed)}`;
}

/** Loads ratings for the given ids; unrated ids are absent from the map. */
export async function getRatings(
  request: MusicRequest,
  type: RatingResourceType,
  ids: readonly string[],
): Promise<Map<string, RatingValue>> {
  const values = new Map<string, RatingValue>();
  const list = ids.map((id) => id.trim()).filter(Boolean);
  // Apple caps the ids in one ratings request; the chunks run in parallel.
  const chunks: string[][] = [];
  for (let start = 0; start < list.length; start += MAX_BATCH_IDS) {
    chunks.push(list.slice(start, start + MAX_BATCH_IDS));
  }
  const responses = await Promise.all(
    chunks.map((chunk) =>
      request(`/v1/me/ratings/${type}`, { ids: chunk.join(",") }),
    ),
  );
  for (const raw of responses) {
    for (const value of resourceArray(raw) ?? []) {
      const resource = asRecord(value);
      const id = nonEmptyString(resource?.id);
      if (!id) continue;
      const rating = asRecord(resource?.attributes)?.value;
      values.set(id, rating === 1 ? 1 : rating === -1 ? -1 : 0);
    }
  }
  return values;
}

export async function setRating(
  request: MusicRequest,
  type: RatingResourceType,
  id: string,
  value: 1 | -1,
): Promise<void> {
  await request(
    ratingPath(type, id),
    undefined,
    mutationOptions("PUT", { type: "rating", attributes: { value } }),
  );
}

export async function clearRating(
  request: MusicRequest,
  type: RatingResourceType,
  id: string,
): Promise<void> {
  await request(ratingPath(type, id), undefined, mutationOptions("DELETE"));
}

export async function addToLibrary(
  request: MusicRequest,
  items: AddToLibraryIds,
): Promise<void> {
  const query: Record<string, string> = {};
  for (const type of ["songs", "albums", "playlists"] as const) {
    const ids = (items[type] ?? []).map((id) => id.trim()).filter(Boolean);
    if (ids.length > 0) query[`ids[${type}]`] = ids.join(",");
  }
  if (Object.keys(query).length === 0) {
    throw new Error("At least one item is required.");
  }
  await request("/v1/me/library", query, mutationOptions("POST"));
}
