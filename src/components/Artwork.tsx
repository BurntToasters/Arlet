import type { JSX } from "preact";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import type { Track } from "../domain/music.ts";
import {
  artworkBucketFor,
  normalizeArtworkUrl,
} from "../musickit/normalize.ts";

export interface ArtworkProps {
  track?: Pick<Track, "title" | "artistName" | "artwork"> | null;
  size?: "sm" | "md" | "lg" | "xl" | "hero";
  alt?: string;
  className?: string;
  /** Above-the-fold art: load eagerly with high fetch priority. */
  priority?: boolean;
}

type SizeListener = (cssPixels: number) => void;

// One observer serves every artwork tile instead of one per element.
const sizeListeners = new Map<Element, SizeListener>();
let sharedObserver: ResizeObserver | undefined;

function observeCssSize(element: Element, listener: SizeListener): () => void {
  sharedObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      sizeListeners.get(entry.target)?.(Math.round(entry.contentRect.width));
    }
  });
  sizeListeners.set(element, listener);
  sharedObserver.observe(element);
  return () => {
    sharedObserver?.unobserve(element);
    sizeListeners.delete(element);
  };
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
  priority = false,
}: ArtworkProps): JSX.Element {
  const [imageFailed, setImageFailed] = useState(false);
  // Measured once on mount and again on resize; undefined until the first
  // measure, so the image is never requested at a guessed size.
  const [cssSize, setCssSize] = useState<number>();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    setCssSize(element.clientWidth);
    return observeCssSize(element, setCssSize);
  }, []);
  const rawUrl = track?.artwork?.url;
  const bucket = artworkBucketFor(cssSize ?? 0, window.devicePixelRatio);
  const imageUrl = useMemo(
    () => (rawUrl ? normalizeArtworkUrl(rawUrl, bucket) : undefined),
    [rawUrl, bucket],
  );
  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl]);
  const pixelSize = cssSize === 0 ? undefined : cssSize;
  const image =
    imageUrl && !imageFailed && cssSize !== undefined ? imageUrl : undefined;
  // The img carries the name when shown; the labelled role="img" is only for
  // the initials placeholder.
  const placeholderLabel = alt ?? `${track?.title ?? "No artwork"} artwork`;
  return (
    <div
      ref={ref}
      className={`artwork artwork-${size} ${className}`.trim()}
      aria-label={image ? undefined : placeholderLabel}
      role={image ? undefined : "img"}
    >
      {image ? (
        <img
          src={image}
          alt={alt ?? `${track?.title ?? ""} by ${track?.artistName ?? ""}`}
          width={pixelSize}
          height={pixelSize}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          fetchpriority={priority ? "high" : undefined}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{initials(track)}</span>
      )}
    </div>
  );
}
