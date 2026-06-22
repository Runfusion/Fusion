import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Maximize2, X } from "lucide-react";
import { findOverflowViewEntry, type OverflowViewEntry, type OverflowViewKey, type OverflowViewRenderProps, type OverflowViewVisibilityOptions } from "./overflowViewRegistry";
import { nextFloatingZ, currentFloatingZ } from "./floatingWindowStack";
import "./RightDock.css";

const RIGHT_DOCK_EXPAND_MODAL_SIZE_STORAGE_KEY = "fusion:right-dock-expand-modal-size";
const RIGHT_DOCK_EXPAND_MODAL_POSITION_STORAGE_KEY = "fusion:right-dock-expand-modal-position";

/*
FNXC:RightDock 2026-06-22-17:40:
The right-dock pop-out is a FLOATING, DRAGGABLE, RESIZABLE, NON-BLOCKING window. The user positions it anywhere on screen and keeps using the app behind it: NO background dimming/blur, and the overlay is `pointer-events: none` so behind-clicks pass through (only the panel re-enables `pointer-events: auto`). Because behind-clicks never reach the overlay there is no overlay click-to-dismiss; the explicit header close button is the only dismissal. This mirrors TerminalModal's floating mode (drag the header, resize from the corners, rAF-batched updates, a single dragTeardownRef invoked on pointerup/pointercancel AND on unmount so no document listeners leak).
*/

const EXPAND_DEFAULT_WIDTH = 960;
const EXPAND_DEFAULT_HEIGHT = 600;
const EXPAND_MIN_WIDTH = 360;
const EXPAND_MIN_HEIGHT = 280;
const EXPAND_VIEWPORT_PADDING = 16;

interface ExpandSize {
  width: number;
  height: number;
}

interface ExpandPosition {
  x: number;
  y: number;
}

function clampExpandSize(size: ExpandSize): ExpandSize {
  if (typeof window === "undefined") return size;
  return {
    width: Math.min(Math.max(size.width, EXPAND_MIN_WIDTH), Math.max(EXPAND_MIN_WIDTH, window.innerWidth - EXPAND_VIEWPORT_PADDING * 2)),
    height: Math.min(Math.max(size.height, EXPAND_MIN_HEIGHT), Math.max(EXPAND_MIN_HEIGHT, window.innerHeight - EXPAND_VIEWPORT_PADDING * 2)),
  };
}

function clampExpandPosition(position: ExpandPosition, size: ExpandSize): ExpandPosition {
  if (typeof window === "undefined") return position;
  return {
    x: Math.min(Math.max(position.x, EXPAND_VIEWPORT_PADDING), Math.max(EXPAND_VIEWPORT_PADDING, window.innerWidth - size.width - EXPAND_VIEWPORT_PADDING)),
    y: Math.min(Math.max(position.y, EXPAND_VIEWPORT_PADDING), Math.max(EXPAND_VIEWPORT_PADDING, window.innerHeight - size.height - EXPAND_VIEWPORT_PADDING)),
  };
}

function readExpandSize(): ExpandSize {
  if (typeof window === "undefined") return { width: EXPAND_DEFAULT_WIDTH, height: EXPAND_DEFAULT_HEIGHT };
  try {
    const raw = window.localStorage.getItem(RIGHT_DOCK_EXPAND_MODAL_SIZE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ExpandSize>;
      if (typeof parsed.width === "number" && typeof parsed.height === "number") {
        return clampExpandSize({ width: parsed.width, height: parsed.height });
      }
    }
  } catch {
    // ignore corrupted persisted size
  }
  return clampExpandSize({ width: EXPAND_DEFAULT_WIDTH, height: EXPAND_DEFAULT_HEIGHT });
}

function writeExpandSize(size: ExpandSize): ExpandSize {
  const clamped = clampExpandSize(size);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(RIGHT_DOCK_EXPAND_MODAL_SIZE_STORAGE_KEY, JSON.stringify(clamped));
  }
  return clamped;
}

function readExpandPosition(size: ExpandSize): ExpandPosition {
  if (typeof window === "undefined") return { x: EXPAND_VIEWPORT_PADDING, y: EXPAND_VIEWPORT_PADDING };
  try {
    const raw = window.localStorage.getItem(RIGHT_DOCK_EXPAND_MODAL_POSITION_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ExpandPosition>;
      if (typeof parsed.x === "number" && typeof parsed.y === "number") {
        return clampExpandPosition({ x: parsed.x, y: parsed.y }, size);
      }
    }
  } catch {
    // ignore corrupted persisted position
  }
  // Default: roughly centered.
  return clampExpandPosition({ x: (window.innerWidth - size.width) / 2, y: (window.innerHeight - size.height) / 2 }, size);
}

function writeExpandPosition(position: ExpandPosition, size: ExpandSize): ExpandPosition {
  const clamped = clampExpandPosition(position, size);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(RIGHT_DOCK_EXPAND_MODAL_POSITION_STORAGE_KEY, JSON.stringify(clamped));
  }
  return clamped;
}

type ExpandResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const EXPAND_RESIZE_DIRECTIONS: ExpandResizeDirection[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

type RenderableOverflowViewEntry = OverflowViewEntry & Required<Pick<OverflowViewEntry, "render">>;

export interface RightDockExpandModalProps {
  viewKey: OverflowViewKey | null;
  renderProps: OverflowViewRenderProps;
  visibilityOptions?: OverflowViewVisibilityOptions;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/*
FNXC:Navigation 2026-06-21-00:00:
Expanded right-dock views reuse the same overflow registry render function as the dock body, so expanding changes only available space and never swaps to a divergent component or prop contract.

FNXC:Navigation 2026-06-21-20:16:
FN-6882 makes most right-dock entries launcher actions. The expand modal is restricted to inline view entries so action-only tools cannot open an empty modal body.
*/
export function RightDockExpandModal({
  viewKey,
  renderProps,
  visibilityOptions = {},
  onClose,
  returnFocusRef,
}: RightDockExpandModalProps) {
  const resolvedEntry = viewKey ? findOverflowViewEntry(viewKey, visibilityOptions) : undefined;
  const entry: RenderableOverflowViewEntry | undefined = resolvedEntry?.render ? { ...resolvedEntry, render: resolvedEntry.render } : undefined;

  const [size, setSizeState] = useState<ExpandSize>(() => readExpandSize());
  const [position, setPositionState] = useState<ExpandPosition>(() => readExpandPosition(readExpandSize()));
  // FNXC:FloatingWindow 2026-06-22-21:30: The right-dock pop-out shares the SINGLE cross-type floating z-index stack (floatingWindowStack). Mounting claims the front; tapping the panel (pointerdown/focus capture) raises it above every other floating modal regardless of type.
  const [zIndex, setZIndex] = useState<number>(() => nextFloatingZ());
  const bringToFront = useCallback(() => {
    setZIndex((current) => (current >= currentFloatingZ() ? current : nextFloatingZ()));
  }, []);

  /*
  FNXC:RightDock 2026-06-22-17:40:
  A single active-drag teardown lives here (drag OR resize). pointerup/pointercancel run it, and the unmount effect runs it too, so a drag interrupted by close/unmount never leaks document pointer listeners or a pending rAF — this was a P1 in review of the terminal floating window.
  */
  const dragTeardownRef = useRef<(() => void) | null>(null);

  const persistSize = useCallback((next: ExpandSize) => {
    setSizeState(writeExpandSize(next));
  }, []);

  const persistPosition = useCallback((next: ExpandPosition, withSize: ExpandSize) => {
    setPositionState(writeExpandPosition(next, withSize));
  }, []);

  const closeAndRestoreFocus = useCallback(() => {
    onClose();
    window.setTimeout(() => returnFocusRef?.current?.focus(), 0);
  }, [onClose, returnFocusRef]);

  /*
  FNXC:RightDock 2026-06-22-17:40:
  Header drag: pointerdown on the title bar moves the panel via state-driven `position: fixed; left/top`. Pointer capture keeps the drag alive past the header bounds, updates are rAF-batched so the move stays smooth, and the panel is clamped on-screen. Clicks on the close button are excluded so dragging never swallows the close.

  FNXC:RightDock 2026-06-22-18:50:
  Touch smoothness fix: listen for pointermove/up on the CAPTURED element (`captureTarget` = event.currentTarget) rather than `document`. `setPointerCapture` redirects every move for this pointerId to that element, so element-scoped listeners receive the full stream even when the finger drifts off the header — and they pair cleanly with `touch-action: none` (CSS) without a separate non-passive document listener. clientX/clientY are read from the captured pointer's move events. Raw moves are coalesced into a single rAF (`frame`) so we set left/top at most once per frame and never thrash layout on a flood of touch-move events.
  */
  const handleFloatingDragPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const captureTarget = event.currentTarget;
    const pointerId = event.pointerId;
    captureTarget.setPointerCapture?.(pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startPosition = position;
    const currentSize = size;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    let latest = startPosition;
    let frame = 0;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      latest = { x: startPosition.x + moveEvent.clientX - startX, y: startPosition.y + moveEvent.clientY - startY };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setPositionState(clampExpandPosition(latest, currentSize));
      });
    };
    const detachListeners = () => {
      captureTarget.releasePointerCapture?.(pointerId);
      captureTarget.removeEventListener("pointermove", handlePointerMove);
      captureTarget.removeEventListener("pointerup", handlePointerUp);
      captureTarget.removeEventListener("pointercancel", handlePointerUp);
    };
    function handlePointerUp() {
      if (frame) cancelAnimationFrame(frame);
      persistPosition(latest, currentSize);
      document.body.style.userSelect = previousUserSelect;
      detachListeners();
      dragTeardownRef.current = null;
    }

    // FNXC:RightDock 2026-06-22-17:40: Close/unmount-mid-drag teardown cancels the rAF and drops the listeners without persisting a partial move.
    dragTeardownRef.current = () => {
      if (frame) cancelAnimationFrame(frame);
      document.body.style.userSelect = previousUserSelect;
      detachListeners();
      dragTeardownRef.current = null;
    };

    captureTarget.addEventListener("pointermove", handlePointerMove);
    captureTarget.addEventListener("pointerup", handlePointerUp);
    captureTarget.addEventListener("pointercancel", handlePointerUp);
  }, [persistPosition, position, size]);

  /*
  FNXC:RightDock 2026-06-22-17:40:
  Corner/edge resize: pointer events resize the panel, rAF-batched for smoothness. West/north handles also shift the panel origin so the opposite edge stays pinned. Same teardown discipline as the drag.
  */
  const handleFloatingResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, direction: ExpandResizeDirection) => {
    event.preventDefault();
    event.stopPropagation();
    const captureTarget = event.currentTarget;
    const pointerId = event.pointerId;
    captureTarget.setPointerCapture?.(pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = size;
    const startPosition = position;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    let latestSize = startSize;
    let latestPosition = startPosition;
    let frame = 0;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      const nextSize = clampExpandSize({
        width: startSize.width + (direction.includes("e") ? dx : direction.includes("w") ? -dx : 0),
        height: startSize.height + (direction.includes("s") ? dy : direction.includes("n") ? -dy : 0),
      });
      const nextPosition = {
        x: startPosition.x + (direction.includes("w") ? startSize.width - nextSize.width : 0),
        y: startPosition.y + (direction.includes("n") ? startSize.height - nextSize.height : 0),
      };
      latestSize = nextSize;
      latestPosition = nextPosition;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setSizeState(latestSize);
        setPositionState(clampExpandPosition(latestPosition, latestSize));
      });
    };
    const detachListeners = () => {
      captureTarget.releasePointerCapture?.(pointerId);
      captureTarget.removeEventListener("pointermove", handlePointerMove);
      captureTarget.removeEventListener("pointerup", handlePointerUp);
      captureTarget.removeEventListener("pointercancel", handlePointerUp);
    };
    function handlePointerUp() {
      if (frame) cancelAnimationFrame(frame);
      persistSize(latestSize);
      persistPosition(latestPosition, latestSize);
      document.body.style.userSelect = previousUserSelect;
      detachListeners();
      dragTeardownRef.current = null;
    }

    // FNXC:RightDock 2026-06-22-17:40: Close/unmount-mid-resize teardown.
    dragTeardownRef.current = () => {
      if (frame) cancelAnimationFrame(frame);
      document.body.style.userSelect = previousUserSelect;
      detachListeners();
      dragTeardownRef.current = null;
    };

    captureTarget.addEventListener("pointermove", handlePointerMove);
    captureTarget.addEventListener("pointerup", handlePointerUp);
    captureTarget.addEventListener("pointercancel", handlePointerUp);
  }, [persistPosition, persistSize, position, size]);

  // FNXC:RightDock 2026-06-22-17:40: Run any active drag/resize teardown on unmount so document pointer listeners + a pending rAF never outlive the modal.
  useEffect(() => () => dragTeardownRef.current?.(), []);

  useEffect(() => {
    if (entry) return undefined;
    return () => {
      returnFocusRef?.current?.focus();
    };
  }, [entry, returnFocusRef]);

  if (!entry) {
    return null;
  }

  const Icon = entry.icon;

  const panelStyle = {
    left: `${position.x}px`,
    top: `${position.y}px`,
    width: `${size.width}px`,
    height: `${size.height}px`,
    zIndex,
  } as CSSProperties;

  // FNXC:FloatingWindow 2026-06-22-22:30: Portaled to document.body so this floating modal shares the ONE root stacking context with the other floating modals (FloatingWindow/terminal/New Task) — the shared 10100+ z stack only orders correctly across types when they all live at the document root.
  return createPortal(
    <div className="modal-overlay open right-dock-expand-modal-overlay" role="dialog" aria-modal="false" aria-label={`${entry.label} expanded`} data-testid="right-dock-expand-modal" style={{ zIndex }}>
      <div
        className="modal right-dock-expand-modal right-dock-expand-modal--floating"
        style={panelStyle}
        onPointerDownCapture={bringToFront}
        onFocusCapture={bringToFront}
      >
        {EXPAND_RESIZE_DIRECTIONS.map((direction) => (
          <div
            key={direction}
            className={`right-dock-expand-resize-handle right-dock-expand-resize-handle--${direction}`}
            data-testid={`right-dock-expand-resize-${direction}`}
            role="separator"
            aria-label="Resize expanded right dock window"
            onPointerDown={(event) => handleFloatingResizePointerDown(event, direction)}
          />
        ))}
        <div
          className="modal-header right-dock-expand-modal__header right-dock-expand-modal__header--draggable"
          data-testid="right-dock-expand-drag-handle"
          onPointerDown={handleFloatingDragPointerDown}
        >
          <div className="right-dock-expand-modal__title">
            <Maximize2 size={16} />
            <Icon size={16} />
            <span>{entry.label}</span>
          </div>
          <button className="modal-close" onClick={closeAndRestoreFocus} aria-label="Close expanded right dock view" data-testid="right-dock-expand-close">
            <X size={20} />
          </button>
        </div>
        {/*
        FNXC:RightDockFiles 2026-06-22-15:00:
        Tag the render props with `surface="expand"` so registry entries (notably Files) deterministically choose their pop-out layout instead of guessing from a measured container width. DockFilesView reads this to force its LEFT|RIGHT two-pane layout.
        */}
        <div className="right-dock-expand-modal__body" data-testid="right-dock-expand-body">
          {entry.render({ ...renderProps, surface: "expand" })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
