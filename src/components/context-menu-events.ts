/** Shared browser event used by row action buttons and the native context path. */
export const CONTEXT_MENU_REQUEST = "arlet:open-context-menu";

export interface ContextMenuRequestDetail {
  target: HTMLElement;
  x: number;
  y: number;
  restoreFocus?: HTMLElement;
}

/** Open the application context menu for an element using the same target data as right-click. */
export function requestContextMenu(
  target: HTMLElement,
  anchor: HTMLElement = target,
): void {
  const rect = anchor.getBoundingClientRect();
  window.dispatchEvent(
    new CustomEvent<ContextMenuRequestDetail>(CONTEXT_MENU_REQUEST, {
      detail: {
        target,
        x: Math.min(window.innerWidth - 8, Math.max(8, rect.right - 4)),
        y: Math.min(window.innerHeight - 8, Math.max(8, rect.bottom - 4)),
        restoreFocus: anchor,
      },
    }),
  );
}
