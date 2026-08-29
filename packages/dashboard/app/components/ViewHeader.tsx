import "./ViewHeader.css";
import type { ComponentType, ReactNode } from "react";
import type { LucideProps } from "lucide-react";

/*
FNXC:Navigation 2026-06-22-01:00:
Shared header for main-content views so every left-sidebar destination reads consistently, modeled after Command Center (cc-header/cc-title): an icon + 1.125rem title on the left, optional actions on the right, with the standard --space-lg view padding. Views adopting this should NOT add their own outer top/side padding for the header row.
*/
export interface ViewHeaderProps {
  icon: ComponentType<LucideProps>;
  title: string;
  /** Optional right-aligned actions (buttons, filters, status). */
  actions?: ReactNode;
  /** Optional id for the heading element (for aria-labelledby). */
  titleId?: string;
}

export function ViewHeader({ icon: Icon, title, actions, titleId }: ViewHeaderProps) {
  return (
    <header className="view-header">
      <h2 className="view-header__title" id={titleId}>
        <Icon size={20} aria-hidden="true" />
        <span>{title}</span>
      </h2>
      {actions ? <div className="view-header__actions">{actions}</div> : null}
    </header>
  );
}
