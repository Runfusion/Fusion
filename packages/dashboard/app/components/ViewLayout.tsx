import { createElement, forwardRef, type ElementType, type HTMLAttributes, type ReactNode } from "react";
import "./ViewLayout.css";

export type ViewLayoutMobilePane = "list" | "detail";

export interface ViewLayoutZoneProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
}

/*
FNXC:StandardizedViewZones 2026-09-13-16:30:
Drawers, floating windows, terminals, and Task Detail share semantic Header → Tabs? → Content → Footer? zones without inserting another visual wrapper or scroller. Zone primitives preserve each owner's element, class, ref, and interaction contract while making chrome ownership explicit.
*/
type ViewLayoutZoneName = "header" | "tabs" | "content" | "footer";

function createViewLayoutZone(zone: ViewLayoutZoneName) {
  return forwardRef<HTMLElement, ViewLayoutZoneProps>(function SharedViewLayoutZone(
    { as = "div", className, ...props },
    ref,
  ) {
    return createElement(as, {
      ...props,
      ref,
      className: ["view-layout-zone", `view-layout-zone--${zone}`, className].filter(Boolean).join(" "),
      "data-view-layout-zone": zone,
    });
  });
}

export const ViewLayoutHeader = createViewLayoutZone("header");
export const ViewLayoutTabs = createViewLayoutZone("tabs");
export const ViewLayoutContent = createViewLayoutZone("content");
export const ViewLayoutFooter = createViewLayoutZone("footer");

export interface ViewLayoutProps extends HTMLAttributes<HTMLDivElement> {
  header: ReactNode;
  tabs?: ReactNode;
  sidebar?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Controls the single visible pane on phones; desktop and tablet always retain both panes. */
  mobilePane?: ViewLayoutMobilePane;
  /** The detail child owns its entire bounded scroll chain (terminal, canvas, transcript, or table). */
  contentOwnsScroll?: boolean;
}

/*
FNXC:StandardizedViewLayout 2026-09-13-16:12:
Dashboard destinations and drawers compose the same four zones in order: Header, optional Tabs, bounded Content, and optional Footer. Missing tabs or footer render no wrapper or reserved space, and layout alone never fetches, creates, or selects business data.

FNXC:StandardizedViewLayout 2026-09-13-16:12:
Desktop and tablet keep collection and detail mounted side by side. Phone navigation changes only which pane is presented, preserving controller, draft, stream, focus, and request identity instead of remounting the business view.
*/
export function ViewLayout({
  header,
  tabs,
  sidebar,
  children,
  footer,
  mobilePane,
  contentOwnsScroll = false,
  className,
  ...props
}: ViewLayoutProps) {
  return (
    <div
      {...props}
      className={["view-layout", contentOwnsScroll ? "view-layout--content-owns-scroll" : "", className].filter(Boolean).join(" ")}
      data-mobile-pane={mobilePane}
    >
      {header}
      {tabs != null ? <div className="view-layout__tabs" data-testid="view-layout-tabs">{tabs}</div> : null}
      <div className="view-layout__body">
        {sidebar != null ? <div className="view-layout__sidebar-slot">{sidebar}</div> : null}
        <div className="view-layout__content" data-testid="view-layout-content">{children}</div>
      </div>
      {footer != null ? <footer className="view-layout__footer" data-testid="view-layout-footer">{footer}</footer> : null}
    </div>
  );
}
