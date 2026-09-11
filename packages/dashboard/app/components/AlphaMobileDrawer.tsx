import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDrawerDismissGesture } from "../hooks/useDrawerDismissGesture";
import "./AlphaMobileDrawer.css";

export interface AlphaMobileDrawerProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  keepMounted?: boolean;
  testId?: string;
  /**
   * When true, the hosted view owns the visible heading row and the drawer only
   * contributes an accessible dialog name plus its close control.
   */
  contentOwnsHeader?: boolean;
  /**
   * When true, the hosted view provides its own bounded central scroller. Keep
   * false for ordinary or headerless content so the drawer body remains scrollable.
   */
  contentOwnsScroll?: boolean;
}

interface AlphaAppDrawerBridgeProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/*
FNXC:AlphaMobileDrawer 2026-09-10-23:59:
Projects and Planning expose their production drawer bridges so browser geometry checks execute the exact ownership flags and mount policy used by App. Keep these bridges as the sole definitions of App-owned Alpha drawer chrome; fixture-only shell copies can drift while remaining green.
*/
export function AlphaProjectsDrawer({ open, title, onClose, children }: AlphaAppDrawerBridgeProps) {
  return (
    <AlphaMobileDrawer open={open} title={title} onClose={onClose} testId="alpha-mobile-drawer-projects" contentOwnsHeader contentOwnsScroll>
      {children}
    </AlphaMobileDrawer>
  );
}

export function AlphaPlanningDrawer({ open, title, onClose, children }: AlphaAppDrawerBridgeProps) {
  return (
    <AlphaMobileDrawer open={open} title={title} onClose={onClose} keepMounted testId="alpha-mobile-drawer-planning" contentOwnsHeader contentOwnsScroll>
      {children}
    </AlphaMobileDrawer>
  );
}

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/*
FNXC:AlphaMobileDrawer 2026-09-10-16:56:
Alpha mobile keeps Board as the permanent project surface and presents every other destination in one bounded modal drawer. The shared shell owns the visible Board reveal, bottom-edge overlay above the trigger pill, internal system-safe clearance, independent scrolling, Escape/backdrop close, focus containment, and trigger-focus restoration so individual destinations do not invent competing mobile sheets.

FNXC:AlphaMobileDrawer 2026-09-11-01:40:
A hosted view with its own header remains the sole visible title/action row. The shell retains a screen-reader dialog name while its real top handle exclusively owns drag-to-dismiss; headerless plugin or fallback content still receives the visible shell title without a close-button reserve.

FNXC:AlphaMobileDrawer 2026-09-10-22:45:
Visible-header ownership and overflow ownership are independent contracts. Only views with a bounded internal flex scroller may suppress body scrolling; ordinary views such as Ideation keep the drawer body as their reachable vertical scroller even when they render their own heading.
*/
export function AlphaMobileDrawer({
  open,
  title,
  onClose,
  children,
  className,
  keepMounted = false,
  testId = "alpha-mobile-drawer",
  contentOwnsHeader = false,
  contentOwnsScroll = false,
}: AlphaMobileDrawerProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissHandleProps = useDrawerDismissGesture({
    enabled: open,
    open,
    panelRef,
    onDismiss: onClose,
  });

  useEffect(() => {
    if (!open) return;
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    panel?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && currentIndex <= 0) {
        event.preventDefault();
        focusable.at(-1)?.focus();
      } else if (!event.shiftKey && currentIndex === focusable.length - 1) {
        event.preventDefault();
        focusable[0]?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      priorFocus?.focus();
    };
  }, [open]);

  if (!open && !keepMounted) return null;

  return createPortal(
    <div
      className={`alpha-mobile-drawer${open ? " alpha-mobile-drawer--open" : " alpha-mobile-drawer--hidden"}${className ? ` ${className}` : ""}`}
      data-testid={testId}
      aria-hidden={!open || undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        className={`alpha-mobile-drawer__panel${contentOwnsHeader ? " alpha-mobile-drawer__panel--content-header" : ""}${contentOwnsScroll ? " alpha-mobile-drawer__panel--content-scroll" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        tabIndex={-1}
      >
        <div className="alpha-mobile-drawer__handle-target" aria-hidden="true" {...dismissHandleProps}>
          <span className="alpha-mobile-drawer__handle" />
        </div>
        {contentOwnsHeader ? (
          <h2 id={`${testId}-title`} className="alpha-mobile-drawer__accessible-title visually-hidden">{title}</h2>
        ) : (
          <header className="alpha-mobile-drawer__header">
            <h2 id={`${testId}-title`} className="alpha-mobile-drawer__title">{title}</h2>
          </header>
        )}
        <div className="alpha-mobile-drawer__body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
