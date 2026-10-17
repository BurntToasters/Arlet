import { asRecord, dataArray, responseBody, safeNextPath } from "./response.ts";
import type { Artwork, Playlist } from "../domain/music.ts";
import type { CuratorKind } from "../routing/router.ts";
import {
  resolveMusicKitMusicRequest,
  resolveStorefront,
  type MusicKitMusicRequest,
} from "./catalog.ts";
import {
  artworkFromUnknown,
  normalizePlaylistResource,
  plainTextFromHtml,
  viewBlockOf,
  type AppleMusicResource,
} from "./normalize.ts";

/** Playlists under one of an Apple curator's titled groups. */
export interface CuratorPlaylistGroup {
  id: string;
  name: string;
  playlists: Playlist[];
}

export interface CuratorPage {
  id: string;
  kind: CuratorKind;
  name: string;
  artwork?: Artwork;
  /** Plain text; Apple's HTML is converted here, never rendered as HTML. */
  notes?: string;
  /** Apple's grouped shelves. Empty when the curator has none. */
  groups: CuratorPlaylistGroup[];
  /** One flat list, shown only when there are no groups. */
  playlists: Playlist[];
  /** Apple's path to the next page of `playlists`, when there is one. */
  next?: string;
}

export interface CuratorPlaylistsPage {
  playlists: Playlist[];
  next?: string;
}

/** The curator of a catalog playlist, from its curator relationship. */
export interface PlaylistCuratorRef {
  id: string;
  kind: CuratorKind;
}

type UnknownRecord = Record<string, unknown>;

interface CatalogContext {
  request: MusicKitMusicRequest;
  storefront: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resourcesOf(raw: unknown): AppleMusicResource[] {
  return dataArray(raw) as AppleMusicResource[];
}

/** Resource references in a relationship, with or without attributes. */
function refsIn(relationship: unknown): AppleMusicResource[] {
  const data = asRecord(relationship)?.data;
  const entries = Array.isArray(data) ? data : data ? [data] : [];
  return entries.filter(
    (entry): entry is AppleMusicResource =>
      typeof asRecord(entry)?.id === "string",
  );
}

function relationshipOf(
  resource: AppleMusicResource | undefined,
  name: string,
): UnknownRecord | undefined {
  return asRecord(asRecord(resource?.relationships)?.[name]);
}

async function catalogContext(
  instance: MusicKit.MusicKitInstance,
): Promise<CatalogContext> {
  const storefront = await resolveStorefront(instance);
  return { request: resolveMusicKitMusicRequest(instance), storefront };
}

function catalogPath(context: CatalogContext, segments: string): string {
  return `/v1/catalog/${encodeURIComponent(context.storefront)}/${segments}`;
}

/** Ids per `playlists?ids=` read; Apple accepts up to 25 per request. */
const PLAYLIST_BATCH_SIZE = 25;

/**
 * Full playlists for the references Apple sent. A reference with attributes
 * is used as it is; bare ids are read in batches. Ids Apple does not return
 * are left out, and the order of the references is kept by the caller.
 */
async function resolvePlaylists(
  context: CatalogContext,
  refs: readonly AppleMusicResource[],
): Promise<Map<string, Playlist>> {
  const unique = new Map<string, AppleMusicResource>();
  for (const ref of refs) {
    const id = stringValue(asRecord(ref)?.id);
    if (id && !unique.has(id)) unique.set(id, ref);
  }
  const playlists = new Map<string, Playlist>();
  const bare: string[] = [];
  for (const [id, ref] of unique) {
    const playlist = asRecord(ref)?.attributes
      ? normalizePlaylistResource(ref)
      : undefined;
    if (playlist) playlists.set(id, playlist);
    else bare.push(id);
  }
  // One `ids=` read per chunk, not one read per playlist.
  for (let start = 0; start < bare.length; start += PLAYLIST_BATCH_SIZE) {
    const chunk = bare.slice(start, start + PLAYLIST_BATCH_SIZE);
    const raw = await context.request(catalogPath(context, "playlists"), {
      ids: chunk.join(","),
    });
    for (const resource of resourcesOf(raw)) {
      const playlist = normalizePlaylistResource(resource);
      if (playlist) playlists.set(playlist.id, playlist);
    }
  }
  return playlists;
}

function playlistsFor(
  refs: readonly AppleMusicResource[],
  playlists: ReadonlyMap<string, Playlist>,
): Playlist[] {
  const seen = new Set<string>();
  const result: Playlist[] = [];
  for (const ref of refs) {
    const id = stringValue(asRecord(ref)?.id);
    const playlist = id ? playlists.get(id) : undefined;
    if (playlist && !seen.has(playlist.id)) {
      seen.add(playlist.id);
      result.push(playlist);
    }
  }
  return result;
}

/** Apple's `{ short, standard }` notes, or a plain string, as plain text. */
function notesOf(value: unknown): string | undefined {
  const record = asRecord(value);
  const raw =
    stringValue(value) ??
    stringValue(record?.standard) ??
    stringValue(record?.short);
  return (raw ? plainTextFromHtml(raw) : "") || undefined;
}

/**
 * A curator with its playlists. Apple curators are read with their grouped
 * playlists; other curators with the flat `playlists` relationship.
 */
export async function loadCuratorPage(
  instance: MusicKit.MusicKitInstance,
  id: string,
  kind: CuratorKind,
): Promise<CuratorPage> {
  const context = await catalogContext(instance);
  const segments = `${kind === "apple" ? "apple-curators" : "curators"}/${encodeURIComponent(id)}`;
  const query =
    kind === "apple"
      ? { include: "playlists", views: "grouped-playlists" }
      : { include: "playlists" };
  const resource = resourcesOf(
    await context.request(catalogPath(context, segments), query),
  )[0];
  if (!resource) throw new Error("This curator could not be found.");

  const attributes = asRecord(resource.attributes) ?? {};
  const groupBlocks = (viewBlockOf(resource, "grouped-playlists")?.data ?? [])
    .map((entry) => asRecord(entry))
    .filter((group): group is UnknownRecord => group !== undefined)
    .map((group, index) => ({
      id: stringValue(group.id) ?? `group-${index}`,
      name: stringValue(asRecord(group.attributes)?.name) ?? "Playlists",
      refs: refsIn(asRecord(asRecord(group.relationships)?.playlists)),
    }))
    .filter((group) => group.refs.length > 0);
  const flat = relationshipOf(resource, "playlists");
  const flatRefs = refsIn(flat);
  // Groups replace the flat list on screen, so only one set is resolved.
  const shownRefs = groupBlocks.length
    ? groupBlocks.flatMap((group) => group.refs)
    : flatRefs;
  const playlists = await resolvePlaylists(context, shownRefs);

  return {
    id: stringValue(resource.id) ?? id,
    kind,
    name: stringValue(attributes.name) ?? "Curator",
    artwork: artworkFromUnknown(attributes.artwork, 300),
    notes: notesOf(attributes.editorialNotes),
    groups: groupBlocks.map((group) => ({
      id: group.id,
      name: group.name,
      playlists: playlistsFor(group.refs, playlists),
    })),
    playlists: groupBlocks.length ? [] : playlistsFor(flatRefs, playlists),
    next: groupBlocks.length
      ? undefined
      : safeNextPath(flat?.next, ["/v1/catalog/"]),
  };
}

/** The next page of a curator's flat playlists; `next` is Apple's own path. */
export async function loadCuratorPlaylistsPage(
  instance: MusicKit.MusicKitInstance,
  next: string,
): Promise<CuratorPlaylistsPage> {
  const cursor = safeNextPath(next, ["/v1/catalog/"]);
  if (!cursor) {
    throw new Error("Apple Music returned an unexpected page link.");
  }
  const context = await catalogContext(instance);
  const raw = await context.request(cursor);
  const refs = resourcesOf(raw);
  const playlists = await resolvePlaylists(context, refs);
  return {
    playlists: playlistsFor(refs, playlists),
    next: safeNextPath(responseBody(raw)?.next, ["/v1/catalog/"]),
  };
}

/**
 * The curator of a catalog playlist, or undefined when Apple names none.
 * Read with `include=curator`, one small request on the playlist itself.
 */
export async function loadPlaylistCurator(
  instance: MusicKit.MusicKitInstance,
  playlistId: string,
): Promise<PlaylistCuratorRef | undefined> {
  const context = await catalogContext(instance);
  const resource = resourcesOf(
    await context.request(
      catalogPath(context, `playlists/${encodeURIComponent(playlistId)}`),
      { include: "curator" },
    ),
  )[0];
  const curator = [
    ...refsIn(relationshipOf(resource, "curator")),
    ...refsIn(relationshipOf(resource, "curators")),
  ][0];
  const id = stringValue(asRecord(curator)?.id);
  if (!id) return undefined;
  return {
    id,
    kind: asRecord(curator)?.type === "apple-curators" ? "apple" : "curator",
  };
}
