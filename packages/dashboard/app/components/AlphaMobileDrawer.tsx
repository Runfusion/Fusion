import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import "./AlphaMobileDrawer.css";

export interface AlphaMobileDrawerProps {
  open: boolean;
  title: ReactNode;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  keepMounted?: boolean;
  /** Reserve the visible Alpha pill; modal utilities that hide it reserve only the system inset. */
  avoidMobileNav?: boolean;
  testId?: string;
}

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/*
FNXC:AlphaMobileDrawer 2026-09-10-04:41:
Alpha mobile keeps Board as the permanent project surface and presents every other destination in one bounded modal drawer. The shared shell owns the visible Board reveal, pill clearance, independent scrolling, Escape/backdrop close, focus containment, and trigger-focus restoration so individual destinations do not invent competing mobile sheets.
*/
export function AlphaMobileDrawer({
  open,
  title,
  closeLabel,
  onClose,
  children,
  className,
  keepMounted = false,
  avoidMobileNav = true,
  testId = "alpha-mobile-drawer",
}: AlphaMobileDrawerProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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
      className={`alpha-mobile-drawer${open ? " alpha-mobile-drawer--open" : " alpha-mobile-drawer--hidden"}${avoidMobileNav ? "" : " alpha-mobile-drawer--without-pill"}${className ? ` ${className}` : ""}`}
      data-testid={testId}
      aria-hidden={!open || undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        className="alpha-mobile-drawer__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        tabIndex={-1}
      >
        <div className="alpha-mobile-drawer__handle" aria-hidden="true" />
        <header className="alpha-mobile-drawer__header">
          <h2 id={`${testId}-title`} className="alpha-mobile-drawer__title">{title}</h2>
          <button type="button" className="alpha-mobile-drawer__close" onClick={onClose} aria-label={closeLabel}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="alpha-mobile-drawer__body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
