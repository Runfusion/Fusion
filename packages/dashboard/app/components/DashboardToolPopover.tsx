import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DashboardWindowSurfaceRoot } from "../context/DashboardWindowManagerContext";
import "./DashboardToolPopover.css";

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;
const DEFAULT_WIDTH = 420;

export interface DashboardToolPopoverProps {
  /** Rendered only while true; the body is unmounted on close so it holds no polling or subscriptions. */
  open: boolean;
  onClose: () => void;
  /** Live rect of the trigger. Re-read on every open so a moved header re-anchors correctly. */
  anchorRect: DOMRect | null;
  /** Accessible name of the panel. */
  ariaLabel: string;
  /** Id shared with the trigger's `aria-controls`. */
  id: string;
  testId?: string;
  width?: number;
  children: ReactNode;
}

/*
FNXC:ToolSurfaces 2026-09-15-16:04:
FN-426 needs a reusable header-anchored panel for Activity and Notes, the two tools whose canonical host used to be
the right dock. It deliberately reuses the SHAPE the Usage popover established — body portal, transparent dismiss
backdrop, `--fusion-max-z` derived layering — rather than its business logic or its hard-coded sizing constants, which
belong to Usage.

Contract:
- The body mounts only while open, so a closed panel runs no polling, no timers, and no subscriptions.
- Geometry is bounded to the viewport and recomputed on resize, so a narrow or short window never pushes the panel
  off-screen; the panel owns a bounded internal scroll (`min-block-size: 0` on its body) instead of growing.
- Escape and an outside pointer close it and return focus to the trigger, and a portalled CHILD (a select popup, a
  nested menu) must not trigger that dismissal — the backdrop is an explicit sibling element, so only a click that
  actually lands on it dismisses.
*/
export function DashboardToolPopover({ open, onClose, anchorRect, ariaLabel, id, testId, width = DEFAULT_WIDTH, children }: DashboardToolPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  }));

  /*
  FNXC:ToolSurfaces 2026-09-15-16:04:
  Re-anchoring on resize is what keeps the panel usable when a virtual keyboard shrinks the visual viewport or the
  window is narrowed; without it the panel keeps the geometry of the width it was opened at.
  */
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  /*
  FNXC:ToolSurfaces 2026-09-15-16:04:
  Capture and move focus in ONE layout effect, in that order. Capturing in a passive effect reads `document.activeElement`
  AFTER the panel has already taken focus, so dismissal would "restore" focus to the panel that is being unmounted and
  the operator would lose their place in the header.
  */
  useLayoutEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      const trigger = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [open]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  }, [onClose]);

  if (!open) return null;

  const resolvedWidth = Math.min(width, Math.max(240, viewport.width - VIEWPORT_MARGIN * 2));
  const anchorBottom = anchorRect?.bottom ?? VIEWPORT_MARGIN;
  const anchorRight = anchorRect?.right ?? viewport.width - VIEWPORT_MARGIN;
  const top = Math.max(VIEWPORT_MARGIN, anchorBottom + ANCHOR_GAP);
  const left = Math.max(VIEWPORT_MARGIN, Math.min(anchorRight - resolvedWidth, viewport.width - resolvedWidth - VIEWPORT_MARGIN));
  const maxHeight = Math.max(200, viewport.height - top - VIEWPORT_MARGIN);

  return createPortal(
    <DashboardWindowSurfaceRoot logicalId={id} group="dialog" className="dashboard-window-surface-root--contents">
      <div className="dashboard-tool-popover__backdrop" data-testid={testId ? `${testId}-backdrop` : undefined} onClick={onClose} />
      <div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-label={ariaLabel}
        aria-modal="false"
        tabIndex={-1}
        className="dashboard-tool-popover"
        data-testid={testId}
        onKeyDown={handleKeyDown}
        style={{ top, left, width: resolvedWidth, maxHeight }}
      >
        <div className="dashboard-tool-popover__body">{children}</div>
      </div>
    </DashboardWindowSurfaceRoot>,
    document.body,
  );
}

export default DashboardToolPopover;
