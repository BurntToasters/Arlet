import { Fragment, type ComponentChildren, type JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";

/** Lists at or below this size render in full. */
export const VIRTUALIZE_THRESHOLD = 200;
const OVERSCAN_ROWS = 8;

interface Window {
  start: number;
  end: number;
  /** Row height the spacer rows were rendered with. */
  height: number;
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

export function scrollParent(
  element: HTMLElement,
  selector: string,
): HTMLElement | null {
  return element.closest<HTMLElement>(selector);
}

/**
 * Runs `callback` at most once per animation frame, so a burst of scroll or
 * resize events costs one measurement.
 */
export function frameScheduler(callback: () => void): {
  schedule: () => void;
  cancel: () => void;
} {
  let frame = 0;
  return {
    schedule: () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        callback();
      });
    },
    cancel: () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      frame = 0;
    },
  };
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
  // Read from the DOM once; a window resize clears it so zoom or font
  // changes are picked up without measuring on every scroll.
  const rowKnown = useRef(false);
  const virtual = items.length > VIRTUALIZE_THRESHOLD;
  const [range, setRange] = useState<Window>({
    start: 0,
    end: Math.min(items.length, OVERSCAN_ROWS * 3),
    height: rowHeight,
  });

  useLayoutEffect(() => {
    if (!virtual) return undefined;
    const list = listRef.current;
    if (!list) return undefined;
    // Without the expected scroller the window scrolls the list; the range
    // must still follow it, or the list stops after its first rows.
    const scroller = scrollParent(list, scrollParentSelector);
    // A list can be its own scroller (Up Next). Its rows then start at its
    // scroll origin rather than at a viewport edge above it.
    const listScrolls = scroller === list;
    const scrollTarget: EventTarget = scroller ?? window;
    const update = (): void => {
      if (!rowKnown.current) {
        const row = list.querySelector<HTMLElement>(
          ":scope > li:not([aria-hidden])",
        );
        if (row && row.offsetHeight > 0) {
          measured.current = row.offsetHeight;
          rowKnown.current = true;
        }
      }
      const height = measured.current;
      const viewport =
        (scroller ? scroller.clientHeight : 0) || window.innerHeight;
      const above = listScrolls
        ? list.scrollTop
        : Math.max(
            0,
            (scroller ? scroller.getBoundingClientRect().top : 0) -
              list.getBoundingClientRect().top,
          );
      const start = Math.max(0, Math.floor(above / height) - OVERSCAN_ROWS);
      const end = Math.min(
        items.length,
        Math.ceil((above + viewport) / height) + OVERSCAN_ROWS,
      );
      setRange((current) =>
        current.start === start &&
        current.end === end &&
        current.height === height
          ? current
          : { start, end, height },
      );
    };
    const frame = frameScheduler(update);
    const onResize = (): void => {
      rowKnown.current = false;
      frame.schedule();
    };
    update();
    scrollTarget.addEventListener("scroll", frame.schedule, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      frame.cancel();
      scrollTarget.removeEventListener("scroll", frame.schedule);
      window.removeEventListener("resize", onResize);
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
  const height = range.height;
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
