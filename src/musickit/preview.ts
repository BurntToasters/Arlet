export type PlaybackKind = "unknown" | "preview" | "full";

/** Apple Music catalog previews are typically 30 seconds. */
export const PREVIEW_MAX_SECONDS = 35;
/** Catalog tracks longer than this are not themselves previews. */
export const FULL_MIN_CATALOG_SECONDS = 45;

export function classifyPlaybackKind(options: {
  catalogDurationSeconds?: number;
  playbackDurationSeconds: number;
}): PlaybackKind {
  const played = options.playbackDurationSeconds;
  if (!(played > 0)) return "unknown";
  const catalog = options.catalogDurationSeconds;
  if (
    catalog !== undefined &&
    catalog > FULL_MIN_CATALOG_SECONDS &&
    played <= PREVIEW_MAX_SECONDS
  ) {
    return "preview";
  }
  if (catalog === undefined && played <= PREVIEW_MAX_SECONDS) {
    return "preview";
  }
  return "full";
}
