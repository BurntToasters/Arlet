import { MoreHorizontal, Play } from "lucide-preact";
import type { ComponentChildren, JSX } from "preact";
import { requestContextMenu } from "./context-menu-events.ts";
import { catalogLinkOf } from "./context-target.ts";

export interface CardShellProps {
  /** Context-menu attributes; the card's "..." button reads them. */
  contextData?: Record<string, string>;
  catalogUrl?: string;
  children: ComponentChildren;
}

/**
 * Wraps a card so Play and "..." can sit beside its open button rather than
 * inside it, which keeps the buttons out of the button's own click path.
 */
export function CardShell({
  contextData,
  catalogUrl,
  children,
}: CardShellProps): JSX.Element {
  return (
    <div
      className="card-shell"
      {...contextData}
      data-context-catalog-url={catalogLinkOf(catalogUrl)}
    >
      {children}
    </div>
  );
}

export interface CardActionsProps {
  /** Item title; names the buttons for assistive tech. */
  title: string;
  /** Starts playback. Omit for items that cannot play, which hides Play. */
  onPlay?: () => void;
  /** Opens the enclosing card's context menu. */
  menu?: boolean;
}

/** Play and "..." buttons, revealed on card hover or keyboard focus. */
export function CardActions({
  title,
  onPlay,
  menu = true,
}: CardActionsProps): JSX.Element {
  return (
    <div className="card-actions">
      {onPlay ? (
        <button
          className="card-action card-action-play"
          type="button"
          aria-label={`Play ${title}`}
          title="Play"
          onClick={onPlay}
        >
          <Play aria-hidden="true" size={18} fill="currentColor" />
        </button>
      ) : null}
      {menu ? (
        <button
          className="card-action card-action-more"
          type="button"
          aria-label={`More actions for ${title}`}
          title="More actions"
          aria-haspopup="menu"
          onClick={(event) => {
            const button = event.currentTarget;
            const card = button.closest<HTMLElement>("[data-context-kind]");
            if (card) requestContextMenu(card, button);
          }}
        >
          <MoreHorizontal aria-hidden="true" size={17} strokeWidth={1.9} />
        </button>
      ) : null}
    </div>
  );
}
