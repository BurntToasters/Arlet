import type { ComponentChildren, JSX } from "preact";
import type { LucideIcon } from "lucide-preact";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ComponentChildren;
  compact?: boolean;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
}: EmptyStateProps): JSX.Element {
  return (
    <section className={`empty-state ${compact ? "compact" : ""}`.trim()}>
      <span className="empty-icon">
        <Icon aria-hidden="true" size={compact ? 22 : 30} strokeWidth={1.6} />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <div className="empty-action">{action}</div> : null}
    </section>
  );
}
