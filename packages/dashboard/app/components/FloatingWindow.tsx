import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { isFullScreenSheetViewport, isShortViewport, isTabletTouchViewport, useViewportMode } from "../hooks/useViewportMode";
import { currentFloatingZ, currentTaskDetailFloatingZ, nextFloatingZ, nextTaskDetailFloatingZ } from "./floatingWindowStack";
import "./FloatingWindow.css";

/*
FNXC:FloatingWindow 2026-06-22-20:45:
FloatingWindow is the REUSABLE non-blocking floating window. It generalizes the proven RightDockExpandModal technique (transparent `pointer-events:none` overlay, a `position:fixed; pointer-events:auto` panel dragged by its header via setPointerCapture + captured-element listeners + pointerId filtering + rAF-batched position, edge/corner resize handles, `touch-action:none` handles, and a single dragTeardownRef detached on pointerup/cancel AND unmount). It hosts ARBITRARY children so several windows (file browser, terminal, multiple task details) can coexist without blocking the page or each other.

MULTI-WINDOW STACKING: a module-level z-index counter (`topZ`) hands each window a fresh z on mount and on every panel pointerdown/focus, so the most recently interacted-with window floats to the front. All overlays are click-through; only the panels capture pointer events, so every open FloatingWindow is independently movable and none blocks the page behind it.
*/

export interface FloatingWindowSize {
  width: number;
  height: number;
}

export interface FloatingWindowPosition {
  x: number;
  y: number;
}

export interface FloatingWindowProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Stable identity for this window; used to derive a deterministic cascade offset for the default position. */
  windowKey: string;
  defaultSize?: FloatingWindowSize;
  defaultPosition?: FloatingWindowPosition;
  minSize?: FloatingWindowSize;
  /*
  FNXC:FloatingWindow 2026-06-22-12:20:
  Task detail pop-outs should look like the fixed "Open task" modal: one task header containing task id, status badge, edit, and close. `hideHeader` removes the generic window chrome, while `dragHandleSelector` lets that task header remain the drag handle so the modal stays movable and resizable.
  */
  hideHeader?: boolean;
  dragHandleSelector?: string;
  className?: string;
  /** Optional localStorage key used to restore the last clamped position and size. */
  persistGeometryKey?: string;
  /** Skip desktop geometry restoration/writes while this caller renders as a full-screen mobile sheet. */
  suspendGeometryPersistenceOnMobile?: boolean;
  /** Include the CSS short-viewport sheet breakpoint when suspending geometry persistence. */
  suspendGeometryPersistenceOnShortViewport?: boolean;
  /**
   * Opt-in outside-pointer dismissal for transient windows like Quick Chat.
   * Persistent task/terminal pop-outs must omit this so page clicks do not close them.
   */
  closeOnOutsidePointerDown?: boolean;
  /** Mouse-only handlers for hosts whose historical backdrop dismissal cannot use pointer-down semantics. */
  backdropMouseHandlers?: {
    onMouseDown?: (event: ReactMouseEvent<HTMLDivElement>) => void;
    onMouseUp?: (event: ReactMouseEvent<HTMLDivElement>) => void;
    onClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  };
  /** Render as a blocking dialog instead of the default coexisting utility window. */
  modal?: boolean;
  /** Optional legacy hook for callers whose overlay is asserted by existing tests. */
  testId?: string;
  /*
  FNXC:FloatingWindow 2026-07-18-00:00:
  Quick Chat must hide without unmounting so its active session, messages, and scroll position
  reopen instantly. This opt-in flag keeps children mounted but removes the window from paint and
  interaction; defaulting to false preserves every existing FloatingWindow caller unchanged.
  */
  hidden?: boolean;
  /**
   * Layer band for z-index claiming. Task-detail peers (including Quick Chat) interleave by
   * interaction; unrelated utilities use the global floating stack.
   */
  layer?: "utility" | "task-detail";
  // FNXC:FloatingWindow 2026-07-11-11:30: accessible name for the dialog overlay so headerless windows (e.g. artifact viewers with their own header chrome) stay queryable/announcable by label.
  ariaLabel?: string;
  /*
  FNXC:ModalTouchGeometry 2026-07-26-14:09:
  Headerless migrated dialogs may own a step-dependent title inside custom chrome. Forward its
  id to the shared dialog so screen readers retain that live name instead of a stale seed title.
  */
  ariaLabelledBy?: string;
}

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 560;
const DEFAULT_MIN_WIDTH = 360;
const DEFAULT_MIN_HEIGHT = 280;
const VIEWPORT_PADDING = 16;

/*
FNXC:FloatingWindow 2026-06-22-21:30:
Z-index now comes from the SHARED `floatingWindowStack` module (`nextFloatingZ`/`currentFloatingZ`) so FloatingWindow stacks in ONE counter with the right-dock pop-out, the floating terminal, and the floating New Task dialog — tapping ANY of them raises it above all the others regardless of type. The local `topZ`/`nextZ` counter this file previously owned is gone.
*/

type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const RESIZE_DIRECTIONS: ResizeDirection[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
export const FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT = "fusion:floating-window-geometry-change";

const FLOATING_WINDOW_OUTSIDE_POINTER_SAFE_SURFACE_SELECTOR = [
  ".floating-window",
  ".modal-overlay",
  "[role=\"dialog\"]",
  ".model-combobox-dropdown--portal",
  ".model-nested-menu--portal",
  ".dep-dropdown--portal",
  ".node-picker-dropdown--portal",
  ".agent-picker-dropdown--portal",
  ".priority-picker-dropdown--portal",
  ".activity-view-menu",
].join(", ");

/*
FNXC:ModalTouchGeometry 2026-07-27-12:00:
FN-8619: Task Detail's body-portaled activity-view menu is a logical child of its modal.
Treating it as safe prevents a preference-enabled outside pointer-down from closing the host.

FNXC:FloatingWindow 2026-07-13-08:01:
FN-7943: Quick Chat's outside-pointer dismissal must treat body-portaled dropdowns as logical children of the FloatingWindow. Keep this selector in sync with the sibling FN-7916 ChatThinkingLevelControl and FN-2860 QuickEntryBox portal guards so model, thinking-level, agent, dependency, node, and priority selections do not dismiss the host chat window while bare-page clicks still close it.
*/

/** Hash a windowKey into a small bounded cascade index so stacked default windows do not perfectly overlap. */
function cascadeIndexFor(windowKey: string): number {
  let hash = 0;
  for (let i = 0; i < windowKey.length; i += 1) {
    hash = (hash * 31 + windowKey.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 6;
}

function clampSize(size: FloatingWindowSize, minSize: FloatingWindowSize): FloatingWindowSize {
  if (typeof window === "undefined") return size;
  return {
    width: Math.min(Math.max(size.width, minSize.width), Math.max(minSize.width, window.innerWidth - VIEWPORT_PADDING * 2)),
    height: Math.min(Math.max(size.height, minSize.height), Math.max(minSize.height, window.innerHeight - VIEWPORT_PADDING * 2)),
  };
}

function clampPosition(position: FloatingWindowPosition, size: FloatingWindowSize): FloatingWindowPosition {
  if (typeof window === "undefined") return position;
  return {
    x: Math.min(Math.max(position.x, VIEWPORT_PADDING), Math.max(VIEWPORT_PADDING, window.innerWidth - size.width - VIEWPORT_PADDING)),
    y: Math.min(Math.max(position.y, VIEWPORT_PADDING), Math.max(VIEWPORT_PADDING, window.innerHeight - size.height - VIEWPORT_PADDING)),
  };
}

/*
FNXC:FloatingWindow 2026-06-22-20:45:
Default position cascades by windowKey so opening several windows in a row visibly offsets each one from a roughly-centered origin instead of stacking them pixel-perfect on top of one another.
*/
function defaultPositionFor(windowKey: string, size: FloatingWindowSize): FloatingWindowPosition {
  if (typeof window === "undefined") return { x: VIEWPORT_PADDING, y: VIEWPORT_PADDING };
  const cascade = cascadeIndexFor(windowKey) * 28;
  return clampPosition(
    { x: (window.innerWidth - size.width) / 2 + cascade, y: (window.innerHeight - size.height) / 2 + cascade },
    size
  );
}

interface PersistedFloatingWindowGeometry {
  size?: Partial<FloatingWindowSize>;
  position?: Partial<FloatingWindowPosition>;
}

function readPersistedGeometry(
  persistGeometryKey: string | undefined,
  fallbackSize: FloatingWindowSize,
  fallbackPosition: FloatingWindowPosition,
  minSize: FloatingWindowSize,
): { size: FloatingWindowSize; position: FloatingWindowPosition } {
  if (!persistGeometryKey || typeof window === "undefined") {
    return { size: fallbackSize, position: fallbackPosition };
  }

  try {
    const raw = localStorage.getItem(persistGeometryKey);
    if (!raw) return { size: fallbackSize, position: fallbackPosition };
    const parsed = JSON.parse(raw) as PersistedFloatingWindowGeometry;
    const persistedSize = {
      width: typeof parsed.size?.width === "number" ? parsed.size.width : fallbackSize.width,
      height: typeof parsed.size?.height === "number" ? parsed.size.height : fallbackSize.height,
    };
    const size = clampSize(persistedSize, minSize);
    const persistedPosition = {
      x: typeof parsed.position?.x === "number" ? parsed.position.x : fallbackPosition.x,
      y: typeof parsed.position?.y === "number" ? parsed.position.y : fallbackPosition.y,
    };
    return { size, position: clampPosition(persistedPosition, size) };
  } catch {
    return { size: fallbackSize, position: fallbackPosition };
  }
}

export function FloatingWindow({
  title,
  onClose,
  children,
  windowKey,
  defaultSize,
  defaultPosition,
  minSize,
  hideHeader = false,
  dragHandleSelector,
  className,
  persistGeometryKey,
  suspendGeometryPersistenceOnMobile = false,
  suspendGeometryPersistenceOnShortViewport = false,
  closeOnOutsidePointerDown = false,
  backdropMouseHandlers,
  modal = false,
  testId,
  hidden = false,
  layer = "utility",
  ariaLabel,
  ariaLabelledBy,
}: FloatingWindowProps) {
  const resolvedMinSize: FloatingWindowSize = minSize ?? { width: DEFAULT_MIN_WIDTH, height: DEFAULT_MIN_HEIGHT };
  const viewportMode = useViewportMode();
  /*
  FNXC:ModalTouchGeometry 2026-07-26-12:19:
  Tablet touch geometry must use FN-8602's physical-screen-aware discriminator, not a bare
  coarse-pointer query. Phones remain full-screen sheets and desktop hybrids retain their exact
  mouse geometry; a known touch tablet at 768px is the one surface that receives enlarged targets.
  */
  const hasTabletTouchGeometry = isTabletTouchViewport(viewportMode);
  /*
  FNXC:ModalTouchGeometry 2026-08-01-04:23:
  NAMING CONTRACT — FloatingWindow has two distinct tablet markers; do not conflate them:
  - `floating-window--tablet-viewport`: the viewport MODE classifies as tablet (769-1024px
    width OR a known 768px touch tablet), touch or not. Pure styling surface — currently the
    FN-8015 gutter zeroing lives here.
  - `floating-window--touch-geometry`: tablet AND touch-capable (`isTabletTouchViewport`) —
    enlarged 44px drag/resize targets only.
  A 900px non-touch window is `--tablet-viewport` but NOT `--touch-geometry`, and operators
  still see the FN-8015 scrollbar gutter as an uneven right inset there (third recurrence of
  the Task Detail right-padding bug — FN-8630/FN-8634 fixed only the `.modal-overlay` shells,
  while every tablet task popup and floating terminal renders through THIS host).
  */
  const isTabletViewportMode = viewportMode === "tablet";
  const initialGeometry = useRef<{ size: FloatingWindowSize; position: FloatingWindowPosition } | null>(null);
  /*
  FNXC:ModalGeometryPersistence 2026-07-16-00:40:
  Opt-in sheet callers leave desktop geometry untouched at `max-width: 768px`. Most wide, short
  landscape phones remain movable FloatingWindows and must restore geometry; Artifact Gallery opts
  into its separate `max-height: 480px` full-screen-sheet CSS breakpoint as well.
  */
  const geometryPersistenceSuspended = suspendGeometryPersistenceOnMobile && (
    isFullScreenSheetViewport() || (suspendGeometryPersistenceOnShortViewport && isShortViewport())
  );

  if (!initialGeometry.current) {
    const fallbackSize = clampSize(defaultSize ?? { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }, resolvedMinSize);
    const fallbackPosition = defaultPosition ? clampPosition(defaultPosition, fallbackSize) : defaultPositionFor(windowKey, fallbackSize);
    initialGeometry.current = geometryPersistenceSuspended
      ? { size: fallbackSize, position: fallbackPosition }
      : readPersistedGeometry(persistGeometryKey, fallbackSize, fallbackPosition, resolvedMinSize);
  }

  const [size, setSize] = useState<FloatingWindowSize>(() =>
    initialGeometry.current!.size
  );
  const [position, setPosition] = useState<FloatingWindowPosition>(() => initialGeometry.current!.position);
  const geometryIdentityRef = useRef({ windowKey, persistGeometryKey });

  /*
  FNXC:ModalTouchGeometry 2026-07-27-20:00:
  A project-scoped floating host can stay mounted while its window/storage identity changes.
  Reload that identity's geometry before passive persistence runs so Terminal never copies one
  project's geometry into another project's key.
  */
  useLayoutEffect(() => {
    const previousIdentity = geometryIdentityRef.current;
    if (previousIdentity.windowKey === windowKey && previousIdentity.persistGeometryKey === persistGeometryKey) return;

    const fallbackSize = clampSize(defaultSize ?? { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }, resolvedMinSize);
    const fallbackPosition = defaultPosition ? clampPosition(defaultPosition, fallbackSize) : defaultPositionFor(windowKey, fallbackSize);
    const nextGeometry = geometryPersistenceSuspended
      ? { size: fallbackSize, position: fallbackPosition }
      : readPersistedGeometry(persistGeometryKey, fallbackSize, fallbackPosition, resolvedMinSize);
    geometryIdentityRef.current = { windowKey, persistGeometryKey };
    initialGeometry.current = nextGeometry;
    setSize(nextGeometry.size);
    setPosition(nextGeometry.position);
  }, [defaultPosition, defaultSize, geometryPersistenceSuspended, persistGeometryKey, resolvedMinSize, windowKey]);

  const claimFrontZ = useCallback(() => (layer === "task-detail" ? nextTaskDetailFloatingZ() : nextFloatingZ()), [layer]);
  const readCurrentZ = useCallback(() => (layer === "task-detail" ? currentTaskDetailFloatingZ() : currentFloatingZ()), [layer]);
  /*
  FNXC:TaskPopupLayer 2026-07-17-15:55:
  Task-detail popups and Quick Chat intentionally claim the same board/task-detail interaction
  band, so either may rise above the other on pointer/focus. Other utility FloatingWindow callers
  retain the higher global stack; only Chat opts into this task-popup peer contract.
  */
  const [zIndex, setZIndex] = useState<number>(() => claimFrontZ());
  const panelRef = useRef<HTMLDivElement | null>(null);

  /*
  FNXC:FloatingWindow 2026-06-22-20:45:
  A single active-drag/resize teardown (copied from the RightDockExpandModal pattern). pointerup/pointercancel run it, and the unmount effect runs it too, so an in-progress gesture interrupted by close/unmount never leaks captured-element pointer listeners or a pending rAF.
  */
  const dragTeardownRef = useRef<(() => void) | null>(null);

  // FNXC:FloatingWindow 2026-06-22-21:30: Focus-to-front. Pointerdown/focus anywhere on the panel raises this window above ALL other floating modals (any type) via the shared stack.
  const bringToFront = useCallback(() => {
    setZIndex((current) => {
      // Only claim a new z if we are not already on top, to avoid needless counter churn on every move.
      if (current >= readCurrentZ()) return current;
      return claimFrontZ();
    });
  }, [claimFrontZ, readCurrentZ]);

  /*
  FNXC:FloatingWindow 2026-07-18-00:00:
  A hidden Quick Chat must reclaim a fresh z-index when reopened because another task-detail
  popup may have been focused while chat was invisible. Hidden windows do not otherwise affect
  the shared interaction stack.

  FNXC:FloatingWindow 2026-07-18-07:15:
  Only reclaim on the hidden→visible transition. Initial mount already claims via useState;
  re-claiming after sibling mount (RightDockExpandModal, etc.) inverted last-mounted-on-top
  and broke the shared-stack cross-type contract in FloatingWindowStack.cross-type.test.
  */
  const wasHiddenRef = useRef(hidden);
  useEffect(() => {
    const wasHidden = wasHiddenRef.current;
    wasHiddenRef.current = hidden;
    if (wasHidden && !hidden) bringToFront();
  }, [bringToFront, hidden]);

  const handleDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      /*
      FNXC:ModalTouchGeometry 2026-07-26-13:35:
      FN-8606 sheet callers must expose neither movable geometry nor resize chrome on phone and
      short viewports. Do not begin a delegated or built-in header drag while persistence is
      suspended; CSS alone cannot prevent the panel-level pointer handler from receiving touches.
      */
      /* FNXC:ModalTouchGeometry 2026-07-26-14:20: Delegated headers commonly contain links (for example Settings' GitHub/Discord actions), which must retain native activation rather than starting a window drag. */
      if (geometryPersistenceSuspended || (event.target as HTMLElement).closest("button, a, input, select, textarea, [contenteditable=\"true\"], [role=\"button\"], [role=\"link\"]")) return;
      event.preventDefault();
      event.stopPropagation();
      /*
      FNXC:ModalTouchGeometry 2026-07-26-12:19:
      A drag owns one captured pointer until matching up/cancel or unmount. Tear down any
      interrupted gesture before claiming this header so touch scroll, outside dismissal, and a
      second finger cannot retain listeners, selection suppression, or stale animation frames.
      */
      dragTeardownRef.current?.();
      bringToFront();
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
        moveEvent.preventDefault();
        latest = { x: startPosition.x + moveEvent.clientX - startX, y: startPosition.y + moveEvent.clientY - startY };
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          setPosition(clampPosition(latest, currentSize));
        });
      };
      const detachListeners = () => {
        captureTarget.releasePointerCapture?.(pointerId);
        captureTarget.removeEventListener("pointermove", handlePointerMove);
        captureTarget.removeEventListener("pointerup", handlePointerUp);
        captureTarget.removeEventListener("pointercancel", handlePointerUp);
      };
      function handlePointerUp(upEvent: PointerEvent) {
        if (upEvent.pointerId !== pointerId) return;
        upEvent.preventDefault();
        if (frame) cancelAnimationFrame(frame);
        setPosition(clampPosition(latest, currentSize));
        document.body.style.userSelect = previousUserSelect;
        detachListeners();
        dragTeardownRef.current = null;
      }

      dragTeardownRef.current = () => {
        if (frame) cancelAnimationFrame(frame);
        document.body.style.userSelect = previousUserSelect;
        detachListeners();
        dragTeardownRef.current = null;
      };

      captureTarget.addEventListener("pointermove", handlePointerMove);
      captureTarget.addEventListener("pointerup", handlePointerUp);
      captureTarget.addEventListener("pointercancel", handlePointerUp);
    },
    [bringToFront, geometryPersistenceSuspended, position, size]
  );

  const handlePanelPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!hideHeader || !dragHandleSelector) return;
      const target = event.target as HTMLElement | null;
      if (!target?.closest(dragHandleSelector)) return;
      handleDragPointerDown(event);
    },
    [dragHandleSelector, handleDragPointerDown, hideHeader]
  );

  /*
  FNXC:ModalTouchGeometry 2026-07-26-12:34:
  Headerless FloatingWindows delegate dragging to caller-owned headers (notably task-detail
  pop-outs). The resolved element, rather than only FloatingWindow's optional built-in header,
  must receive the shared tablet touch marker and hit-area class so every drag path has the same
  >=44px contract without a second gesture implementation.
  */
  useLayoutEffect(() => {
    if (!hasTabletTouchGeometry || !hideHeader || !dragHandleSelector) return;
    const delegatedHandle = panelRef.current?.querySelector<HTMLElement>(dragHandleSelector);
    if (!delegatedHandle) return;

    const previousTarget = delegatedHandle.getAttribute("data-resize-hit-target");
    delegatedHandle.classList.add("floating-window__delegated-drag-handle");
    delegatedHandle.setAttribute("data-resize-hit-target", "true");

    return () => {
      delegatedHandle.classList.remove("floating-window__delegated-drag-handle");
      if (previousTarget === null) delegatedHandle.removeAttribute("data-resize-hit-target");
      else delegatedHandle.setAttribute("data-resize-hit-target", previousTarget);
    };
  }, [children, dragHandleSelector, hasTabletTouchGeometry, hideHeader]);

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, direction: ResizeDirection) => {
      event.preventDefault();
      event.stopPropagation();
      dragTeardownRef.current?.();
      bringToFront();
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
        moveEvent.preventDefault();
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        const nextSize = clampSize(
          {
            width: startSize.width + (direction.includes("e") ? dx : direction.includes("w") ? -dx : 0),
            height: startSize.height + (direction.includes("s") ? dy : direction.includes("n") ? -dy : 0),
          },
          resolvedMinSize
        );
        const nextPosition = {
          x: startPosition.x + (direction.includes("w") ? startSize.width - nextSize.width : 0),
          y: startPosition.y + (direction.includes("n") ? startSize.height - nextSize.height : 0),
        };
        latestSize = nextSize;
        latestPosition = nextPosition;
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          setSize(latestSize);
          setPosition(clampPosition(latestPosition, latestSize));
        });
      };
      const detachListeners = () => {
        captureTarget.releasePointerCapture?.(pointerId);
        captureTarget.removeEventListener("pointermove", handlePointerMove);
        captureTarget.removeEventListener("pointerup", handlePointerUp);
        captureTarget.removeEventListener("pointercancel", handlePointerUp);
      };
      function handlePointerUp(upEvent: PointerEvent) {
        if (upEvent.pointerId !== pointerId) return;
        upEvent.preventDefault();
        if (frame) cancelAnimationFrame(frame);
        setSize(latestSize);
        setPosition(clampPosition(latestPosition, latestSize));
        document.body.style.userSelect = previousUserSelect;
        detachListeners();
        dragTeardownRef.current = null;
      }

      dragTeardownRef.current = () => {
        if (frame) cancelAnimationFrame(frame);
        document.body.style.userSelect = previousUserSelect;
        detachListeners();
        dragTeardownRef.current = null;
      };

      captureTarget.addEventListener("pointermove", handlePointerMove);
      captureTarget.addEventListener("pointerup", handlePointerUp);
      captureTarget.addEventListener("pointercancel", handlePointerUp);
    },
    [bringToFront, position, resolvedMinSize, size]
  );

  // FNXC:FloatingWindow 2026-06-22-20:45: Run any active drag/resize teardown on unmount so captured-element listeners + a pending rAF never outlive the window.
  useEffect(() => () => dragTeardownRef.current?.(), []);

  /*
  FNXC:TaskDetailActivity 2026-07-04-18:37:
  Root-portaled Activity menus cannot inherit movement from a dragged/resized task popup. Emit a bounded geometry-change signal after FloatingWindow commits new geometry so owning task-detail content can recompute fixed menu coordinates from the live Activity trigger rect.
  */
  useLayoutEffect(() => {
    if (hidden || typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, { detail: { windowKey, layer } }));
  }, [hidden, layer, position, size, windowKey]);

  /*
  FNXC:FloatingWindow 2026-06-27-00:00:
  Outside-click dismissal is opt-in because the overlay is intentionally click-through for coexisting floating windows. A capture-phase document pointerdown listener is the only reliable outside signal, and it must ignore in-flight drag/resize gestures plus nested modal/floating surfaces so Quick Chat can dismiss from bare-page clicks without making persistent task pop-outs fragile.
  */
  useEffect(() => {
    if (hidden || !closeOnOutsidePointerDown || typeof document === "undefined") return;

    let lastTouchAt = 0;
    const markTouch = () => {
      lastTouchAt = Date.now();
    };
    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (Date.now() - lastTouchAt < 500) return;
      if (dragTeardownRef.current) return;

      const target = event.target;
      if (!(target instanceof Node)) return;
      const panel = panelRef.current;
      if (panel?.contains(target)) return;

      /*
      FNXC:ModalTouchGeometry 2026-07-28-14:30:
      FN-8607 modal hosts make the overlay pointer-active to block the application beneath.
      The host also carries role="dialog", so it would otherwise match the portal-safe dialog
      selector below and suppress its own backdrop dismissal. Only the host itself is outside;
      nested portaled dialog surfaces remain safe.
      */
      if (target === panel?.parentElement) {
        onClose();
        return;
      }

      const targetElement = target instanceof Element ? target : target.parentNode instanceof Element ? target.parentNode : null;
      if (targetElement?.closest(FLOATING_WINDOW_OUTSIDE_POINTER_SAFE_SURFACE_SELECTOR)) return;

      onClose();
    };

    document.addEventListener("touchstart", markTouch, { passive: true });
    document.addEventListener("touchend", markTouch, { passive: true });
    document.addEventListener("pointerdown", handleDocumentPointerDown, true);

    return () => {
      document.removeEventListener("touchstart", markTouch);
      document.removeEventListener("touchend", markTouch);
      document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
    };
  }, [closeOnOutsidePointerDown, hidden, onClose]);

  /*
  FNXC:ChatModal 2026-06-22-14:57:
  Quick Chat reopens should restore the last desktop floating-window size and position while still clamping onto the current viewport. Keep persistence generic and opt-in with persistGeometryKey so each caller controls whether geometry is shared or isolated.
  */
  useEffect(() => {
    if (hidden || !persistGeometryKey || typeof window === "undefined" || geometryPersistenceSuspended) return;
    try {
      localStorage.setItem(persistGeometryKey, JSON.stringify({ size, position }));
    } catch {
      // Ignore storage failures; geometry persistence is a convenience only.
    }
  }, [geometryPersistenceSuspended, hidden, persistGeometryKey, position, size]);

  /*
  FNXC:ModalTouchGeometry 2026-07-26-18:42:
  FN-8607 migrates former blocking dialogs into the shared geometry host. Modal callers opt into
  a real backdrop and keyboard focus boundary; utility windows retain the historical click-through
  behavior by default so this does not change existing multi-window surfaces.
  */
  useEffect(() => {
    if (!modal || hidden || typeof document === "undefined") return;
    const panel = panelRef.current;
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) { event.preventDefault(); panel.focus(); return; }
      const current = document.activeElement;
      const index = focusable.indexOf(current as HTMLElement);
      if (event.shiftKey && (index <= 0 || !panel.contains(current))) { event.preventDefault(); focusable.at(-1)?.focus(); }
      else if (!event.shiftKey && index === focusable.length - 1) { event.preventDefault(); focusable[0]?.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); priorFocus?.focus(); };
  }, [hidden, modal]);

  const panelStyle = {
    left: `${position.x}px`,
    top: `${position.y}px`,
    width: `${size.width}px`,
    height: `${size.height}px`,
    zIndex,
  } as CSSProperties;

  /*
  FNXC:FloatingWindow 2026-06-22-21:10:
  Rendered via a portal to document.body so the window escapes every ancestor stacking context (board card badges, the List view's sticky sort header + column divider, transformed columns, etc.). Without the portal the panel's z-index battles inside whatever subtree mounted it, letting card dependency/overlap tags and the list divider/sort header paint over the modal. At document.body the 4000+ z-index wins over all page content.

  FNXC:FloatingWindow 2026-07-18-14:05:
  FN-8340 resolves #2114: hidden Quick Chat windows remain portaled and layout-participating so
  child identity, geometry, and message-list scroll survive minimize/restore. The CSS hidden branch
  uses visibility (never display:none), while aria-hidden and suspended invisible-window effects
  keep the retained surface out of focus and interaction.
  */
  return createPortal(
    <div
      className={`floating-window-overlay${modal ? " floating-window-overlay--modal" : ""}${hidden ? " floating-window-overlay--hidden" : ""}`}
      role="dialog"
      aria-modal={modal ? "true" : "false"}
      aria-hidden={hidden || undefined}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      data-testid={testId ?? `floating-window-overlay-${windowKey}`}
      {...backdropMouseHandlers}
      // FNXC:ModalTouchGeometry 2026-07-27-12:00: FN-8619 keeps Agent Detail's paired mouse-only backdrop contract at the shared modal backdrop; this deliberately does not alter pointer-down dismissal.
      // FNXC:FloatingWindow 2026-06-22-23:00: The z-index MUST live on the position:fixed overlay (which creates a stacking context), not the panel. A panel z-index is trapped inside the overlay's context and loses to page elements that are stacking contexts in body's context (e.g. the right dock at position:absolute z-index:20). With z on the overlay, the whole window sits at the shared floating band in body's stacking context and reliably paints above page content + tap-to-front reorders correctly.
      style={{ zIndex }}
    >
      <div
        ref={panelRef}
        className={`floating-window${hideHeader ? " floating-window--headerless" : ""}${hasTabletTouchGeometry ? " floating-window--touch-geometry" : ""}${isTabletViewportMode ? " floating-window--tablet-viewport" : ""}${className ? ` ${className}` : ""}`}
        style={panelStyle}
        data-testid={`floating-window-${windowKey}`}
        onPointerDownCapture={bringToFront}
        onPointerDown={handlePanelPointerDown}
        onFocusCapture={bringToFront}
        tabIndex={modal ? -1 : undefined}
      >
        {/*
        FNXC:ModalTouchGeometry 2026-07-26-16:54:
        Phone and short-viewport callers opt into a full-screen sheet. Do not merely hide resize
        handles with CSS there: removing them from the accessibility tree ensures those sheets
        expose no floating-window affordance or touch gesture surface.
        */}
        {!geometryPersistenceSuspended && RESIZE_DIRECTIONS.map((direction) => (
          <div
            key={direction}
            className={`floating-window__resize-handle floating-window__resize-handle--${direction}`}
            data-testid={`floating-window-resize-${direction}`}
            {...(hasTabletTouchGeometry ? { "data-resize-hit-target": "true" } : {})}
            role="separator"
            aria-label="Resize floating window"
            onPointerDown={(event) => handleResizePointerDown(event, direction)}
          />
        ))}
        {!hideHeader && (
          <div
            className="floating-window__header"
            data-testid={`floating-window-drag-handle-${windowKey}`}
            {...(hasTabletTouchGeometry ? { "data-resize-hit-target": "true" } : {})}
            onPointerDown={handleDragPointerDown}
          >
            <div className="floating-window__title">{title}</div>
            <button
              type="button"
              className="floating-window__close"
              onClick={onClose}
              aria-label="Close floating window"
              data-testid={`floating-window-close-${windowKey}`}
            >
              <X size={18} />
            </button>
          </div>
        )}
        <div className="floating-window__body" data-testid={`floating-window-body-${windowKey}`}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
