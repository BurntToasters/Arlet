import { Star } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type {
  LibraryContentFilter,
  LibrarySort,
  LibraryViewCapabilities,
  LibraryViewOptions,
} from "../library/view-options.ts";

/** Typing waits this long before the list is filtered. */
const FILTER_DELAY_MS = 150;

const SORT_LABELS: Record<LibrarySort, string> = {
  default: "Default order",
  "title-asc": "Title A–Z",
  "title-desc": "Title Z–A",
  "added-desc": "Recently added",
  "added-asc": "Oldest added",
};

function sortLabel(sort: LibrarySort, nameSort: boolean): string {
  if (nameSort && sort === "title-asc") return "Name A–Z";
  if (nameSort && sort === "title-desc") return "Name Z–A";
  return SORT_LABELS[sort];
}

export interface LibraryToolbarProps {
  /** The section title, for the filter's accessible name. */
  title: string;
  /** Artists sort by name rather than title. */
  nameSort: boolean;
  capabilities: LibraryViewCapabilities;
  options: LibraryViewOptions;
  /** The applied filter text. */
  text: string;
  /** Favorites need an authorized, online session. */
  favoritesDisabled: boolean;
  /** Progress note, such as while every page loads. */
  status?: string;
  /** "N of M", while a control is active. */
  count?: string;
  onOptionsChange: (options: LibraryViewOptions) => void;
  onTextChange: (text: string) => void;
}

export function LibraryToolbar({
  title,
  nameSort,
  capabilities,
  options,
  text,
  favoritesDisabled,
  status,
  count,
  onOptionsChange,
  onTextChange,
}: LibraryToolbarProps): JSX.Element {
  // The field shows what was typed; the list follows after a short pause.
  const [draft, setDraft] = useState(text);
  const appliedRef = useRef(text);
  const timerRef = useRef<number | undefined>(undefined);

  // A change from outside (Clear filters) replaces the field and drops any
  // pending apply.
  useEffect(() => {
    if (text === appliedRef.current) return;
    window.clearTimeout(timerRef.current);
    appliedRef.current = text;
    setDraft(text);
  }, [text]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const changeDraft = (value: string): void => {
    setDraft(value);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      appliedRef.current = value;
      onTextChange(value);
    }, FILTER_DELAY_MS);
  };

  return (
    <div className="library-toolbar">
      <div className="library-toolbar-controls">
        <input
          className="library-toolbar-filter"
          type="search"
          data-library-filter
          aria-label={`Filter ${title}`}
          placeholder="Filter"
          value={draft}
          onInput={(event) => changeDraft(event.currentTarget.value)}
        />
        <select
          data-library-sort
          aria-label="Sort"
          value={options.sort}
          onChange={(event) =>
            onOptionsChange({
              ...options,
              sort: event.currentTarget.value as LibrarySort,
            })
          }
        >
          {capabilities.sorts.map((sort) => (
            <option key={sort} value={sort}>
              {sortLabel(sort, nameSort)}
            </option>
          ))}
        </select>
        {capabilities.favorites ? (
          <button
            className="secondary-button library-toolbar-toggle"
            type="button"
            data-library-favorites
            aria-pressed={options.favorites}
            disabled={favoritesDisabled}
            onClick={() =>
              onOptionsChange({ ...options, favorites: !options.favorites })
            }
          >
            <Star
              aria-hidden="true"
              size={16}
              fill={options.favorites ? "currentColor" : "none"}
            />
            Favorites
          </button>
        ) : null}
        {capabilities.content ? (
          <select
            data-library-content
            aria-label="Content"
            value={options.content}
            onChange={(event) =>
              onOptionsChange({
                ...options,
                content: event.currentTarget.value as LibraryContentFilter,
              })
            }
          >
            <option value="all">All content</option>
            <option value="explicit">Explicit</option>
            <option value="clean">Clean</option>
          </select>
        ) : null}
      </div>
      {status || count ? (
        <div className="library-toolbar-status">
          {status ? (
            <span data-library-loading-all role="status">
              {status}
            </span>
          ) : null}
          {count ? <span className="library-result-count">{count}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
