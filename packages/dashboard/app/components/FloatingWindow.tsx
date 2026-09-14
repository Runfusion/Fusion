import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { isFullScreenSheetViewport, isShortViewport, isTabletTouchViewport, useViewportMode } from "../hooks/useViewportMode";
import { useDrawerDismissGesture } from "../hooks/useDrawerDismissGesture";
import { currentFloatingZ, currentTaskDetailFloatingZ, nextFloatingZ, nextTaskDetailFloatingZ } from "./floatingWindowStack";
import { isInsidePortalSafeSurface } from "../utils/portalSurfaces";
import "./FloatingWindow.css";
import { ModalCloseButton } from "./ModalCloseButton";
import { ViewDrawerHandle } from "./ViewDrawer";
import { ViewLayoutContent, ViewLayoutHeader } from "./ViewLayout";
import {
  DashboardWindowSurfaceActivityProvider,
  useDashboardWindowBounds,
  useDashboardWindowFocusRestoring,
  useDashboardWindowSurface,
  type DashboardWindowBounds,
  type DashboardWindowSurfaceGroup,
} from "../context/DashboardWindowManagerContext";

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
  /*
  FNXC:FloatingWindow 2026-08-23-04:29:
  Stacked callers can request a presentation-only cascade without changing the shared canonical
  geometry. The persisted base remains un-cascaded, so reopening a window never walks it across
  the viewport.
  */
  cascadeOffsetIndex?: number;
  /** Skip desktop geometry restoration/writes while this caller renders as a full-screen mobile sheet. */
  suspendGeometryPersistenceOnMobile?: boolean;
  /** Include the CSS short-viewport sheet breakpoint when suspending geometry persistence. */
  suspendGeometryPersistenceOnShortViewport?: boolean;
  /** Opt-in outside-pointer dismissal for modal owners that preserve backdrop dismissal; persistent pop-outs omit it. */
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
  FNXC:FloatingWindowVisibility 2026-09-14-11:35:
  Locally retained owners can hide without unmounting, preserving child state, geometry, and scroll. This local flag composes with the global presentation snapshot and defaults visible.
  */
  hidden?: boolean;
  /** Layer band for z-index claiming. Task-detail and Chat work surfaces interleave; unrelated utilities use the global stack. */
  layer?: "utility" | "task-detail";
  /** Optional monotonic signal for owners that refresh a mounted window in place. */
  raiseToFrontSignal?: number;
  /** Semantic group used by shared visibility/read-state consumers. */
  surfaceGroup?: DashboardWindowSurfaceGroup;
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

/*
FNXC:FloatingWindow 2026-06-22-21:30:
Z-index now comes from the SHARED `floatingWindowStack` module (`nextFloatingZ`/`currentFloatingZ`) so FloatingWindow stacks in ONE counter with the right-dock pop-out, the floating terminal, and the floating New Task dialog — tapping ANY of them raises it above all the others regardless of type. The local `topZ`/`nextZ` counter this file previously owned is gone.
*/

type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const RESIZE_DIRECTIONS: ResizeDirection[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
export const FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT = "fusion:floating-window-geometry-change";
export const FLOATING_WINDOW_CASCADE_STEP_PX = 28;

/*
FNXC:ModalTouchGeometry 2026-07-27-12:00:
FN-8619: Task Detail's body-portaled activity-view menu is a logical child of its modal.
Treating it as safe prevents a preference-enabled outside pointer-down from closing the host.

FNXC:FloatingWindow 2026-09-14-11:35:
Outside-pointer dismissal treats body-portaled controls as logical window children. Keep this selector aligned with shared model, thinking, agent, dependency, node, and priority portals so interacting with a child never dismisses its owner.
*/

/** Hash a windowKey into a small bounded cascade index so stacked default windows do not perfectly overlap. */
function cascadeIndexFor(windowKey: string): number {
  let hash = 0;
  for (let i = 0; i < windowKey.length; i += 1) {
    hash = (hash * 31 + windowKey.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 6;
}

/*
FNXC:FloatingWindowBounds 2026-09-14-10:50:
Window geometry is constrained by the live dashboard work area rather than an artificial viewport gutter. Size is clamped before position, and a work area smaller than the caller's declared minimum wins so no window can overlap shell landmarks.
*/
export function clampFloatingWindowSize(
  size: FloatingWindowSize,
  minSize: FloatingWindowSize,
  bounds: DashboardWindowBounds,
): FloatingWindowSize {
  return {
    width: Math.min(Math.max(0, size.width, minSize.width), Math.max(0, bounds.width)),
    height: Math.min(Math.max(0, size.height, minSize.height), Math.max(0, bounds.height)),
  };
}

export function clampFloatingWindowPosition(
  position: FloatingWindowPosition,
  size: FloatingWindowSize,
  bounds: DashboardWindowBounds,
): FloatingWindowPosition {
  return {
    x: Math.min(Math.max(position.x, bounds.left), Math.max(bounds.left, bounds.right - size.width)),
    y: Math.min(Math.max(position.y, bounds.top), Math.max(bounds.top, bounds.bottom - size.height)),
  };
}

export interface FloatingWindowCascade {
  offset: FloatingWindowPosition;
  size: FloatingWindowSize;
}

interface FloatingWindowCascadeAxis {
  offset: number;
  size: number;
}

function resolveFloatingWindowCascadeAxis(
  base: number,
  size: number,
  minSize: number,
  lowerBound: number,
  upperBound: number,
  distance: number,
): FloatingWindowCascadeAxis {
  const maximumPosition = Math.max(lowerBound, upperBound - size);
  const forwardTravel = Math.max(0, Math.min(base + distance, maximumPosition) - base);
  const backwardTravel = Math.max(0, base - Math.max(base - distance, lowerBound));
  const effectiveMinimum = Math.min(minSize, Math.max(0, upperBound - lowerBound));
  const availableReduction = Math.max(0, size - effectiveMinimum);

  if (forwardTravel > 0) {
    const reduction = Math.min(distance - forwardTravel, availableReduction);
    return { offset: forwardTravel + reduction, size: size - reduction };
  }

  if (backwardTravel >= distance) {
    return { offset: -distance, size };
  }

  const reduction = Math.min(distance, availableReduction);
  if (reduction > 0) {
    return { offset: reduction, size: size - reduction };
  }

  return { offset: -backwardTravel, size };
}

/*
FNXC:FloatingWindow 2026-08-27-09:18:
FN-193 requires stacked chat windows to remain visibly separated even when their shared base nearly fills the viewport. Preserve the existing forward-first and far-edge backward behavior, but shrink only the presented dimension when its requested forward travel is clamped; persistence restores the un-cascaded, un-shrunk base.
*/
export function resolveFloatingWindowCascade(
  base: FloatingWindowPosition,
  size: FloatingWindowSize,
  minSize: FloatingWindowSize,
  cascadeIndex: number,
  bounds: DashboardWindowBounds = {
    left: 0,
    top: 0,
    right: typeof window === "undefined" ? size.width : window.innerWidth,
    bottom: typeof window === "undefined" ? size.height : window.innerHeight,
    width: typeof window === "undefined" ? size.width : window.innerWidth,
    height: typeof window === "undefined" ? size.height : window.innerHeight,
  },
): FloatingWindowCascade {
  const unchanged = (): FloatingWindowCascade => ({ offset: { x: 0, y: 0 }, size });
  if (
    !Number.isFinite(cascadeIndex)
    || cascadeIndex <= 0
    || !Number.isFinite(base.x)
    || !Number.isFinite(base.y)
    || !Number.isFinite(size.width)
    || !Number.isFinite(size.height)
    || !Number.isFinite(minSize.width)
    || !Number.isFinite(minSize.height)
    || !Number.isFinite(bounds.left)
    || !Number.isFinite(bounds.top)
    || !Number.isFinite(bounds.right)
    || !Number.isFinite(bounds.bottom)
  ) return unchanged();

  const distance = cascadeIndex * FLOATING_WINDOW_CASCADE_STEP_PX;
  const horizontal = resolveFloatingWindowCascadeAxis(base.x, size.width, minSize.width, bounds.left, bounds.right, distance);
  const vertical = resolveFloatingWindowCascadeAxis(base.y, size.height, minSize.height, bounds.top, bounds.bottom, distance);
  return {
    offset: { x: horizontal.offset, y: vertical.offset },
    size: { width: horizontal.size, height: vertical.size },
  };
}

/*
FNXC:FloatingWindow 2026-06-22-20:45:
Default position cascades by windowKey so opening several windows in a row visibly offsets each one from a roughly-centered origin instead of stacking them pixel-perfect on top of one another.
*/
function defaultPositionFor(
  windowKey: string,
  size: FloatingWindowSize,
  bounds: DashboardWindowBounds,
): FloatingWindowPosition {
  const cascade = cascadeIndexFor(windowKey) * FLOATING_WINDOW_CASCADE_STEP_PX;
  return clampFloatingWindowPosition(
    {
      x: bounds.left + (bounds.width - size.width) / 2 + cascade,
      y: bounds.top + (bounds.height - size.height) / 2 + cascade,
    },
    size,
    bounds,
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
  bounds: DashboardWindowBounds,
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
    const size = clampFloatingWindowSize(persistedSize, minSize, bounds);
    const persistedPosition = {
      x: typeof parsed.position?.x === "number" ? parsed.position.x : fallbackPosition.x,
      y: typeof parsed.position?.y === "number" ? parsed.position.y : fallbackPosition.y,
    };
    return { size, position: clampFloatingWindowPosition(persistedPosition, size, bounds) };
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
  cascadeOffsetIndex = 0,
  suspendGeometryPersistenceOnMobile = false,
  suspendGeometryPersistenceOnShortViewport = false,
  closeOnOutsidePointerDown = false,
  backdropMouseHandlers,
  modal = false,
  testId,
  hidden = false,
  layer = "utility",
  raiseToFrontSignal,
  surfaceGroup,
  ariaLabel,
  ariaLabelledBy,
}: FloatingWindowProps) {
  const { t } = useTranslation("app");
  const availableBounds = useDashboardWindowBounds();
  /*
  FNXC:FloatingWindow 2026-09-13-22:40:
  Callers pass `minSize` as an inline object literal, so rebuilding this per render gave every
  geometry-dependent effect a new identity and made passive geometry persistence write to storage on
  each render. Memoize on the primitive extents so persistence follows real geometry changes only.
  */
  const minWidth = minSize?.width ?? DEFAULT_MIN_WIDTH;
  const minHeight = minSize?.height ?? DEFAULT_MIN_HEIGHT;
  const resolvedMinSize: FloatingWindowSize = useMemo(
    () => ({ width: minWidth, height: minHeight }),
    [minWidth, minHeight],
  );
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
    width OR a known 768px touch tablet), touch or not. Pure styling surface.
  - `floating-window--touch-geometry`: tablet AND touch-capable (`isTabletTouchViewport`) —
    enlarged 44px drag/resize targets only.
  A 900px non-touch window is `--tablet-viewport` but NOT `--touch-geometry`; the marker exists so
  such a window still gets tablet STYLING. It used to carry FN-8015's gutter zeroing, because that
  shared gutter read as an uneven right inset on tablet (third recurrence of the Task Detail
  right-padding bug — FN-8630/FN-8634 fixed only the `.modal-overlay` shells, while every tablet
  task popup and floating terminal renders through THIS host). The gutter is deleted outright as of
  2026-08-17, so no gutter zeroing hangs off this class any more.
  */
  const isTabletViewportMode = viewportMode === "tablet";
  const alphaDrawerExcluded = Boolean(className && /(?:setup-wizard|onboarding|confirm)/.test(className));
  const alphaMobileDrawer = viewportMode === "mobile"
    && typeof document !== "undefined"
    && document.documentElement.dataset.alphaMobileDrawers === "true"
    && !alphaDrawerExcluded;
  const effectiveModal = modal || alphaMobileDrawer;
  const initialGeometry = useRef<{ size: FloatingWindowSize; position: FloatingWindowPosition } | null>(null);
  const cascadeOffsetRef = useRef<FloatingWindowPosition>({ x: 0, y: 0 });
  const cascadeSizeReductionRef = useRef<FloatingWindowSize>({ width: 0, height: 0 });
  /*
  FNXC:ModalGeometryPersistence 2026-07-16-00:40:
  Opt-in sheet callers leave desktop geometry untouched at `max-width: 768px`. Most wide, short
  landscape phones remain movable FloatingWindows and must restore geometry; Artifact Gallery opts
  into its separate `max-height: 480px` full-screen-sheet CSS breakpoint as well.
  */
  const geometryPersistenceSuspended = alphaMobileDrawer || (suspendGeometryPersistenceOnMobile && (
    isFullScreenSheetViewport() || (suspendGeometryPersistenceOnShortViewport && isShortViewport())
  ));

  const applyCascadeOffset = (geometry: { size: FloatingWindowSize; position: FloatingWindowPosition }) => {
    const cascade = geometryPersistenceSuspended
      ? { offset: { x: 0, y: 0 }, size: geometry.size }
      : resolveFloatingWindowCascade(geometry.position, geometry.size, resolvedMinSize, cascadeOffsetIndex, availableBounds);
    cascadeOffsetRef.current = cascade.offset;
    cascadeSizeReductionRef.current = {
      width: geometry.size.width - cascade.size.width,
      height: geometry.size.height - cascade.size.height,
    };
    return {
      size: cascade.size,
      position: { x: geometry.position.x + cascade.offset.x, y: geometry.position.y + cascade.offset.y },
    };
  };

  if (!initialGeometry.current) {
    const fallbackSize = clampFloatingWindowSize(defaultSize ?? { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }, resolvedMinSize, availableBounds);
    const fallbackPosition = defaultPosition
      ? clampFloatingWindowPosition(defaultPosition, fallbackSize, availableBounds)
      : defaultPositionFor(windowKey, fallbackSize, availableBounds);
    const baseGeometry = geometryPersistenceSuspended
      ? { size: fallbackSize, position: fallbackPosition }
      : readPersistedGeometry(persistGeometryKey, fallbackSize, fallbackPosition, resolvedMinSize, availableBounds);
    initialGeometry.current = applyCascadeOffset(baseGeometry);
  }

  const [size, setSize] = useState<FloatingWindowSize>(() => initialGeometry.current!.size);
  const [position, setPosition] = useState<FloatingWindowPosition>(() => initialGeometry.current!.position);
  const geometryIdentityRef = useRef({ windowKey, persistGeometryKey, cascadeOffsetIndex });

  /*
  FNXC:ModalTouchGeometry 2026-07-27-20:00:
  A project-scoped floating host can stay mounted while its window/storage identity changes.
  Reload that identity's geometry before passive persistence runs so Terminal never copies one
  project's geometry into another project's key.
  */
  useLayoutEffect(() => {
    const previousIdentity = geometryIdentityRef.current;
    if (
      previousIdentity.windowKey === windowKey
      && previousIdentity.persistGeometryKey === persistGeometryKey
      && previousIdentity.cascadeOffsetIndex === cascadeOffsetIndex
    ) return;

    const fallbackSize = clampFloatingWindowSize(defaultSize ?? { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }, resolvedMinSize, availableBounds);
    const fallbackPosition = defaultPosition
      ? clampFloatingWindowPosition(defaultPosition, fallbackSize, availableBounds)
      : defaultPositionFor(windowKey, fallbackSize, availableBounds);
    const baseGeometry = geometryPersistenceSuspended
      ? { size: fallbackSize, position: fallbackPosition }
      : readPersistedGeometry(persistGeometryKey, fallbackSize, fallbackPosition, resolvedMinSize, availableBounds);
    const nextGeometry = applyCascadeOffset(baseGeometry);
    geometryIdentityRef.current = { windowKey, persistGeometryKey, cascadeOffsetIndex };
    initialGeometry.current = nextGeometry;
    setSize(nextGeometry.size);
    setPosition(nextGeometry.position);
  }, [availableBounds, cascadeOffsetIndex, defaultPosition, defaultSize, geometryPersistenceSuspended, persistGeometryKey, resolvedMinSize, windowKey]);

  /*
  FNXC:FloatingWindowBounds 2026-09-14-10:52:
  A mounted window reacts to shell landmark, dock-width, footer-variant, and viewport changes immediately. Re-clamp size first and then position; the resulting geometry may follow the existing persistence path, while global visibility changes never enter this effect.
  */
  useLayoutEffect(() => {
    if (geometryPersistenceSuspended) return;
    setSize((currentSize) => {
      const nextSize = clampFloatingWindowSize(currentSize, resolvedMinSize, availableBounds);
      setPosition((currentPosition) => {
        const nextPosition = clampFloatingWindowPosition(currentPosition, nextSize, availableBounds);
        return nextPosition.x === currentPosition.x && nextPosition.y === currentPosition.y
          ? currentPosition
          : nextPosition;
      });
      return nextSize.width === currentSize.width && nextSize.height === currentSize.height
        ? currentSize
        : nextSize;
    });
  }, [availableBounds, geometryPersistenceSuspended, resolvedMinSize]);

  const claimFrontZ = useCallback(() => (layer === "task-detail" ? nextTaskDetailFloatingZ() : nextFloatingZ()), [layer]);
  const readCurrentZ = useCallback(() => (layer === "task-detail" ? currentTaskDetailFloatingZ() : currentFloatingZ()), [layer]);
  /*
  FNXC:TaskPopupLayer 2026-09-14-11:35:
  Task-detail and Chat windows claim the same work-surface interaction band, so either may rise on pointer/focus. Other utility windows retain the higher global stack.
  */
  const [zIndex, setZIndex] = useState<number>(() => claimFrontZ());
  const panelRef = useRef<HTMLDivElement | null>(null);
  const windowSurface = useDashboardWindowSurface({
    logicalId: windowKey,
    group: surfaceGroup ?? (alphaMobileDrawer ? "drawer" : effectiveModal ? "dialog" : "window"),
    locallyVisible: !hidden,
    stackOrder: zIndex,
  });
  const globallyHiddenRef = useRef(windowSurface.globallyHidden);
  globallyHiddenRef.current = windowSurface.globallyHidden;
  const effectiveHidden = hidden || windowSurface.globallyHidden;
  const dismissHandleProps = useDrawerDismissGesture({
    enabled: alphaMobileDrawer && !effectiveHidden,
    open: !effectiveHidden,
    panelRef,
    onDismiss: onClose,
  });

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
  FNXC:DashboardWindowVisibility 2026-09-14-17:46:
  FN-392: focus-to-front is suspended while the window manager restores focus after a global hide, so a restoration
  focus never rewrites the stack. A genuine pointer press, or a focus the operator causes afterwards, still raises.
  */
  const focusRestoring = useDashboardWindowFocusRestoring();
  const bringToFrontOnFocus = useCallback(() => {
    if (focusRestoring()) return;
    bringToFront();
  }, [bringToFront, focusRestoring]);

  /*
  FNXC:FloatingWindow 2026-08-23-03:33:
  FN-169 needs a third re-raise path for owners that refresh a mounted entry in place: such a
  window neither remounts nor transitions from hidden to visible. An omitted signal preserves
  every existing caller's stack behavior.
  */
  const previousRaiseToFrontSignalRef = useRef(raiseToFrontSignal);
  useEffect(() => {
    if (raiseToFrontSignal === previousRaiseToFrontSignalRef.current) return;
    previousRaiseToFrontSignalRef.current = raiseToFrontSignal;
    if (windowSurface.surfaceActive) bringToFront();
  }, [bringToFront, raiseToFrontSignal, windowSurface.surfaceActive]);

  /*
  FNXC:FloatingWindowVisibility 2026-09-14-11:35:
  A locally hidden window reclaims the front when its owner reopens it because another work surface may have been focused meanwhile. Global hide/restore bypasses this local transition and preserves exact z-order.

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
      if (!windowSurface.surfaceActive || geometryPersistenceSuspended || (event.target as HTMLElement).closest("button, a, input, select, textarea, [contenteditable=\"true\"], [role=\"button\"], [role=\"link\"]")) return;
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
          setPosition(clampFloatingWindowPosition(latest, currentSize, availableBounds));
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
        setPosition(clampFloatingWindowPosition(latest, currentSize, availableBounds));
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
    [availableBounds, bringToFront, geometryPersistenceSuspended, position, size, windowSurface.surfaceActive]
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
      if (!windowSurface.surfaceActive) return;
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
        const nextSize = clampFloatingWindowSize(
          {
            width: startSize.width + (direction.includes("e") ? dx : direction.includes("w") ? -dx : 0),
            height: startSize.height + (direction.includes("s") ? dy : direction.includes("n") ? -dy : 0),
          },
          resolvedMinSize,
          availableBounds,
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
          setPosition(clampFloatingWindowPosition(latestPosition, latestSize, availableBounds));
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
        setPosition(clampFloatingWindowPosition(latestPosition, latestSize, availableBounds));
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
    [availableBounds, bringToFront, position, resolvedMinSize, size, windowSurface.surfaceActive]
  );

  // FNXC:FloatingWindow 2026-06-22-20:45: Run any active drag/resize teardown on unmount so captured-element listeners + a pending rAF never outlive the window.
  useEffect(() => () => dragTeardownRef.current?.(), []);
  useEffect(() => {
    if (!windowSurface.surfaceActive) dragTeardownRef.current?.();
  }, [windowSurface.surfaceActive]);

  /*
  FNXC:TaskDetailActivity 2026-07-04-18:37:
  Root-portaled Activity menus cannot inherit movement from a dragged/resized task popup. Emit a bounded geometry-change signal after FloatingWindow commits new geometry so owning task-detail content can recompute fixed menu coordinates from the live Activity trigger rect.
  */
  useLayoutEffect(() => {
    if (hidden || globallyHiddenRef.current || typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, { detail: { windowKey, layer } }));
  }, [hidden, layer, position, size, windowKey]);

  /*
  FNXC:FloatingWindow 2026-09-14-11:35:
  Outside-click dismissal is opt-in because coexisting overlays are click-through. The capture-phase document listener ignores drag/resize gestures and nested portaled surfaces, and is absent whenever the managed surface is inactive.
  */
  useEffect(() => {
    if (effectiveHidden || !closeOnOutsidePointerDown || typeof document === "undefined") return;

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

      if (isInsidePortalSafeSurface(target)) return;

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
  }, [closeOnOutsidePointerDown, effectiveHidden, onClose]);

  /*
  FNXC:FloatingWindow 2026-08-23-04:29:
  Persist the un-cascaded base rather than a stacked presentation position. Shared chat windows can
  then retain one stable geometry while each visible panel applies its own offset.

  FNXC:FloatingWindow 2026-08-27-09:18:
  FN-193 also re-expands a cascade-shrunk presentation size before saving. The shared desktop base must never progressively shrink just because several chat windows opened near a viewport edge.

  FNXC:FloatingWindowGeometry 2026-09-14-11:35:
  Persisted desktop geometry restores into the current live shell bounds. Persistence remains generic and opt-in so each owner controls whether geometry is shared or isolated.
  */
  useEffect(() => {
    if (hidden || globallyHiddenRef.current || !persistGeometryKey || typeof window === "undefined" || geometryPersistenceSuspended) return;
    try {
      const canonicalSize = clampFloatingWindowSize({
        width: size.width + cascadeSizeReductionRef.current.width,
        height: size.height + cascadeSizeReductionRef.current.height,
      }, resolvedMinSize, availableBounds);
      const canonicalPosition = clampFloatingWindowPosition({
        x: position.x - cascadeOffsetRef.current.x,
        y: position.y - cascadeOffsetRef.current.y,
      }, canonicalSize, availableBounds);
      localStorage.setItem(persistGeometryKey, JSON.stringify({ size: canonicalSize, position: canonicalPosition }));
    } catch {
      // Ignore storage failures; geometry persistence is a convenience only.
    }
  }, [availableBounds, geometryPersistenceSuspended, hidden, persistGeometryKey, position, resolvedMinSize, size]);

  /*
  FNXC:ModalTouchGeometry 2026-07-26-18:42:
  FN-8607 migrates former blocking dialogs into the shared geometry host. Modal callers opt into
  a real backdrop and keyboard focus boundary; utility windows retain the historical click-through
  behavior by default so this does not change existing multi-window surfaces.
  */
  /*
  FNXC:DashboardWindowVisibility 2026-09-14-17:46:
  FN-392: a global hide/restore must be purely presentational. The modal focus boundary therefore skips BOTH halves of
  its focus round-trip across that transition: it does not restore prior focus when the manager hid it (the manager
  captured and owns that focus), and it does not re-autofocus its panel on restore. Re-running the autofocus made every
  restored modal window claim a fresh layer through `onFocusCapture`, which is exactly how restore reordered windows.
  A local hide, an ordinary mount, and any later real interaction keep their existing behavior.
  */
  const restoringFromGlobalHideRef = useRef(false);
  useEffect(() => {
    if (!effectiveModal || effectiveHidden || typeof document === "undefined") {
      if (globallyHiddenRef.current) restoringFromGlobalHideRef.current = true;
      return;
    }
    const skipAutoFocus = restoringFromGlobalHideRef.current;
    restoringFromGlobalHideRef.current = false;
    const panel = panelRef.current;
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!skipAutoFocus) panel?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      /*
      FNXC:AlphaMobileDrawer 2026-09-11-02:01:
      An Alpha mobile FloatingWindow has no close button, so its modal keyboard boundary must retain Escape as a secondary recovery path alongside handle drag and backdrop dismissal.
      */
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
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
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (!globallyHiddenRef.current) priorFocus?.focus();
    };
  }, [effectiveHidden, effectiveModal, onClose]);

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

  FNXC:FloatingWindowVisibility 2026-09-14-11:35:
  Hidden windows remain portaled and layout-participating so child identity, geometry, and scroll survive. Visibility, inertness, aria state, and suspended handlers remove retained surfaces from paint, focus, and interaction without display removal.
  */
  return createPortal(
    <div
      ref={windowSurface.rootRef}
      className={`floating-window-overlay${effectiveModal ? " floating-window-overlay--modal" : ""}${alphaMobileDrawer ? " floating-window-overlay--alpha-mobile-drawer" : ""}${effectiveHidden ? " floating-window-overlay--hidden" : ""}`}
      role="dialog"
      aria-modal={effectiveModal ? "true" : "false"}
      aria-hidden={effectiveHidden || undefined}
      inert={effectiveHidden || undefined}
      data-dashboard-window-surface={windowKey}
      data-dashboard-window-globally-hidden={windowSurface.globallyHidden ? "true" : undefined}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      data-testid={testId ?? `floating-window-overlay-${windowKey}`}
      onMouseDown={(event) => {
        if (effectiveHidden) return;
        backdropMouseHandlers?.onMouseDown?.(event);
        if (alphaMobileDrawer && event.target === event.currentTarget) onClose();
      }}
      onMouseUp={effectiveHidden ? undefined : backdropMouseHandlers?.onMouseUp}
      onClick={effectiveHidden ? undefined : backdropMouseHandlers?.onClick}
      // FNXC:ModalTouchGeometry 2026-07-27-12:00: FN-8619 keeps Agent Detail's paired mouse-only backdrop contract at the shared modal backdrop; this deliberately does not alter pointer-down dismissal.
      // FNXC:FloatingWindow 2026-06-22-23:00: The z-index MUST live on the position:fixed overlay (which creates a stacking context), not the panel. A panel z-index is trapped inside the overlay's context and loses to page elements that are stacking contexts in body's context (e.g. the right dock at position:absolute z-index:20). With z on the overlay, the whole window sits at the shared floating band in body's stacking context and reliably paints above page content + tap-to-front reorders correctly.
      style={{ zIndex }}
    >
      <div
        ref={panelRef}
        className={`floating-window${hideHeader ? " floating-window--headerless" : ""}${hasTabletTouchGeometry ? " floating-window--touch-geometry" : ""}${isTabletViewportMode ? " floating-window--tablet-viewport" : ""}${alphaMobileDrawer ? " floating-window--alpha-mobile-drawer" : ""}${className ? ` ${className}` : ""}`}
        style={panelStyle}
        data-testid={`floating-window-${windowKey}`}
        onPointerDownCapture={windowSurface.surfaceActive ? bringToFront : undefined}
        onPointerDown={(event) => {
          if (alphaMobileDrawer) dismissHandleProps.onPointerDown(event);
          else handlePanelPointerDown(event);
        }}
        onPointerMove={alphaMobileDrawer ? dismissHandleProps.onPointerMove : undefined}
        onPointerUp={alphaMobileDrawer ? dismissHandleProps.onPointerUp : undefined}
        onPointerCancel={alphaMobileDrawer ? dismissHandleProps.onPointerCancel : undefined}
        onLostPointerCapture={alphaMobileDrawer ? dismissHandleProps.onLostPointerCapture : undefined}
        onFocusCapture={windowSurface.surfaceActive ? bringToFrontOnFocus : undefined}
        tabIndex={effectiveModal ? -1 : undefined}
      >
        {/*
        FNXC:ModalTouchGeometry 2026-07-26-16:54:
        Phone and short-viewport callers opt into a full-screen sheet. Do not merely hide resize
        handles with CSS there: removing them from the accessibility tree ensures those sheets
        expose no floating-window affordance or touch gesture surface.
        */}
        {alphaMobileDrawer && (
          <ViewDrawerHandle className="floating-window__drawer-handle-target" barClassName="floating-window__drawer-handle" />
        )}
        {!geometryPersistenceSuspended && RESIZE_DIRECTIONS.map((direction) => (
          <div
            key={direction}
            className={`floating-window__resize-handle floating-window__resize-handle--${direction}`}
            data-testid={`floating-window-resize-${direction}`}
            {...(hasTabletTouchGeometry ? { "data-resize-hit-target": "true" } : {})}
            role="separator"
            aria-label={t("floatingWindow.resize", "Resize floating window")}
            onPointerDown={(event) => handleResizePointerDown(event, direction)}
          />
        ))}
        {!hideHeader && (
          <ViewLayoutHeader
            className="floating-window__header"
            data-testid={`floating-window-drag-handle-${windowKey}`}
            {...(hasTabletTouchGeometry ? { "data-resize-hit-target": "true" } : {})}
            onPointerDown={handleDragPointerDown}
          >
            <div className="floating-window__title">{title}</div>
            {!alphaMobileDrawer && (
              <ModalCloseButton
                onClick={onClose}
                aria-label={t("floatingWindow.close", "Close floating window")}
                data-testid={`floating-window-close-${windowKey}`}
              />
            )}
          </ViewLayoutHeader>
        )}
        <ViewLayoutContent className="floating-window__body" data-testid={`floating-window-body-${windowKey}`}>
          <DashboardWindowSurfaceActivityProvider active={windowSurface.surfaceActive}>
            {children}
          </DashboardWindowSurfaceActivityProvider>
        </ViewLayoutContent>
      </div>
    </div>,
    document.body,
  );
}
