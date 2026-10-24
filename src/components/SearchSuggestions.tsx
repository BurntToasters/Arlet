import { X } from "lucide-preact";
import { Fragment, type JSX } from "preact";
import type { Artwork as ArtworkData } from "../domain/music.ts";
import type { SearchGroupKind } from "../musickit/search.ts";
import { Artwork } from "./Artwork.tsx";

export interface SearchSuggestionOption {
  /** DOM id; the search input points aria-activedescendant at it. */
  id: string;
  label: string;
  detail?: string;
  /** Media rows show a thumbnail; text completions and recents do not. */
  artwork?: ArtworkData;
  mediaKind?: SearchGroupKind;
  /** Curator rows are shown but cannot be opened yet. */
  disabled?: boolean;
  /** Set on recent-search rows, which Delete and the x button remove. */
  recentTerm?: string;
}

export interface SearchSuggestionsProps {
  /** Id of the listbox; the search input's aria-controls names it. */
  listId: string;
  heading: string;
  open: boolean;
  options: readonly SearchSuggestionOption[];
  activeIndex: number;
  /** Rows are from an earlier term while a newer request is in flight. */
  stale?: boolean;
  onSelect(index: number): void;
  onRemoveRecent(term: string): void;
  /** Adds the "Clear recent searches" footer; only recent rows pass it. */
  onClearRecent?: () => void;
}

/**
 * Listbox under the Search field. The input owns focus and the keyboard, so
 * rows are plain options; mousedown is cancelled so the field keeps focus.
 * A polite live region announces the refresh without moving focus.
 */
export function SearchSuggestions({
  listId,
  heading,
  open,
  options,
  activeIndex,
  stale = false,
  onSelect,
  onRemoveRecent,
  onClearRecent,
}: SearchSuggestionsProps): JSX.Element {
  return (
    <Fragment>
      <div
        className={stale ? "search-suggestions is-stale" : "search-suggestions"}
        hidden={!open}
        onMouseDown={(event) => event.preventDefault()}
      >
        <p className="search-suggestions-heading" aria-hidden="true">
          {heading}
        </p>
        <ul
          id={listId}
          className="search-suggestions-list"
          role="listbox"
          aria-busy={stale ? "true" : undefined}
        >
          {options.map((option, index) => (
            <li
              key={option.id}
              id={option.id}
              className={index === activeIndex ? "is-active" : ""}
              role="option"
              aria-selected={index === activeIndex}
              aria-disabled={option.disabled ? "true" : undefined}
              onClick={() => onSelect(index)}
            >
              {option.mediaKind ? (
                // Decorative: the option's text already names the item.
                <Artwork
                  track={{
                    title: option.label,
                    artistName: option.detail ?? "",
                    artwork: option.artwork,
                  }}
                  size="sm"
                  alt=""
                  className={
                    option.mediaKind === "artists"
                      ? "search-suggestion-art is-artist"
                      : "search-suggestion-art"
                  }
                />
              ) : null}
              <span className="search-suggestion-copy">
                <span>{option.label}</span>
                {option.detail ? <small>{option.detail}</small> : null}
              </span>
              {option.recentTerm !== undefined ? (
                // Hidden from assistive tech: Delete on the active row removes it.
                <button
                  className="search-suggestion-remove"
                  type="button"
                  tabIndex={-1}
                  aria-hidden="true"
                  title={`Remove ${option.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveRecent(option.recentTerm ?? "");
                  }}
                >
                  <X aria-hidden="true" size={14} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {onClearRecent && options.length > 0 ? (
          <div className="search-suggestions-footer">
            <button
              className="search-suggestions-clear"
              type="button"
              onClick={onClearRecent}
            >
              Clear recent searches
            </button>
          </div>
        ) : null}
      </div>
      {/* Kept outside the hidden popup so the region exists before it changes. */}
      <p className="sr-only" role="status" aria-live="polite">
        {stale ? "Updating suggestions" : ""}
      </p>
    </Fragment>
  );
}
