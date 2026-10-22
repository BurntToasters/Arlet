/**
 * Home reads for the Apple library and catalog client: recently played, heavy
 * rotation and recommendations, normalized into titled shelves of albums,
 * playlists and stations.
 */
import { asRecord, dataArray } from "./response.ts";
import { normalizeStation } from "./catalog.ts";
import {
  normalizeLibraryItemResource,
  type AppleMusicResource,
} from "./normalize.ts";
import {
  createPageReaders,
  nonEmptyString,
  resourceKey,
  type MusicRequest,
  type Page,
} from "./library-pages.ts";
import type {
  DiscoveryResource,
  RecommendationSection,
  Station,
} from "../domain/music.ts";

/** Largest page Apple accepts for recent played resources. */
const RECENT_PLAYED_PAGE_LIMIT = 10;

/** A Home card: an album, a playlist, or a station. */
export type HomeResource = DiscoveryResource | Station;

/** A recommendation shelf whose items can be any Home resource. */
export type HomeRecommendationSection = Omit<RecommendationSection, "items"> & {
  items: HomeResource[];
};

function supportedDiscoveryType(value: unknown): boolean {
  const type = nonEmptyString(asRecord(value)?.type);
  return (
    type === "albums" ||
    type === "library-albums" ||
    type === "playlists" ||
    type === "library-playlists"
  );
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
  const data = dataArray(raw);
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

export function createHomeMethods(request: MusicRequest) {
  const { getPage } = createPageReaders(request);
  return {
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
  };
}
