/**
 * Album, artist and playlist detail reads for the Apple library and catalog
 * client: the views and extend requests that come with a detail read, and the
 * paged track, album and playlist lists that follow it.
 */
import { asRecord, findResourceArray, safeNextPath } from "./response.ts";
import {
  APPLE_PAGE_PREFIXES,
  createPageReaders,
  encodePathPart,
  firstResource,
  MAX_BATCH_IDS,
  nonEmptyString,
  resourceKey,
  type LibraryPageOptions,
  type MusicRequest,
  type Page,
  type Query,
} from "./library-pages.ts";
import { resolveStorefront } from "./catalog.ts";
import {
  normalizeAlbumResource,
  normalizeArtistResource,
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
  MusicSource,
  Playlist,
  Track,
} from "../domain/music.ts";

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

export function createDetailMethods(
  request: MusicRequest,
  instance: MusicKit.MusicKitInstance,
) {
  const { getOne, getPage } = createPageReaders(request);

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
            next: safeNextPath(fullAlbums.next, APPLE_PAGE_PREFIXES),
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

  return {
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
        for (const value of findResourceArray(raw) ?? []) {
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
  };
}
