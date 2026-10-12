import type { MusicEntityRef } from "../domain/music.ts";

/**
 * Separators Apple uses between artists in a song's artist text. "and" and
 * "x" are left out: they also appear inside names ("Lil Nas X").
 */
const ARTIST_SEPARATOR = /\s*(?:,|&|\bfeat\.|\bft\.)\s*/iu;

/**
 * Artist links to show for a song. Apple can return artist relationships
 * without names; numbering them ("Artist 1, Artist 2") reads as broken. When
 * the song's artist text splits into one name per link, those names are
 * used; otherwise the whole text is one link to the first artist.
 */
export function displayArtistLinks(
  artists: readonly MusicEntityRef[],
  artistName: string | undefined,
): MusicEntityRef[] {
  if (artists.every((artist) => artist.name)) return [...artists];
  const [first] = artists;
  if (!first) return [];
  const text = artistName?.trim();
  if (!text) return [first];
  const parts = text
    .split(ARTIST_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
  if (artists.length > 1 && parts.length === artists.length) {
    return artists.map((artist, index) => ({
      ...artist,
      name: artist.name ?? parts[index],
    }));
  }
  return [{ ...first, name: text }];
}
