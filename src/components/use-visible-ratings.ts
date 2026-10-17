import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useAppSelector } from "../app/context.tsx";
import {
  ratingKeyOf,
  requestRatings,
  type RatingTarget,
} from "../app/ratings.ts";
import { getState } from "../state.ts";

// Ids gathered this long go out together. Rows mounted in one pass coalesce.
const BATCH_DELAY_MS = 80;
// Apple's ratings endpoint takes up to 100 ids per request.
const BATCH_SIZE = 100;
// Rows load a little before they scroll into view.
const VIEW_MARGIN = "240px 0px";

// Waiting ids keyed by rating key. Rows share one batch across the app.
const waiting = new Map<string, RatingTarget>();
let flushTimer: number | undefined;

function flushWaiting(): void {
  flushTimer = undefined;
  const targets = [...waiting.values()];
  waiting.clear();
  // A failed id is not retried here; its row queues again only when it is
  // next scrolled into view.
  void requestRatings(targets);
}

function queueRating(target: RatingTarget, key: string): void {
  // A stored value needs no request, and a waiting id is already queued.
  if (getState().ratings[key] !== undefined) return;
  waiting.set(key, target);
  if (flushTimer !== undefined) window.clearTimeout(flushTimer);
  if (waiting.size >= BATCH_SIZE) {
    flushWaiting();
    return;
  }
  flushTimer = window.setTimeout(flushWaiting, BATCH_DELAY_MS);
}

type VisibleListener = () => void;

// One observer serves every rating row instead of one per row. The margin is
// the same for all rows, and the default viewport root clips rows that sit
// inside a scroll container, so a single observer covers each scroll root.
const visibleListeners = new Map<Element, VisibleListener>();
let sharedVisibleObserver: IntersectionObserver | undefined;

function observeVisible(
  element: Element,
  listener: VisibleListener,
): () => void {
  sharedVisibleObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visibleListeners.get(entry.target)?.();
      }
    },
    { rootMargin: VIEW_MARGIN },
  );
  visibleListeners.set(element, listener);
  sharedVisibleObserver.observe(element);
  return () => {
    sharedVisibleObserver?.unobserve(element);
    visibleListeners.delete(element);
  };
}

/**
 * Queues a rating lookup for a row once it nears the viewport. Lookups run
 * only for a signed-in, online app. Attach the returned ref to the row element.
 */
export function useVisibleRatingLookup<T extends HTMLElement>(
  target: RatingTarget | undefined,
): RefObject<T | null> {
  const ref = useRef<T>(null);
  // The effect reads the latest target; its key decides when to re-observe.
  const targetRef = useRef(target);
  targetRef.current = target;
  const key = target ? ratingKeyOf(target) : undefined;
  const online = useAppSelector(
    (state) => state.auth.status === "authorized" && !state.library.offline,
  );
  useEffect(() => {
    const element = ref.current;
    if (!online || key === undefined || !element) return undefined;
    const queue = (): void => {
      const current = targetRef.current;
      if (current) queueRating(current, key);
    };
    if (typeof IntersectionObserver === "undefined") {
      queue();
      return undefined;
    }
    // Stays observed, so a row that scrolls back into view is queued again.
    // Ids already stored or in flight are skipped, so this costs little.
    return observeVisible(element, queue);
  }, [online, key]);
  return ref;
}
