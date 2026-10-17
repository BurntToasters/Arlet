import type { ComponentChildren, JSX } from "preact";

/**
 * Labelled loading region. The label is the only text, so screen readers
 * announce "Loading ..." once; the shapes inside are hidden from them.
 */
export function SkeletonStatus({
  label,
  children,
}: {
  label: string;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <div className="skeleton-status" role="status">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

function SkeletonLine({
  kind,
  className = "",
}: {
  kind: "title" | "meta";
  className?: string;
}): JSX.Element {
  return (
    <span
      className={`skeleton-shape skeleton-line skeleton-line-${kind} ${className}`.trim()}
    />
  );
}

/** Artwork square and two text lines, sized like the discovery and library cards. */
export function SkeletonCardGrid({
  count = 6,
}: {
  count?: number;
}): JSX.Element {
  return (
    <div className="skeleton-card-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="skeleton-card" key={index}>
          <span className="skeleton-shape skeleton-card-art" />
          <span className="skeleton-card-copy">
            <SkeletonLine kind="title" />
            <SkeletonLine kind="meta" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Song rows laid out on the same columns as the library track rows. */
export function SkeletonRows({ count = 6 }: { count?: number }): JSX.Element {
  return (
    <div className="skeleton-rows" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="skeleton-row" key={index}>
          <SkeletonLine kind="meta" className="skeleton-row-number" />
          <span className="skeleton-shape skeleton-row-art" />
          <span className="skeleton-row-copy">
            <SkeletonLine kind="title" />
            <SkeletonLine kind="meta" />
          </span>
          <span className="skeleton-row-badge" />
          <SkeletonLine kind="meta" className="skeleton-row-duration" />
        </div>
      ))}
    </div>
  );
}
