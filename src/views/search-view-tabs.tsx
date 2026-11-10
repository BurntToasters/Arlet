import type { JSX } from "preact";
import { SEARCH_SOURCES } from "./search-view-model.ts";

export function SearchSourceTabs({
  source,
  tabRefs,
  onSelect,
}: {
  source: "catalog" | "library";
  tabRefs: { current: (HTMLButtonElement | null)[] };
  onSelect: (next: "catalog" | "library") => void;
}): JSX.Element {
  // Arrow keys, Home and End move and activate a tab, as in the tabs pattern.
  const onSourceTabKeyDown = (event: KeyboardEvent): void => {
    const current = SEARCH_SOURCES.findIndex((tab) => tab.id === source);
    const count = SEARCH_SOURCES.length;
    const next =
      event.key === "ArrowRight"
        ? (current + 1) % count
        : event.key === "ArrowLeft"
          ? (current - 1 + count) % count
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const tab = SEARCH_SOURCES[next];
    if (!tab) return;
    onSelect(tab.id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div
      className="search-source-tabs"
      role="tablist"
      aria-label="Search source"
      onKeyDown={onSourceTabKeyDown}
    >
      {SEARCH_SOURCES.map((tab, index) => {
        const selected = source === tab.id;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            id={`search-source-tab-${tab.id}`}
            className={selected ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls="search-source-panel"
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
