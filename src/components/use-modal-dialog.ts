import { useLayoutEffect, useRef } from "preact/hooks";

/** Everything a modal can Tab to. Shared so dialogs agree on focus order. */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalDialogOptions {
  /** Whether the dialog is showing. Defaults to true. */
  active?: boolean;
  /** Focused on activation, synchronously unless deferFocus is set. */
  initialFocus?: () => HTMLElement | null | undefined;
  /** Focus after a timer tick, so a key that opened the dialog cannot press it. */
  deferFocus?: boolean;
  /** Elements Tab cycles through. Defaults to FOCUSABLE_SELECTOR. */
  selector?: string;
  /** Focused on close if focus was lost. Defaults to the element focused on open. */
  returnFocus?: HTMLElement | null | (() => HTMLElement | null | undefined);
  /** Escape handler. The caller decides preventDefault and stopPropagation. */
  onEscape?: (event: KeyboardEvent) => void;
  /** Also handle Escape when focus is outside the dialog. */
  escapeAnywhere?: boolean;
  /** Listen in the capture phase, before the page's own key handlers. */
  capture?: boolean;
}

function isShown(element: HTMLElement): boolean {
  return (
    !element.matches(":disabled, [aria-disabled='true']") &&
    !element.closest("[hidden], [inert]") &&
    element.getClientRects().length > 0
  );
}

/** Wraps Tab and Shift+Tab at the dialog edges, and pulls focus back in. */
function trapTab(
  dialog: HTMLElement,
  event: KeyboardEvent,
  selector: string,
): void {
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(selector),
  ).filter(isShown);
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  const outside = !dialog.contains(active);
  const wrap = event.shiftKey
    ? active === first || outside
    : active === last || outside;
  if (wrap) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

function resolveOpener(
  returnFocus: ModalDialogOptions["returnFocus"],
): HTMLElement | null {
  if (returnFocus === undefined) {
    return document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }
  return typeof returnFocus === "function"
    ? (returnFocus() ?? null)
    : returnFocus;
}

/**
 * Traps Tab in a modal dialog, routes Escape, and moves focus in and back
 * out. Keys are listened for on the document so focus outside is pulled in.
 */
export function useModalDialog<T extends HTMLElement>(
  dialogRef: { readonly current: T | null },
  options: ModalDialogOptions = {},
): void {
  const latest = useRef(options);
  latest.current = options;
  const active = options.active ?? true;
  const capture = options.capture === true;

  useLayoutEffect(() => {
    if (!active) return undefined;
    const dialog = dialogRef.current;
    const opener = resolveOpener(latest.current.returnFocus);
    const focusInitial = (): void => {
      latest.current.initialFocus?.()?.focus();
    };
    let focusTimer: number | undefined;
    if (latest.current.deferFocus)
      focusTimer = window.setTimeout(focusInitial, 0);
    else focusInitial();
    const onKeyDown = (event: KeyboardEvent): void => {
      const node = dialogRef.current;
      if (event.key === "Escape") {
        const { onEscape, escapeAnywhere } = latest.current;
        const inside = node?.contains(event.target as Node | null) ?? false;
        if (onEscape && (escapeAnywhere || inside)) onEscape(event);
        return;
      }
      if (event.key === "Tab" && node) {
        trapTab(node, event, latest.current.selector ?? FOCUSABLE_SELECTOR);
      }
    };
    document.addEventListener("keydown", onKeyDown, capture);
    return () => {
      if (focusTimer !== undefined) window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown, capture);
      const current = document.activeElement;
      const lost =
        !current ||
        current === document.body ||
        Boolean(dialog?.contains(current));
      if (opener?.isConnected && lost) opener.focus();
    };
  }, [active, capture, dialogRef]);
}
