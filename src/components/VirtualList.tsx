import { Fragment, type ComponentChildren, type JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";

/** Lists at or below this size render in full. */
export const VIRTUALIZE_THRESHOLD = 200;
const OVERSCAN_ROWS = 8;

interface Window {
  start: number;
  end: number;
}

export interface VirtualListProps<T> {
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  renderRow: (item: T, index: number) => ComponentChildren;
  /** Renders one `<li>`. Fallback height is used until a row is measured. */
  rowHeight?: number;
  className?: string;
  "aria-label"?: string;
  /** Ancestor that scrolls the list. Defaults to the main content scroller. */
  scrollParentSelector?: string;
}

function scrollParent(
  element: HTMLElement,
  selector: string,
): HTMLElement | null {
  return element.closest<HTMLElement>(selector);
}

/**
 * An `<ol>` that renders only the rows inside the scroll viewport (plus
 * overscan) once a list is large. Spacer rows keep the scrollbar honest.
 */
export function VirtualList<T>({
  items,
  getKey,
  renderRow,
  rowHeight = 65,
  className,
  "aria-label": ariaLabel,
  scrollParentSelector = ".content-scroll",
}: VirtualListProps<T>): JSX.Element {
  const listRef = useRef<HTMLOListElement>(null);
  const measured = useRef(rowHeight);
  const virtual = items.length > VIRTUALIZE_THRESHOLD;
  const [range, setRange] = useState<Window>({
    start: 0,
    end: Math.min(items.length, OVERSCAN_ROWS * 3),
  });

  useLayoutEffect(() => {
    if (!virtual) return undefined;
    const list = listRef.current;
    const scroller = list ? scrollParent(list, scrollParentSelector) : null;
    if (!list || !scroller) return undefined;
    const update = (): void => {
      const row = list.querySelector<HTMLElement>(
        ":scope > li:not([aria-hidden])",
      );
      if (row && row.offsetHeight > 0) measured.current = row.offsetHeight;
      const height = measured.current;
      const viewport = scroller.clientHeight || window.innerHeight;
      const above = Math.max(
        0,
        scroller.getBoundingClientRect().top - list.getBoundingClientRect().top,
      );
      const start = Math.max(0, Math.floor(above / height) - OVERSCAN_ROWS);
      const end = Math.min(
        items.length,
        Math.ceil((above + viewport) / height) + OVERSCAN_ROWS,
      );
      setRange((current) =>
        current.start === start && current.end === end
          ? current
          : { start, end },
      );
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      scroller.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [virtual, items.length, scrollParentSelector]);

  if (!virtual) {
    return (
      <ol ref={listRef} className={className} aria-label={ariaLabel}>
        {items.map((item, index) => (
          <Fragment key={getKey(item, index)}>
            {renderRow(item, index)}
          </Fragment>
        ))}
      </ol>
    );
  }
  const start = Math.min(range.start, items.length);
  const end = Math.min(Math.max(range.end, start), items.length);
  const height = measured.current;
  return (
    <ol ref={listRef} className={className} aria-label={ariaLabel}>
      <li aria-hidden="true" style={{ height: `${start * height}px` }} />
      {items.slice(start, end).map((item, offset) => (
        <Fragment key={getKey(item, start + offset)}>
          {renderRow(item, start + offset)}
        </Fragment>
      ))}
      <li
        aria-hidden="true"
        style={{ height: `${(items.length - end) * height}px` }}
      />
    </ol>
  );
}
