import type { Album, RecordLabel } from "../domain/music.ts";
import { resolveMusicKitMusicRequest, resolveStorefront } from "./catalog.ts";
import { asRecord, dataArray } from "./response.ts";
import {
  artworkFromUnknown,
  editorialText,
  normalizeAlbumResource,
  viewBlockOf,
  type AppleMusicResource,
} from "./normalize.ts";

const LABEL_VIEWS = "latest-releases,top-releases";

/** One view's albums, normalized; the view's next page is never read. */
function albumsIn(resource: AppleMusicResource, view: string): Album[] {
  const entries = viewBlockOf(resource, view)?.data ?? [];
  return entries.flatMap((entry) => {
    const album = normalizeAlbumResource(entry as AppleMusicResource);
    return album ? [album] : [];
  });
}

/**
 * A record label with its latest and top releases. Rejects when Apple does not
 * return the requested label.
 */
export async function loadRecordLabel(
  instance: MusicKit.MusicKitInstance,
  id: string,
): Promise<RecordLabel> {
  const storefront = await resolveStorefront(instance);
  const raw = await resolveMusicKitMusicRequest(instance)(
    `/v1/catalog/${encodeURIComponent(storefront)}/record-labels/${encodeURIComponent(id)}`,
    { views: LABEL_VIEWS },
  );
  const resource = dataArray(raw).find(
    (entry) => asRecord(entry)?.id === id,
  ) as AppleMusicResource | undefined;
  if (!resource) throw new Error("This record label could not be found.");
  const attributes = asRecord(resource.attributes) ?? {};
  const name =
    typeof attributes.name === "string" && attributes.name.trim()
      ? attributes.name.trim()
      : "Record Label";
  const description = editorialText(attributes.description);
  const artwork = artworkFromUnknown(attributes.artwork, 300);
  return {
    id,
    name,
    ...(description ? { description } : {}),
    ...(artwork ? { artwork } : {}),
    latestReleases: albumsIn(resource, "latest-releases"),
    topReleases: albumsIn(resource, "top-releases"),
  };
}
