import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Track } from "../domain/music.ts";

export interface ArtworkProps {
  track?: Pick<Track, "title" | "artistName" | "artwork"> | null;
  size?: "sm" | "md" | "lg" | "hero";
  alt?: string;
  className?: string;
}

function initials(track?: Pick<Track, "title" | "artistName"> | null): string {
  const value = `${track?.title ?? "A"} ${track?.artistName ?? ""}`.trim();
  return value
    .split(/\s+/u)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

export function Artwork({
  track,
  size = "md",
  alt,
  className = "",
}: ArtworkProps): JSX.Element {
  const imageUrl = track?.artwork?.url;
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl]);
  const image = imageUrl && !imageFailed ? imageUrl : undefined;
  return (
    <div
      className={`artwork artwork-${size} ${className}`.trim()}
      aria-label={alt ?? `${track?.title ?? "No artwork"} artwork`}
      role={image ? undefined : "img"}
    >
      {image ? (
        <img
          src={image}
          alt={alt ?? `${track?.title ?? ""} by ${track?.artistName ?? ""}`}
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{initials(track)}</span>
      )}
    </div>
  );
}
