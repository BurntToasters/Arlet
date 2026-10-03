import { CircleAlert, X } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ACTION_ERROR_EVENT } from "./action-errors.ts";

export const ACTION_TOAST_LIMIT = 3;
export const ACTION_TOAST_TIMEOUT_MS = 6_000;

interface Toast {
  id: number;
  message: string;
}

/** Bottom-right stack of failed-action messages, newest last. */
export function ActionToasts(): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = (id: number): void => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  };

  useEffect(() => {
    const onError = (event: Event): void => {
      const message = (event as CustomEvent<string>).detail;
      if (!message) return;
      const id = ++nextId.current;
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), ACTION_TOAST_TIMEOUT_MS),
      );
      setToasts((current) =>
        [
          ...current.filter((toast) => toast.message !== message),
          { id, message },
        ].slice(-ACTION_TOAST_LIMIT),
      );
    };
    window.addEventListener(ACTION_ERROR_EVENT, onError);
    const pending = timers.current;
    return () => {
      window.removeEventListener(ACTION_ERROR_EVENT, onError);
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return (
    <div className="action-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div className="action-toast" key={toast.id}>
          <CircleAlert aria-hidden="true" size={16} strokeWidth={1.9} />
          <span className="action-toast-message">{toast.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(toast.id)}
          >
            <X aria-hidden="true" size={14} strokeWidth={1.9} />
          </button>
        </div>
      ))}
    </div>
  );
}
