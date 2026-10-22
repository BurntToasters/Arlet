import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import type { Track } from "../domain/music.ts";

/** Drag type for song rows. Its payload is a JSON array of track ids. */
export const TRACK_DRAG_TYPE = "application/x-arlet-tracks";

/**
 * The selection of the song list on screen, when it holds 2 or more songs.
 * `owner` is that list's panel, so a row with the same song in another panel
 * (the queue drawer, say) does not pick up the selection.
 */
let activeSelection:
  { tracks: readonly Track[]; owner: HTMLElement | null } | undefined;

export function setActiveSelection(
  tracks: readonly Track[] | undefined,
  owner: HTMLElement | null = null,
): void {
  activeSelection = tracks && tracks.length > 1 ? { tracks, owner } : undefined;
}

/**
 * The selected songs, in list order, when `trackId` is one of 2 or more
 * selected songs and `from` (a row) sits in the selecting list. Undefined
 * otherwise, so a single row keeps its menu.
 */
export function activeSelectionFor(
  trackId: string,
  from: Element | null,
): Track[] | undefined {
  const active = activeSelection;
  if (!active || !from || !active.owner?.contains(from)) return undefined;
  if (!active.tracks.some((track) => track.id === trackId)) return undefined;
  return [...active.tracks];
}

/** The songs of the drag in progress, from dragstart to dragend. */
let dragPayload: readonly Track[] | undefined;

export function startTrackDrag(tracks: readonly Track[]): void {
  dragPayload = tracks;
}

export function endTrackDrag(): void {
  dragPayload = undefined;
}

export function draggedTracks(): readonly Track[] | undefined {
  return dragPayload;
}

/**
 * True when a drag carries songs. Only the type list is read, because a
 * dragover handler cannot read the data.
 */
export function isTrackDrag(
  dataTransfer: DataTransfer | null | undefined,
): boolean {
  return Boolean(
    dataTransfer && Array.from(dataTransfer.types).includes(TRACK_DRAG_TYPE),
  );
}

export interface TrackSelection {
  /** The selected songs, in list order. */
  tracks: Track[];
  isSelected: (trackId: string) => boolean;
  /**
   * Ctrl or Meta toggles a row, Shift selects the range from the anchor. A
   * plain click only moves the anchor. Returns true when the click was a
   * selection gesture, so the row must not play.
   */
  handleClick: (event: MouseEvent, track: Track) => boolean;
  selectAll: () => void;
  clear: () => void;
  /** Ctrl+A selects the loaded rows; Escape clears a selection. */
  onKeyDown: (event: KeyboardEvent) => void;
  /** Callback ref for the list panel the selection belongs to. */
  setPanel: (node: HTMLElement | null) => void;
}

/**
 * Multi-select for one song list. The selection is kept by track id, so it
 * survives rows leaving the DOM. `scope` names the list (section or album
 * or playlist); a change of scope clears the selection.
 */
export function useTrackSelection(
  tracks: readonly Track[],
  scope: string,
): TrackSelection {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const anchorRef = useRef<string | undefined>(undefined);
  const panelRef = useRef<HTMLElement | null>(null);
  const setPanel = useCallback((node: HTMLElement | null) => {
    panelRef.current = node;
  }, []);
  const selected = useMemo(
    () => tracks.filter((track) => ids.has(track.id)),
    [tracks, ids],
  );

  useLayoutEffect(() => {
    anchorRef.current = undefined;
    setIds((current) => (current.size ? new Set() : current));
  }, [scope]);

  // Drops selected songs that a filter or a new sort has hidden.
  useLayoutEffect(() => {
    if (!tracks.length) return;
    setIds((current) => {
      if (current.size === 0) return current;
      const loaded = new Set(tracks.map((track) => track.id));
      const kept = new Set([...current].filter((id) => loaded.has(id)));
      return kept.size === current.size ? current : kept;
    });
  }, [tracks]);

  // Read by the context menu and by dragstart, so it follows every change.
  useLayoutEffect(() => {
    setActiveSelection(selected, panelRef.current);
  }, [selected]);
  useLayoutEffect(() => () => setActiveSelection(undefined), []);

  const selectAll = (): void => {
    if (!tracks.length) return;
    anchorRef.current = tracks[0]?.id;
    setIds(new Set(tracks.map((track) => track.id)));
  };

  const clear = (): void => {
    anchorRef.current = undefined;
    setIds((current) => (current.size ? new Set() : current));
  };

  const handleClick = (event: MouseEvent, track: Track): boolean => {
    const toggle = event.ctrlKey || event.metaKey;
    if (!toggle && !event.shiftKey) {
      anchorRef.current = track.id;
      return false;
    }
    const anchorIndex = tracks.findIndex(
      (item) => item.id === anchorRef.current,
    );
    const targetIndex = tracks.findIndex((item) => item.id === track.id);
    if (event.shiftKey) {
      // Without a usable anchor, Shift starts a selection at this row.
      if (anchorIndex < 0 || targetIndex < 0) {
        anchorRef.current = track.id;
        setIds(new Set([track.id]));
        return true;
      }
      const from = Math.min(anchorIndex, targetIndex);
      const to = Math.max(anchorIndex, targetIndex);
      const range = tracks.slice(from, to + 1).map((item) => item.id);
      setIds(toggle ? new Set([...ids, ...range]) : new Set(range));
      return true;
    }
    anchorRef.current = track.id;
    setIds((current) => {
      const next = new Set(current);
      if (next.has(track.id)) next.delete(track.id);
      else next.add(track.id);
      return next;
    });
    return true;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      event.key.toLowerCase() === "a"
    ) {
      if (!tracks.length) return;
      event.preventDefault();
      selectAll();
      return;
    }
    if (event.key === "Escape" && ids.size > 0) {
      event.preventDefault();
      clear();
    }
  };

  return {
    tracks: selected,
    isSelected: (trackId) => ids.has(trackId),
    handleClick,
    selectAll,
    clear,
    onKeyDown,
    setPanel,
  };
}
