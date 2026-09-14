import type { ComponentChildren, JSX } from "preact";
import type { LucideIcon } from "lucide-preact";

export interface IconButtonProps {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
  children?: ComponentChildren;
  type?: "button" | "submit";
}

export function IconButton({
  icon: Icon,
  label,
  onClick,
  pressed,
  disabled = false,
  className = "",
  children,
  type = "button",
}: IconButtonProps): JSX.Element {
  return (
    <button
      className={`icon-button ${className}`.trim()}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
      {children}
    </button>
  );
}
