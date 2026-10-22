import { Fragment, type ComponentChildren, type JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  VIRTUALIZE_THRESHOLD,
  frameScheduler,
  scrollParent,
} from "./VirtualList.tsx";

/** Gap between cards and rows; matches `.library-card-grid` in CSS. */
const GAP = 12;
/** Card height until one is rendered and measured. */
const FALLBACK_CARD_HEIGHT = 240;
const OVERSCAN_ROWS = 4;

interface GridWindow {
  columns: number;
  cardHeight: number;
  startRow: number;
  endRow: number;
}

export interface VirtualGridProps<T> {
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ComponentChildren;
  /** Narrowest card; columns fill the width like `minmax(min, 1fr)`. */
  minCardWidth?: number;
  /** Grid class for the cards. Virtual rows reuse it, so the look matches. */
  className?: string;
  /** Ancestor that scrolls the grid. Defaults to the main content scroller. */
  scrollParentSelector?: string;
}

/** Column count the CSS `repeat(auto-fit, minmax(min, 1fr))` would pick. */
function columnCount(width: number, minCardWidth: number): number {
  return Math.max(1, Math.floor((width + GAP) / (minCardWidth + GAP)));
}

/**
 * A card grid that renders only the rows inside the scroll viewport (plus
 * overscan) once a grid is large. Spacer blocks keep the scrollbar honest.
 * Every card has the height of the first rendered card.
 */
export function VirtualGrid<T>({
  items,
  getKey,
  renderItem,
  minCardWidth = 180,
  className = "",
  scrollParentSelector = ".content-scroll",
}: VirtualGridProps<T>): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  // Null until a card is in the DOM. A width change clears it, because the
  // artwork is square and card height follows card width.
  const measuredHeight = useRef<number | null>(null);
  const updateRef = useRef<() => void>(() => undefined);
  const virtual = items.length > VIRTUALIZE_THRESHOLD;
  const [view, setView] = useState<GridWindow>({
    columns: 1,
    cardHeight: FALLBACK_CARD_HEIGHT,
    startRow: 0,
    endRow: 0,
  });

  useLayoutEffect(() => {
    if (!virtual) return undefined;
    const root = rootRef.current;
    if (!root) return undefined;
    const scroller = scrollParent(root, scrollParentSelector);
    const scrollTarget: EventTarget = scroller ?? window;
    const update = (): void => {
      if (measuredHeight.current === null) {
        const card = root.querySelector<HTMLElement>(".virtual-grid-row > *");
        if (card && card.offsetHeight > 0) {
          measuredHeight.current = card.offsetHeight;
        }
      }
      const cardHeight = measuredHeight.current ?? FALLBACK_CARD_HEIGHT;
      const columns = columnCount(root.clientWidth, minCardWidth);
      const rows = Math.ceil(items.length / columns);
      const stride = cardHeight + GAP;
      const viewport =
        (scroller ? scroller.clientHeight : 0) || window.innerHeight;
      const viewportTop = scroller ? scroller.getBoundingClientRect().top : 0;
      const above = Math.max(0, viewportTop - root.getBoundingClientRect().top);
      const startRow = Math.min(
        rows,
        Math.max(0, Math.floor(above / stride) - OVERSCAN_ROWS),
      );
      const endRow = Math.min(
        rows,
        Math.max(
          startRow,
          Math.ceil((above + viewport) / stride) + OVERSCAN_ROWS,
        ),
      );
      setView((current) =>
        current.columns === columns &&
        current.cardHeight === cardHeight &&
        current.startRow === startRow &&
        current.endRow === endRow
          ? current
          : { columns, cardHeight, startRow, endRow },
      );
    };
    updateRef.current = update;
    const frame = frameScheduler(update);
    let width = -1;
    const observer = new ResizeObserver(() => {
      // Only width matters here; the grid's own height changes as rows render.
      if (root.clientWidth === width) return;
      width = root.clientWidth;
      measuredHeight.current = null;
      frame.schedule();
    });
    observer.observe(root);
    update();
    scrollTarget.addEventListener("scroll", frame.schedule, { passive: true });
    return () => {
      frame.cancel();
      observer.disconnect();
      scrollTarget.removeEventListener("scroll", frame.schedule);
      updateRef.current = () => undefined;
    };
  }, [virtual, items.length, minCardWidth, scrollParentSelector]);

  // Cards exist only once the window has rendered, so a height that is still
  // unknown is read from the committed DOM on the next commit.
  useLayoutEffect(() => {
    if (virtual && measuredHeight.current === null) updateRef.current();
  });

  if (!virtual) {
    return (
      <div ref={rootRef} className={className}>
        {items.map((item, index) => (
          <Fragment key={getKey(item, index)}>
            {renderItem(item, index)}
          </Fragment>
        ))}
      </div>
    );
  }
  const { columns, cardHeight, startRow, endRow } = view;
  const rows = Math.ceil(items.length / columns);
  const first = Math.min(startRow, rows);
  const last = Math.min(Math.max(endRow, first), rows);
  const stride = cardHeight + GAP;
  const rowsBelow = rows - last;
  const visibleRows: ComponentChildren[] = [];
  for (let row = first; row < last; row += 1) {
    const from = row * columns;
    const to = Math.min(items.length, from + columns);
    visibleRows.push(
      <div
        key={row}
        className={`virtual-grid-row ${className}`.trim()}
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          marginBottom: `${GAP}px`,
        }}
      >
        {items.slice(from, to).map((item, offset) => (
          <Fragment key={getKey(item, from + offset)}>
            {renderItem(item, from + offset)}
          </Fragment>
        ))}
      </div>,
    );
  }
  // Each row carries a bottom margin of GAP, so the rows below the window
  // take their height less the last gap.
  return (
    <div ref={rootRef}>
      <div aria-hidden="true" style={{ height: `${first * stride}px` }} />
      {visibleRows}
      <div
        aria-hidden="true"
        style={{
          height: `${rowsBelow > 0 ? rowsBelow * stride - GAP : 0}px`,
        }}
      />
    </div>
  );
}
