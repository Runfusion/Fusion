import "./ViewHeader.css";
import type { ComponentType, HTMLAttributes, ReactNode, Ref } from "react";
import type { LucideProps } from "lucide-react";
import { ModalCloseButton, type ModalCloseButtonProps } from "./ModalCloseButton";
import { ViewBackButton, type ViewBackButtonProps } from "./ViewActionButton";

/*
FNXC:StandardizedViewHeader 2026-09-13-16:12:
ViewHeader is the single visible title/action owner for dashboard destinations and hosted drawers. Dynamic identity may be rich content, while list-to-detail navigation is always one tactile ChevronLeft before the icon and title rather than a separate Back row.
*/
export interface ViewHeaderBackAction extends Omit<ViewBackButtonProps, "label"> {
  label: string;
  "data-testid"?: string;
}

export interface ViewHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  icon?: ComponentType<LucideProps>;
  title: ReactNode;
  /** Optional right-aligned actions (buttons, filters, status). */
  actions?: ReactNode;
  /** Optional id for the heading element (for aria-labelledby). */
  titleId?: string;
  /** Optional list-to-detail navigation rendered before the owning title. */
  backAction?: ViewHeaderBackAction;
  /** Optional close action when this header is the sole chrome of a floating view. */
  onClose?: () => void;
  /** Host-specific accessible label, title, classes, and test hooks for the canonical close control. */
  closeButtonProps?: Omit<ModalCloseButtonProps, "onClick">;
  /*
  FNXC:StandardizedViewHeader 2026-09-13-22:40:
  FN-379 remediation: media viewers focus their close control when the surface opens. Adopting the shared header
  must not cost them that focus owner, so the host keeps passing its own ref through the canonical control.
  */
  closeButtonRef?: Ref<HTMLButtonElement>;
  /** Test hook for the title content without constraining its markup. */
  titleTestId?: string;
  /*
  FNXC:StandardizedViewHeader 2026-09-13-21:49:
  FN-379 migrates nested dialogs and confirmations onto the shared header. Those surfaces sit BELOW an owning
  destination heading, so they may declare their existing heading rank instead of silently promoting themselves to
  h2 and breaking the document outline of the screen that hosts them. Chrome, tokens, and actions stay shared.
  */
  headingLevel?: 2 | 3;
}

export function ViewHeader({
  icon: Icon,
  title,
  actions,
  titleId,
  titleTestId,
  headingLevel = 2,
  backAction,
  onClose,
  closeButtonProps,
  closeButtonRef,
  className,
  ...headerProps
}: ViewHeaderProps) {
  const closeLabel = closeButtonProps?.["aria-label"]
    ?? (typeof title === "string" ? `Close ${title}` : "Close");
  return (
    <header {...headerProps} className={["view-header", className].filter(Boolean).join(" ")}>
      {backAction ? <ViewBackButton {...backAction} /> : null}
      {headingLevel === 3 ? (
        <h3 className="view-header__title" id={titleId}>
          {Icon ? <Icon aria-hidden="true" /> : null}
          <span className="view-header__title-content" data-testid={titleTestId}>{title}</span>
        </h3>
      ) : (
        <h2 className="view-header__title" id={titleId}>
          {Icon ? <Icon aria-hidden="true" /> : null}
          <span className="view-header__title-content" data-testid={titleTestId}>{title}</span>
        </h2>
      )}
      {actions != null || onClose ? (
        <div className="view-header__actions">
          {actions}
          {onClose ? <ModalCloseButton {...closeButtonProps} ref={closeButtonRef} aria-label={closeLabel} onClick={onClose} /> : null}
        </div>
      ) : null}
    </header>
  );
}
