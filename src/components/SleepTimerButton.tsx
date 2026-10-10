import { Timer } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useAppController, useAppState } from "../app/context.tsx";
import type { SleepTimerOption } from "../app/sleep-timer.ts";
import type { SleepTimerState } from "../domain/music.ts";
import { reportActionError } from "./action-errors.ts";

const MINUTE_OPTIONS = [15, 30, 45, 60];
const REFRESH_MS = 15_000;

/** Short text for the active timer, or undefined when none is armed. */
export function sleepTimerLabel(
  timer: SleepTimerState | undefined,
  now: number,
): string | undefined {
  if (!timer) return undefined;
  if (timer.mode === "endOfTrack") return "End of track";
  return `${Math.max(0, Math.ceil((timer.endsAt - now) / 60_000))} min`;
}

/** Sleep timer menu for the player bar; the timer itself lives in the controller. */
export function SleepTimerButton(): JSX.Element {
  const state = useAppState();
  const controller = useAppController();
  const timer = state.playback.sleepTimer;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number }>();
  const [now, setNow] = useState(() => Date.now());
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const endsAt = timer?.mode === "minutes" ? timer.endsAt : undefined;

  useEffect(() => {
    if (endsAt === undefined) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [endsAt]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (
        !buttonRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (event.key === "Tab") {
        setOpen(false);
        return;
      }
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          "button[role='menuitem']",
        ) ?? [],
      );
      if (!items.length) return;
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        items[(index + delta + items.length) % items.length]?.focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        (event.key === "Home" ? items[0] : items.at(-1))?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // A menu takes focus on open so arrow keys work right away.
    menuRef.current
      ?.querySelector<HTMLButtonElement>("button[role='menuitem']")
      ?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = (): void => {
    if (!open) {
      const rect = buttonRef.current?.getBoundingClientRect();
      setAnchor(
        rect
          ? {
              left: rect.left,
              bottom: window.innerHeight - rect.top + 8,
            }
          : undefined,
      );
    }
    setOpen(!open);
  };

  const choose = (option: SleepTimerOption | undefined): void => {
    setOpen(false);
    try {
      if (option) controller.startSleepTimer?.(option);
      else controller.cancelSleepTimer?.();
    } catch (error) {
      reportActionError(error);
    }
  };

  const label = sleepTimerLabel(timer, now);
  return (
    <>
      <button
        ref={buttonRef}
        className={`icon-button sleep-timer-button${timer ? " is-active" : ""}`}
        type="button"
        aria-label="Sleep timer"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <Timer aria-hidden="true" size={18} strokeWidth={1.8} />
        {label ? <span className="sleep-timer-label">{label}</span> : null}
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="context-menu sleep-timer-menu"
          role="menu"
          aria-label="Sleep timer options"
          style={anchor}
        >
          {MINUTE_OPTIONS.map((minutes) => (
            <button
              key={minutes}
              className="context-menu-item"
              type="button"
              role="menuitem"
              onClick={() => choose({ mode: "minutes", minutes })}
            >
              {minutes} minutes
            </button>
          ))}
          <button
            className="context-menu-item"
            type="button"
            role="menuitem"
            onClick={() => choose({ mode: "endOfTrack" })}
          >
            End of track
          </button>
          <button
            className="context-menu-item"
            type="button"
            role="menuitem"
            onClick={() => choose(undefined)}
          >
            Off
          </button>
        </div>
      ) : null}
    </>
  );
}
