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
  type TouchEvent as ReactTouchEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { isFullScreenSheetViewport, isShortViewport, isTabletTouchViewport, useViewportMode } from "../hooks/useViewportMode";
import { useDrawerDismissGesture } from "../hooks/useDrawerDismissGesture";
import { currentFloatingZ, currentTaskDetailFloatingZ, engagedGestureZ, nextFloatingZ, nextSnapPreviewZ, nextTaskDetailFloatingZ } from "./floatingWindowStack";
import { isInsidePortalSafeSurface } from "../utils/portalSurfaces";
import {
  KeyboardViewportOwnerProvider,
  useKeyboardViewportSurface,
} from "../hooks/useKeyboardViewportSurface";
import "./FloatingWindow.css";
import { ModalCloseButton } from "./ModalCloseButton";
import { DrawerPresentationProvider, ViewDrawerHandle, resolveDrawerPresentation } from "./ViewDrawer";
import { ViewLayoutContent, ViewLayoutHeader } from "./ViewLayout";
import {
  DashboardWindowSurfaceActivityProvider,
  useDashboardWindowBottomDockReservationControl,
  useDashboardWindowBounds,
  useDashboardWindowCascade,
  useDashboardWindowFocusRestoring,
  useDashboardWindowSurface,
  type DashboardWindowBounds,
  type DashboardWindowSurfaceGroup,
} from "../context/DashboardWindowManagerContext";
import {
  FLOATING_WINDOW_DRAG_THRESHOLD_PX,
  clampFloatingWindowPosition,
  clampFloatingWindowSize,
  demoteBottomAnchoredSnapMode,
  detectSnapZoneForRect,
  rectRestsOnBottomWall,
  resolveDetachedRect,
  resolveHandoffRect,
  resolveOpeningRect,
  resolveSnapRect,
  shouldDetachSnappedWindow,
  type FloatingWindowOpeningSizePolicy,
  type FloatingWindowPosition,
  type FloatingWindowRect,
  type FloatingWindowSize,
  type FloatingWindowSnapMode,
} from "./floatingWindowGeometry";

export {
  FLOATING_WINDOW_CASCADE_STEP_PX,
  FLOATING_WINDOW_OPENING_SIZE_SCALE,
  FLOATING_WINDOW_STANDARD_HEIGHT_RATIO,
  FLOATING_WINDOW_TASK_STANDARD_HEIGHT,
  FLOATING_WINDOW_TASK_STANDARD_WIDTH,
  clampFloatingWindowPosition,
  clampFloatingWindowSize,
} from "./floatingWindowGeometry";
export type {
  FloatingWindowPosition,
  FloatingWindowRect,
  FloatingWindowSize,
  FloatingWindowSnapMode,
} from "./floatingWindowGeometry";

/*
FNXC:FloatingWindow 2026-06-22-20:45:
FloatingWindow is the REUSABLE non-blocking floating window. It generalizes the proven RightDockExpandModal technique (transparent `pointer-events:none` overlay, a `position:fixed; pointer-events:auto` panel dragged by its header via setPointerCapture + captured-element listeners + pointerId filtering + rAF-batched position, edge/corner resize handles, `touch-action:none` handles, and a single dragTeardownRef detached on pointerup/cancel AND unmount). It hosts ARBITRARY children so several windows (file browser, terminal, multiple task details) can coexist without blocking the page or each other.

MULTI-WINDOW STACKING: a module-level z-index counter (`topZ`) hands each window a fresh z on mount and on every panel pointerdown/focus, so the most recently interacted-with window floats to the front. All overlays are click-through; only the panels capture pointer events, so every open FloatingWindow is independently movable and none blocks the page behind it.
*/

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
  FNXC:FloatingWindowGeometry 2026-09-16-05:45:
  FN-456: every window OPENS at the shared 1.43 landscape ratio. A host declares `full-view` only when its
  opening deliberately fills the work area — Git Manager (header/footer "more" menu) and Planning mode — because
  the operator explicitly refused to see those integral views shrunk or cropped by the ratio. Omitting the prop
  means `aspect-ratio`, so no existing host changes. Resizing, dragging, and docking stay free either way.
  */
  openingSizePolicy?: FloatingWindowOpeningSizePolicy;
  /*
  FNXC:FloatingWindow 2026-06-22-12:20:
  Task detail pop-outs should look like the fixed "Open task" modal: one task header containing task id, status badge, edit, and close. `hideHeader` removes the generic window chrome, while `dragHandleSelector` lets that task header remain the drag handle so the modal stays movable and resizable.
  */
  hideHeader?: boolean;
  dragHandleSelector?: string;
  className?: string;
  /*
  FNXC:FloatingWindowDialogHosts 2026-09-14-22:36:
  FN-394 re-hosts the formerly static dashboard dialogs here. Their identity class used to live on their
  own overlay element (backdrop CSS, breakpoint padding). Forwarding it to the shared overlay keeps that
  styling and those host selectors valid WITHOUT re-introducing a second overlay/portal per dialog.
  */
  overlayClassName?: string;
  /*
  FNXC:FloatingWindowGeometry 2026-09-14-21:10:
  FN-394 retires durable geometry. Every opening is standard-sized and centred, so this key is accepted
  for source compatibility and deliberately ignored: nothing is read from or written to storage. Any
  historical values simply stay untouched in `localStorage` (no global purge, other preferences intact).
  @deprecated ignored since FN-394.
  */
  persistGeometryKey?: string;
  /*
  FNXC:FloatingWindowCascade 2026-09-14-21:10:
  FN-394 moves cascade ownership into the shared window manager, which allocates one slot per pristine
  window instance across ALL types. Caller-supplied indexes are ignored.
  @deprecated ignored since FN-394.
  */
  cascadeOffsetIndex?: number;
  /** Skip desktop geometry restoration/writes while this caller renders as a full-screen mobile sheet. */
  suspendGeometryPersistenceOnMobile?: boolean;
  /** Include the CSS short-viewport sheet breakpoint when suspending geometry persistence. */
  suspendGeometryPersistenceOnShortViewport?: boolean;
  /** Opt-in outside-pointer dismissal for modal owners that preserve backdrop dismissal; persistent pop-outs omit it. */
  closeOnOutsidePointerDown?: boolean;
  /*
  FNXC:FloatingWindowDialogHosts 2026-09-14-22:36:
  Mouse-only handlers for hosts whose historical backdrop dismissal cannot use pointer-down semantics. FN-394
  also forwards the paired touch handlers, because `useOverlayDismiss` pairs a touch start and release on the
  backdrop; dropping them would silently delete touch backdrop dismissal from every re-hosted dialog.
  */
  backdropMouseHandlers?: {
    onMouseDown?: (event: ReactMouseEvent<HTMLDivElement>) => void;
    onMouseUp?: (event: ReactMouseEvent<HTMLDivElement>) => void;
    onClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
    onTouchStart?: (event: ReactTouchEvent<HTMLDivElement>) => void;
    onTouchEnd?: (event: ReactTouchEvent<HTMLDivElement>) => void;
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
  /*
  FNXC:FloatingWindowSnap 2026-09-15-22:32:
  FN-438: the validated end-of-gesture fact, for owners whose own presentation depends on where a drag actually
  finished (today: the terminal, which re-pins when its bottom edge lands on the bottom bar).

  An external observer CANNOT derive this by measuring the DOM. `handlePointerMove` applies positions through
  `requestAnimationFrame`, and `handlePointerUp` begins by CANCELLING the pending frame before committing the
  final placement, so any rectangle read before that commit — including one read from a capture-phase document
  listener, which runs first — is stale on a fast gesture. That staleness is exactly the reported "re-pinning
  only works sometimes" defect. This callback is therefore the single source of truth for gesture end: it fires
  once, at the very end of `handlePointerUp`, and carries the retained snap mode plus the final CLAMPED rect.

  It is deliberately NOT emitted on `pointercancel`, on unmount teardown, or by resize gestures: none of those
  validate a placement. Owners that do not pass it observe no behavior change whatsoever.
  */
  onDragGestureEnd?: (info: FloatingWindowDragGestureEnd) => void;
  /*
  FNXC:FloatingWindowSnap 2026-09-16-18:31:
  FN-469: a LIVE pointer gesture handed over by a host that just replaced its own docked presentation with this
  window. The terminal's bottom dock is the motivating case: it used to call `endGesture()` and then swap to the
  floating presentation, so the new window opened at the standard CENTRED rectangle and the drag was lost.

  Given this descriptor the window instead opens under the pointer (`resolveHandoffRect`) and RESUMES the very same
  drag loop an ordinary header press runs, with no synthetic `pointerdown` fabricated anywhere. Its listeners are
  attached to `window` because the element that held the pointer capture has just been unmounted by the host — the
  capture is implicitly released with it, so there is nothing left to re-capture; `pointerId` filtering keeps a
  second finger out. A sheet presentation exposes no window geometry, so it ignores a handoff entirely.

  `nonce` makes the handoff single-use: re-rendering the host, or returning to the docked presentation and detaching
  again later, is a NEW gesture and must publish a new nonce.
  */
  dragHandoff?: FloatingWindowDragHandoff;
}

export interface FloatingWindowDragHandoff {
  pointerId: number;
  /** Live pointer position, in the same coordinate space as the work-area bounds. */
  pointer: FloatingWindowPosition;
  /** Point INSIDE the opened panel that must land on the pointer; defaults to the shared undock anchor. */
  grabOffset?: FloatingWindowPosition;
  /** Monotonic per-gesture token; a repeated value is ignored so one gesture is adopted exactly once. */
  nonce: number;
}

export interface FloatingWindowDragGestureEnd {
  windowKey: string;
  /** True only when the gesture travelled past the shared click threshold, so a click reports `false`. */
  moved: boolean;
  /** The snap mode retained by this gesture (`"floating"` when no zone was armed). */
  snapMode: FloatingWindowSnapMode;
  /** Final clamped rectangle, in the same coordinate space as `bounds`. */
  rect: FloatingWindowRect;
  bounds: DashboardWindowBounds;
}

const DEFAULT_MIN_WIDTH = 360;
const DEFAULT_MIN_HEIGHT = 280;
const TABLET_TOUCH_GEOMETRY_INSET = 16;

/*
FNXC:FloatingWindow 2026-06-22-21:30:
Z-index now comes from the SHARED `floatingWindowStack` module (`nextFloatingZ`/`currentFloatingZ`) so FloatingWindow stacks in ONE counter with the right-dock pop-out, the floating terminal, and the floating New Task dialog — tapping ANY of them raises it above all the others regardless of type. The local `topZ`/`nextZ` counter this file previously owned is gone.
*/

/*
FNXC:FloatingWindowSnap 2026-09-16-18:31:
FN-469: the shared drag loop only ever needs to attach/detach pointer listeners and, WHEN AVAILABLE, take pointer
capture. Describing the target structurally lets the same loop run on the captured element (historical path) and on
`window` (handed-over gesture, where the capturing element no longer exists) without a second implementation.
*/
interface PointerDragTarget {
  addEventListener(type: string, listener: (event: PointerEvent) => void): void;
  removeEventListener(type: string, listener: (event: PointerEvent) => void): void;
  setPointerCapture?: (pointerId: number) => void;
  releasePointerCapture?: (pointerId: number) => void;
}

type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const RESIZE_DIRECTIONS: ResizeDirection[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
export const FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT = "fusion:floating-window-geometry-change";

/*
FNXC:ModalTouchGeometry 2026-07-27-12:00:
FN-8619: Task Detail's body-portaled activity-view menu is a logical child of its modal.
Treating it as safe prevents a preference-enabled outside pointer-down from closing the host.

FNXC:FloatingWindow 2026-09-14-11:35:
Outside-pointer dismissal treats body-portaled controls as logical window children. Keep this selector aligned with shared model, thinking, agent, dependency, node, and priority portals so interacting with a child never dismisses its owner.
*/


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
  overlayClassName,
  // FN-394: accepted for source compatibility and intentionally unused; see the prop documentation above.
  persistGeometryKey: _persistGeometryKey,
  cascadeOffsetIndex: _cascadeOffsetIndex,
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
  onDragGestureEnd,
  openingSizePolicy = "aspect-ratio",
  dragHandoff,
}: FloatingWindowProps) {
  const { t } = useTranslation("app");
  const dashboardBounds = useDashboardWindowBounds();
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
  FNXC:ModalTouchGeometry 2026-09-17-00:49:
  Tablet corner handles overhang the painted panel by their 44px target. Reserve one shared
  16px geometry inset on every tablet-touch edge so a clamped southeast target remains inside
  the visual viewport instead of becoming unreachable past its right or bottom edge.
  */
  const availableBounds = useMemo(() => {
    if (!hasTabletTouchGeometry) return dashboardBounds;
    const inlineInset = Math.min(TABLET_TOUCH_GEOMETRY_INSET, dashboardBounds.width / 2);
    const blockInset = Math.min(TABLET_TOUCH_GEOMETRY_INSET, dashboardBounds.height / 2);
    const left = dashboardBounds.left + inlineInset;
    const top = dashboardBounds.top + blockInset;
    const right = Math.max(left, dashboardBounds.right - inlineInset);
    const bottom = Math.max(top, dashboardBounds.bottom - blockInset);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }, [dashboardBounds, hasTabletTouchGeometry]);
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
  const drawerExcluded = Boolean(className && /(?:setup-wizard|onboarding|confirm)/.test(className));
  /*
  FNXC:StandardizedDrawers 2026-09-15-04:56:
  FN-406: the phone-drawer predicate is resolved by the shared `resolveDrawerPresentation` seam and republished on
  context, so hosted content (which owns its own ViewHeader) suppresses the same chrome this shell does.
  */
  const mobileDrawer = resolveDrawerPresentation({ viewportMode, excluded: drawerExcluded });
  const effectiveModal = modal || mobileDrawer;
  /*
  FNXC:ModalGeometryPersistence 2026-07-16-00:40:
  Opt-in sheet callers present as a full-screen sheet at `max-width: 768px`. Most wide, short landscape
  phones remain movable FloatingWindows; Artifact Gallery opts into the separate `max-height: 480px`
  full-screen-sheet breakpoint as well.

  FNXC:FloatingWindowSnap 2026-09-14-21:10:
  FN-394: a sheet presentation exposes no window geometry at all — no drag, no resize handles, and no
  snap zones, because a half-width column is unusable at that size. Returning to a desktop viewport
  restores the floating rect this instance already holds in memory.
  */
  const sheetPresentation = mobileDrawer || (suspendGeometryPersistenceOnMobile && (
    isFullScreenSheetViewport() || (suspendGeometryPersistenceOnShortViewport && isShortViewport())
  ));

  /*
  FNXC:FloatingWindowCascade 2026-09-14-21:10:
  FN-394: cascade membership is keyed by an opaque per-instance token, never by `windowKey` or a storage
  key, so two windows sharing a logical id each get their own slot and a StrictMode remount reuses one.
  */
  const cascade = useDashboardWindowCascade();
  const instanceTokenRef = useRef<symbol>(Symbol(windowKey));
  const cascadeSlotRef = useRef(0);
  const userAdjustedRef = useRef(false);

  const openingRect = useMemo(
    () => resolveOpeningRect({ defaultSize, defaultPosition, minSize: resolvedMinSize, bounds: availableBounds, cascadeSlot: 0, openingSizePolicy }),
    // Opening geometry is captured once per identity; later bounds changes clamp instead of re-opening.
    [windowKey],
  );

  const [size, setSize] = useState<FloatingWindowSize>(() => openingRect.size);
  const [position, setPosition] = useState<FloatingWindowPosition>(() => openingRect.position);
  const [snapMode, setSnapMode] = useState<FloatingWindowSnapMode>("floating");
  const [snapPreview, setSnapPreview] = useState<FloatingWindowSnapMode | null>(null);
  /*
  FNXC:FloatingWindowSnap 2026-09-15-04:01:
  FN-401: the preview owns its OWN z claimed at arming time, because it is portaled to its own layer rather
  than painted inside this window's overlay. No z is claimed while nothing is armed.
  */
  const [snapPreviewZ, setSnapPreviewZ] = useState<number | null>(null);
  /** Floating rect captured before the FIRST snap; left → right → maximized never overwrites it. */
  const floatingRectRef = useRef<FloatingWindowRect>(openingRect);
  const snapModeRef = useRef<FloatingWindowSnapMode>("floating");
  snapModeRef.current = snapMode;
  const boundsRef = useRef(availableBounds);
  boundsRef.current = availableBounds;
  /*
  FNXC:FloatingWindowSnap 2026-09-15-22:32:
  FN-438: held in a ref so an owner may pass an inline callback without re-creating `handleDragPointerDown` and
  invalidating an in-flight gesture's captured listeners.
  */
  const onDragGestureEndRef = useRef(onDragGestureEnd);
  onDragGestureEndRef.current = onDragGestureEnd;
  const geometryRef = useRef<FloatingWindowRect>({ position, size });
  geometryRef.current = { position, size };

  const applyRect = useCallback((rect: FloatingWindowRect) => {
    setSize((current) => (current.width === rect.size.width && current.height === rect.size.height ? current : rect.size));
    setPosition((current) => (current.x === rect.position.x && current.y === rect.position.y ? current : rect.position));
  }, []);

  /*
  FNXC:FloatingWindowGeometry 2026-09-14-21:10:
  FN-394: a real user gesture removes this window from the pristine cascade cohort, freeing its slot for
  the next opening. Automatic re-clamping caused by shell or viewport changes is NOT a user gesture.
  */
  const markUserAdjusted = useCallback(() => {
    if (userAdjustedRef.current) return;
    userAdjustedRef.current = true;
    cascade.release(instanceTokenRef.current);
  }, [cascade]);

  const openStandard = useCallback((slot: number) => {
    const rect = resolveOpeningRect({
      defaultSize,
      defaultPosition,
      minSize: resolvedMinSize,
      bounds: boundsRef.current,
      cascadeSlot: slot,
      openingSizePolicy,
    });
    floatingRectRef.current = rect;
    snapModeRef.current = "floating";
    setSnapMode("floating");
    applyRect(rect);
  }, [applyRect, defaultPosition, defaultSize, openingSizePolicy, resolvedMinSize]);
  const openStandardRef = useRef(openStandard);
  openStandardRef.current = openStandard;

  /*
  FNXC:FloatingWindowCascade 2026-09-14-21:10:
  FN-394: the slot is reserved in layout (before paint), never during render, and released on unmount,
  scope reset, or a real gesture. A window replaced in place (new `windowKey`) is a NEW opening and
  restarts at its standard size; merely raising or re-rendering an existing instance changes nothing.
  */
  useLayoutEffect(() => {
    const token = Symbol(windowKey);
    instanceTokenRef.current = token;
    userAdjustedRef.current = false;
    const slot = sheetPresentation ? 0 : cascade.reserve(token);
    cascadeSlotRef.current = slot;
    openStandardRef.current(slot);
    return () => cascade.release(token);
  }, [cascade, windowKey]);

  /*
  FNXC:FloatingWindowBounds 2026-09-14-21:10:
  A mounted window reacts to shell landmark, dock-width, footer-variant, and viewport changes
  immediately. A snapped window re-derives its rect from the LIVE work area — so closing a sidebar
  widens both halves at once — while a floating window is only re-clamped. Global visibility changes
  never enter this effect, and neither path marks the window as user-adjusted.
  */
  useLayoutEffect(() => {
    if (sheetPresentation) return;
    if (snapMode !== "floating") {
      const snapped = resolveSnapRect(snapMode, availableBounds);
      if (snapped) applyRect(snapped);
      return;
    }
    /*
    A window the operator has never touched is still "just opened": when landmarks appear late or the
    shell resizes, it re-resolves its standard, centred, cascaded geometry against the new work area
    instead of drifting. Once really moved, resized, or snapped, only clamping applies.
    */
    if (!userAdjustedRef.current) {
      openStandardRef.current(cascadeSlotRef.current);
      return;
    }
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
  }, [applyRect, availableBounds, resolvedMinSize, sheetPresentation, snapMode]);

  /*
  FNXC:FloatingWindowSnap 2026-09-14-21:10:
  Applying a zone records the pre-snap floating rect exactly once, so a window can travel left → right →
  maximized and still restore the size it had before it ever snapped. Zones are never exclusive: any
  number of windows may occupy the same half or fill the work area.
  */
  const applySnapMode = useCallback((mode: FloatingWindowSnapMode) => {
    if (mode === "floating") return;
    if (snapModeRef.current === "floating") floatingRectRef.current = geometryRef.current;
    const rect = resolveSnapRect(mode, boundsRef.current);
    if (!rect) return;
    markUserAdjusted();
    snapModeRef.current = mode;
    setSnapMode(mode);
    applyRect(rect);
  }, [applyRect, markUserAdjusted]);

  const claimFrontZ = useCallback(() => (layer === "task-detail" ? nextTaskDetailFloatingZ() : nextFloatingZ()), [layer]);
  const readCurrentZ = useCallback(() => (layer === "task-detail" ? currentTaskDetailFloatingZ() : currentFloatingZ()), [layer]);
  /*
  FNXC:TaskPopupLayer 2026-09-14-11:35:
  Task-detail and Chat windows claim the same work-surface interaction band, so either may rise on pointer/focus. Other utility windows retain the higher global stack.
  */
  const [zIndex, setZIndex] = useState<number>(() => claimFrontZ());
  const panelRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLElement | null>(null);
  const windowSurface = useDashboardWindowSurface({
    logicalId: windowKey,
    group: surfaceGroup ?? (mobileDrawer ? "drawer" : effectiveModal ? "dialog" : "window"),
    locallyVisible: !hidden,
    stackOrder: zIndex,
  });
  const globallyHiddenRef = useRef(windowSurface.globallyHidden);
  globallyHiddenRef.current = windowSurface.globallyHidden;
  const effectiveHidden = hidden || windowSurface.globallyHidden;
  /*
  FNXC:FloatingWindowSnap 2026-09-17-04:51:
  FN-487 : « peu importe la modale que j'ancre tout en bas, ça doit faire exactement comme quand c'est le terminal ».
  Une bande ancrée en bas est `position: fixed` : sans réservation elle RECOUVRE la moitié basse du board. La fenêtre
  publie donc ici la hauteur à réserver et le shell recompose le contenu au-dessus, exactement comme
  `.terminal-below-host` le fait pour le terminal épinglé.
  La hauteur publiée va du BORD HAUT de la bande jusqu'au bas du viewport (et non la seule hauteur du panneau), pour
  couvrir aussi la barre du bas fixe que la bande recouvre déjà — parité avec `.terminal-below-host--with-footer`.
  Une présentation en feuille (téléphone) n'expose aucun ancrage, et une fenêtre masquée globalement ou localement ne
  réserve rien : dans les deux cas la bande n'est pas peinte, donc réserver serait une bande vide.
  */
  const publishBottomDockReservation = useDashboardWindowBottomDockReservationControl();
  const bottomDockToken = windowSurface.token;
  useEffect(() => {
    const docked = snapMode === "bottom" && !sheetPresentation && !effectiveHidden;
    if (!docked) {
      publishBottomDockReservation(bottomDockToken, null);
      return;
    }
    const viewportBottom = typeof window !== "undefined" && Number.isFinite(window.innerHeight)
      ? window.innerHeight
      : availableBounds.bottom;
    const reserved = Math.max(0, viewportBottom - position.y);
    publishBottomDockReservation(bottomDockToken, reserved > 0 ? reserved : null);
    return () => publishBottomDockReservation(bottomDockToken, null);
  }, [availableBounds, bottomDockToken, effectiveHidden, position.y, publishBottomDockReservation, sheetPresentation, size.height, snapMode]);

  const dismissHandleProps = useDrawerDismissGesture({
    enabled: mobileDrawer && !effectiveHidden,
    open: !effectiveHidden,
    panelRef,
    onDismiss: onClose,
  });

  /*
  FNXC:FloatingWindow 2026-06-22-20:45:
  A single active-drag/resize teardown (copied from the RightDockExpandModal pattern). pointerup/pointercancel run it, and the unmount effect runs it too, so an in-progress gesture interrupted by close/unmount never leaks captured-element pointer listeners or a pending rAF.
  */
  const dragTeardownRef = useRef<(() => void) | null>(null);

  /*
  FNXC:FloatingWindowGestureLayer 2026-09-18-02:21:
  FN-523 : la fenêtre engagée dans un geste à pointeur capturé est le DERNIER élément que l'opérateur a saisi ; elle
  doit donc être peinte au-dessus des surfaces transitoires dérivées du plafond vivant (popovers outils, menus
  éphémères), qu'une revendication ordinaire au compteur ne peut structurellement pas dépasser. L'élévation est
  revendiquée au démarrage du drag de bandeau ET du redimensionnement, et relâchée sur TOUTES les sorties de geste :
  `pointerup`, `pointercancel`, la démolition partagée `dragTeardownRef`, et le démontage. Elle n'est portée que par le
  rendu de l'overlay : `stackOrder` publie toujours la revendication ordinaire, pour que l'ordre du gestionnaire de
  fenêtres et la garde `current >= readCurrentZ()` de `bringToFront` restent justes.
  */
  const [engagedZ, setEngagedZ] = useState<number | null>(null);
  const beginGestureLayer = useCallback(() => setEngagedZ(engagedGestureZ()), []);
  const endGestureLayer = useCallback(() => setEngagedZ(null), []);

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

  /*
  FNXC:FloatingWindowSnap 2026-09-16-18:31:
  FN-469 extracts the BODY of the header drag verbatim so exactly one drag loop exists. Two callers reach it:
  - `handleDragPointerDown`, which keeps every guard and passes the captured element (the historical path, whose
    `setPointerCapture`/`releasePointerCapture` calls are unchanged);
  - the handoff effect below, which passes `window`, where those optional capture calls are simply absent and
    therefore skipped.

  The handed-over gesture deliberately keeps the ordinary click threshold and starts as "not moved": the window is
  already placed under the pointer by its opening rectangle, so releasing immediately must validate NOTHING — no snap
  zone, and no end-of-gesture placement an owner could read as a deliberate dock. Anything else would let a short
  pull-out immediately re-dock the window into the band its opening rectangle happens to touch.
  */
  const startPointerDrag = useCallback(
    (
      captureTarget: PointerDragTarget,
      pointerId: number,
      startX: number,
      startY: number,
    ) => {
      /*
      FNXC:ModalTouchGeometry 2026-07-26-12:19:
      A drag owns one captured pointer until matching up/cancel or unmount. Tear down any
      interrupted gesture before claiming this header so touch scroll, outside dismissal, and a
      second finger cannot retain listeners, selection suppression, or stale animation frames.
      */
      dragTeardownRef.current?.();
      bringToFront();
      beginGestureLayer();
      captureTarget.setPointerCapture?.(pointerId);
      const gestureStartMode = snapModeRef.current;
      const gestureStartRect = geometryRef.current;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";

      /*
      FNXC:FloatingWindowSnap 2026-09-14-21:10:
      One gesture owns four behaviors, in this order:
      1. Below the 6px threshold the gesture stays a CLICK: no geometry change, no cascade exit.
      2. A snapped window stays pinned until that same threshold is crossed in ANY direction; that detaches it
         back to the pre-snap floating rect, re-anchored under the pointer, and the drag continues from there.
      3. Once free, a zone is PREVIEWED whenever the PANEL's own clamped edge touches the matching work-area
         wall; the mode is applied on pointerup.
      4. `pointercancel` / lost capture validates nothing and returns to the pre-gesture geometry.

      FNXC:FloatingWindowSnap 2026-09-15-04:01:
      FN-401: a still-docked window arms NOTHING. Its rectangle is pinned by the zone, so it has no edge to
      offer, and the pointer alone may no longer carry a docked window to another wall. The way out of any
      dock — including the filled work area, where no wall is reachable at all — is the undock below; the SAME
      gesture may then continue on to another wall and arm it.

      FNXC:FloatingWindowSnap 2026-09-15-14:07:
      FN-422: that way out is now OMNIDIRECTIONAL and fires at the ordinary drag threshold. Requiring 24px of
      DOWNWARD travel meant a `maximized` or column window ignored every upward, lateral, and diagonal drag and
      simply looked stuck. A header CLICK still releases nothing.
      */
      let anchorX = startX;
      let anchorY = startY;
      let basePosition = gestureStartRect.position;
      let activeSize = gestureStartRect.size;
      let detached = gestureStartMode === "floating";
      let moved = false;
      /*
      FNXC:FloatingWindowSnap 2026-09-14-22:36:
      A maximized window's top edge sits ON the top wall, so a detach can finish with the panel still against that
      wall and instantly re-arm the very mode it just left — the window would never come loose. After a detach the
      ABANDONED mode stays disarmed until the panel leaves that wall; carrying the window straight to a DIFFERENT
      zone (left to right, side to top) keeps working in the same gesture.

      FNXC:FloatingWindowSnap 2026-09-15-14:07:
      FN-422 makes this MORE necessary, not less: an upward or lateral undock from `maximized` or a column lands the
      restored rect right back against the wall it just left, so `disarmedZone` is what keeps the release visible.
      */
      let disarmedZone: FloatingWindowSnapMode | null = null;
      /*
      FNXC:FloatingWindowSnap 2026-09-17-07:21:
      FN-493 separates the FN-469 undock artifact from the abandoned-zone disarm above. The artifact is purely
      VERTICAL (`resolveDetachedRect` anchors 24px under the pointer, so a tall window's bottom edge is clamped onto
      the bottom wall), so it must neutralise only the BOTTOM COMPONENT of whatever is detected — never a legitimate
      side contact, which since FN-493 would otherwise turn into a bottom quadrant the operator never aimed at.
      */
      let bottomArtifactDisarmed = false;
      let previewZone: FloatingWindowSnapMode | null = null;
      let latest = basePosition;
      let frame = 0;

      const setPreview = (zone: FloatingWindowSnapMode | null) => {
        if (previewZone === zone) return;
        previewZone = zone;
        setSnapPreview(zone);
        setSnapPreviewZ(zone === null ? null : nextSnapPreviewZ());
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        moveEvent.preventDefault();
        const bounds = boundsRef.current;
        if (!detached) {
          if (!shouldDetachSnappedWindow({ x: startX, y: startY }, { x: moveEvent.clientX, y: moveEvent.clientY })) {
            // Pinned: the panel cannot move, so it exposes no edge and nothing can be armed yet.
            setPreview(null);
            return;
          }
          const restored = resolveDetachedRect(
            floatingRectRef.current,
            { x: moveEvent.clientX, y: moveEvent.clientY },
            resolvedMinSize,
            bounds,
          );
          detached = true;
          moved = true;
          activeSize = restored.size;
          basePosition = restored.position;
          anchorX = moveEvent.clientX;
          anchorY = moveEvent.clientY;
          latest = restored.position;
          markUserAdjusted();
          snapModeRef.current = "floating";
          setSnapMode("floating");
          applyRect(restored);
          /*
          FNXC:FloatingWindowSnap 2026-09-16-18:31:
          FN-469 adds ONE case to this disarm, for the bottom band only. `resolveDetachedRect` re-anchors the window
          HORIZONTALLY under the pointer (so a side contact after an undock still reflects where the operator put the
          pointer) but VERTICALLY at a fixed 24px offset. A window taller than the pointer's distance to the bottom
          wall is therefore clamped with its bottom edge exactly ON that wall as a pure artifact of the undock — it
          would re-dock into the band the operator never asked for, and for common window sizes that is nearly every
          undock in the lower half. The band is disarmed until the panel leaves the wall; travelling on to any other
          wall in the same gesture keeps working exactly as FN-422 defined.
          */
          bottomArtifactDisarmed = rectRestsOnBottomWall(restored, bounds);
          disarmedZone = gestureStartMode === "floating" ? null : gestureStartMode;
          // Fall through: the very event that detached the window may already sit inside another band.
        }
        if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < FLOATING_WINDOW_DRAG_THRESHOLD_PX) return;
        moved = true;
        markUserAdjusted();
        latest = { x: basePosition.x + moveEvent.clientX - anchorX, y: basePosition.y + moveEvent.clientY - anchorY };
        // The candidate rect must be CLAMPED before detection: an unclamped position never touches a wall.
        const candidate = { position: clampFloatingWindowPosition(latest, activeSize, bounds), size: activeSize };
        // The undock artifact expires as soon as the panel actually leaves the bottom wall (FN-469, FN-493).
        if (bottomArtifactDisarmed && !rectRestsOnBottomWall(candidate, bounds)) bottomArtifactDisarmed = false;
        const detected = detectSnapZoneForRect(candidate, bounds);
        const zone = bottomArtifactDisarmed ? demoteBottomAnchoredSnapMode(detected) : detected;
        if (disarmedZone !== null && zone === disarmedZone) {
          setPreview(null);
        } else {
          disarmedZone = null;
          setPreview(zone);
        }
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          setPosition(clampFloatingWindowPosition(latest, activeSize, boundsRef.current));
        });
      };
      const detachListeners = () => {
        captureTarget.releasePointerCapture?.(pointerId);
        captureTarget.removeEventListener("pointermove", handlePointerMove);
        captureTarget.removeEventListener("pointerup", handlePointerUp);
        captureTarget.removeEventListener("pointercancel", handlePointerCancel);
      };
      function handlePointerUp(upEvent: PointerEvent) {
        if (upEvent.pointerId !== pointerId) return;
        upEvent.preventDefault();
        if (frame) cancelAnimationFrame(frame);
        const committedZone = previewZone;
        setPreview(null);
        if (moved) {
          if (committedZone) applySnapMode(committedZone);
          else setPosition(clampFloatingWindowPosition(latest, activeSize, boundsRef.current));
        }
        document.body.style.userSelect = previousUserSelect;
        detachListeners();
        dragTeardownRef.current = null;
        endGestureLayer();
        /*
        FNXC:FloatingWindowSnap 2026-09-15-22:32:
        FN-438: publish the VALIDATED end of gesture, last, after the retained zone or final position has been
        applied above. Everything an owner needs is computed here rather than measured from the DOM, because the
        pending animation frame was just cancelled and the committed geometry is not painted yet.
        */
        if (onDragGestureEndRef.current) {
          const bounds = boundsRef.current;
          const committedRect = (committedZone ? resolveSnapRect(committedZone, bounds) : null)
            ?? { position: clampFloatingWindowPosition(latest, activeSize, bounds), size: activeSize };
          onDragGestureEndRef.current({
            windowKey,
            moved,
            snapMode: committedZone ?? "floating",
            rect: committedRect,
            bounds,
          });
        }
      }
      function handlePointerCancel(cancelEvent: PointerEvent) {
        if (cancelEvent.pointerId !== pointerId) return;
        if (frame) cancelAnimationFrame(frame);
        setPreview(null);
        // An interrupted gesture validates nothing: restore the pre-gesture placement inside live bounds.
        snapModeRef.current = gestureStartMode;
        setSnapMode(gestureStartMode);
        const restored = gestureStartMode === "floating"
          ? gestureStartRect
          : resolveSnapRect(gestureStartMode, boundsRef.current) ?? gestureStartRect;
        applyRect({
          size: clampFloatingWindowSize(restored.size, resolvedMinSize, boundsRef.current),
          position: clampFloatingWindowPosition(restored.position, restored.size, boundsRef.current),
        });
        document.body.style.userSelect = previousUserSelect;
        detachListeners();
        dragTeardownRef.current = null;
        endGestureLayer();
      }

      dragTeardownRef.current = () => {
        if (frame) cancelAnimationFrame(frame);
        setPreview(null);
        document.body.style.userSelect = previousUserSelect;
        detachListeners();
        dragTeardownRef.current = null;
        endGestureLayer();
      };

      captureTarget.addEventListener("pointermove", handlePointerMove);
      captureTarget.addEventListener("pointerup", handlePointerUp);
      captureTarget.addEventListener("pointercancel", handlePointerCancel);
    },
    [applyRect, applySnapMode, beginGestureLayer, bringToFront, endGestureLayer, markUserAdjusted, resolvedMinSize, windowKey]
  );
  const startPointerDragRef = useRef(startPointerDrag);
  startPointerDragRef.current = startPointerDrag;

  const handleDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      /*
      FNXC:ModalTouchGeometry 2026-07-26-13:35:
      FN-8606 sheet callers must expose neither movable geometry nor resize chrome on phone and
      short viewports. Do not begin a delegated or built-in header drag while persistence is
      suspended; CSS alone cannot prevent the panel-level pointer handler from receiving touches.
      */
      /* FNXC:ModalTouchGeometry 2026-07-26-14:20: Delegated headers commonly contain links (for example Settings' GitHub/Discord actions), which must retain native activation rather than starting a window drag. */
      if (!windowSurface.surfaceActive || sheetPresentation || (event.target as HTMLElement).closest("button, a, input, select, textarea, [contenteditable=\"true\"], [role=\"button\"], [role=\"link\"]")) return;
      event.preventDefault();
      event.stopPropagation();
      startPointerDrag(event.currentTarget, event.pointerId, event.clientX, event.clientY);
    },
    [sheetPresentation, startPointerDrag, windowSurface.surfaceActive],
  );

  /*
  FNXC:FloatingWindowSnap 2026-09-16-18:31:
  FN-469 adoption of a handed-over gesture. It runs in LAYOUT so the window is never painted at the centred opening
  rectangle first, marks the window user-adjusted (it is a real gesture, so it also leaves the pristine cascade
  cohort), and resumes the shared drag loop on `window`. `nonce` guards against re-adopting the same gesture on a
  re-render; a sheet presentation or an inactive surface ignores it entirely and attaches no listener.
  */
  const adoptedHandoffNonceRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!dragHandoff || sheetPresentation || !windowSurface.surfaceActive) return;
    if (adoptedHandoffNonceRef.current === dragHandoff.nonce) return;
    adoptedHandoffNonceRef.current = dragHandoff.nonce;
    const rect = resolveHandoffRect({
      size: geometryRef.current.size,
      pointer: dragHandoff.pointer,
      grabOffset: dragHandoff.grabOffset,
      minSize: resolvedMinSize,
      bounds: boundsRef.current,
    });
    floatingRectRef.current = rect;
    snapModeRef.current = "floating";
    setSnapMode("floating");
    markUserAdjusted();
    // The drag loop reads its start rectangle from this ref, and the state write above is not committed yet.
    geometryRef.current = rect;
    applyRect(rect);
    startPointerDragRef.current(window, dragHandoff.pointerId, dragHandoff.pointer.x, dragHandoff.pointer.y);
  }, [applyRect, dragHandoff, markUserAdjusted, resolvedMinSize, sheetPresentation, windowSurface.surfaceActive]);

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
      beginGestureLayer();
      const captureTarget = event.currentTarget;
      const pointerId = event.pointerId;
      captureTarget.setPointerCapture?.(pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const startSize = geometryRef.current.size;
      const startPosition = geometryRef.current.position;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";

      let latestSize = startSize;
      let latestPosition = startPosition;
      let frame = 0;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        moveEvent.preventDefault();
        // A resize is a real user gesture: the window leaves the pristine cascade cohort.
        markUserAdjusted();
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
        endGestureLayer();
      }

      dragTeardownRef.current = () => {
        if (frame) cancelAnimationFrame(frame);
        document.body.style.userSelect = previousUserSelect;
        detachListeners();
        dragTeardownRef.current = null;
        endGestureLayer();
      };

      captureTarget.addEventListener("pointermove", handlePointerMove);
      captureTarget.addEventListener("pointerup", handlePointerUp);
      captureTarget.addEventListener("pointercancel", handlePointerUp);
    },
    [availableBounds, beginGestureLayer, bringToFront, endGestureLayer, markUserAdjusted, resolvedMinSize, windowSurface.surfaceActive]
  );

  // FNXC:FloatingWindow 2026-06-22-20:45: Run any active drag/resize teardown on unmount so captured-element listeners + a pending rAF never outlive the window.
  // FN-523: the same teardown releases the gesture layer, so an unmount mid-gesture leaves no elevated claim behind.
  useEffect(() => () => dragTeardownRef.current?.(), []);
  /*
  FNXC:FloatingWindowSnap 2026-09-16-18:31:
  FN-469: a sheet presentation exposes NO window geometry, so an in-flight drag must not survive the transition into
  one. This matters for a handed-over gesture, because the breakpoint classification can settle one tick after mount
  (a phone resolves its viewport mode asynchronously), but it equally protects a tablet rotated mid-drag: without it
  the gesture would keep suppressing text selection and holding listeners for a window that can no longer move.
  */
  useEffect(() => {
    if (!windowSurface.surfaceActive || sheetPresentation) dragTeardownRef.current?.();
  }, [sheetPresentation, windowSurface.surfaceActive]);

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
  FNXC:FloatingWindowGeometry 2026-09-14-21:10:
  FN-394 DELETED durable window geometry. A window's size and position belong to its current opening
  only: nothing is written to or read from storage, so a new window can never inherit the size or place
  of a previous session, of another window, or of an occupied snap zone. Historical keys are left
  untouched in storage (no global purge) and other preferences and drafts are unaffected.
  */

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
  /*
  FNXC:FloatingWindowDialogHosts 2026-09-14-22:36:
  The modal focus boundary must be installed ONCE per visible mounting, not on every render. Hosts pass an inline
  `onClose` arrow, so depending on its identity re-ran this effect on each keystroke: the cleanup restored the prior
  focus and the effect re-focused the panel, which destroyed typing in a hosted form after the first character.
  Read the latest handler through a ref instead.
  */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!effectiveModal || effectiveHidden || typeof document === "undefined") {
      if (globallyHiddenRef.current) restoringFromGlobalHideRef.current = true;
      return;
    }
    const skipAutoFocus = restoringFromGlobalHideRef.current;
    restoringFromGlobalHideRef.current = false;
    const panel = panelRef.current;
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    /* FNXC:FloatingWindowDialogHosts 2026-09-14-22:36: a hosted dialog may autofocus its own first control; only claim focus for the panel when the window does not already own it, so an `autoFocus` field is not defeated by the boundary. */
    if (!skipAutoFocus && !(panel && panel.contains(document.activeElement))) panel?.focus();
    /*
    FNXC:FloatingWindowDialogHosts 2026-09-14-22:36:
    Every modal window installs a DOCUMENT keydown listener, so with several of them open an Escape press reached all
    of them and closed the whole pile (a confirmation raised over an editor closed both). The keyboard boundary belongs
    to the FRONTMOST visible modal window only: highest `z-index`, later DOM order breaking a tie.
    */
    const ownsKeyboardBoundary = () => {
      const overlay = panelRef.current?.parentElement;
      if (!overlay || typeof document === "undefined") return true;
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(".floating-window-overlay--modal"))
        .filter((element) => !element.classList.contains("floating-window-overlay--hidden"));
      if (candidates.length <= 1) return true;
      const front = candidates.reduce((best, element) => (
        (Number.parseInt(element.style.zIndex || "0", 10) || 0) >= (Number.parseInt(best.style.zIndex || "0", 10) || 0) ? element : best
      ), candidates[0]!);
      return front === overlay;
    };
    /*
    FNXC:FloatingWindowDialogHosts 2026-09-14-22:36:
    A key pressed inside ANOTHER window belongs to that window, never to this one. Without this check an Escape typed
    in the workflow editor closed the create dialog stacked above it.
    */
    const eventBelongsToAnotherWindow = (event: KeyboardEvent) => {
      const overlay = panelRef.current?.parentElement;
      const target = event.target;
      if (!overlay || !(target instanceof Node)) return false;
      if (overlay.contains(target)) return false;
      const owner = target instanceof Element ? target.closest(".floating-window-overlay") : null;
      return Boolean(owner) && owner !== overlay;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (eventBelongsToAnotherWindow(event) || !ownsKeyboardBoundary()) return;
      /*
      FNXC:MobileDrawer 2026-09-11-02:01:
      A mobile drawer FloatingWindow has no close button, so its modal keyboard boundary must retain Escape as a secondary recovery path alongside handle drag and backdrop dismissal.
      */
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
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
  }, [effectiveHidden, effectiveModal]);

  /*
  FNXC:MobileKeyboardViewport 2026-09-17-14:23:
  FN-512: a floating window is positioned in LAYOUT coordinates, so when the soft keyboard shrinks
  only the visual viewport (WebKit) the window keeps its stored geometry and its footer controls can
  end up behind the keyboard. The window measures its OWN rectangle against the visible bottom edge
  and caps the rendered height; `size.height` — the persisted user preference — is never rewritten,
  so closing the keyboard restores the saved dimensions exactly.

  Publishing ownership prevents hosted forms and Chat from clamping a second time inside a window
  that has already been bounded.
  */
  const keyboardSurface = useKeyboardViewportSurface(panelRef, {
    enabled: !effectiveHidden && windowSurface.surfaceActive && !mobileDrawer,
    standalone: true,
    blockSizeProperty: "--floating-window-visible-block-size",
  });
  /*
  FNXC:MobileKeyboardViewport 2026-09-17-15:32:
  FN-512 remediation: on a phone this window is re-presented as a drawer, and that presentation is
  NOT adaptable by an inline height cap. `.floating-window--mobile-drawer` sets `height` and
  `max-height` with `!important`, which beats an inline style, and the overlay bottom-aligns its
  panel, so even a respected cap would leave the panel's bottom edge glued to the layout bottom —
  under the keyboard. The drawer presentation is therefore adapted exactly like `MobileDrawer`: the
  OVERLAY's bottom edge is pulled up by the residual inset taken straight from the shared frame
  (`anchor: "layout-bottom"`, no element measurement and therefore no feedback loop), and the panel
  fills the reduced overlay through percentage sizing.

  The two surfaces are mutually exclusive by `enabled`, so exactly one adaptation exists per window,
  and ownership is published ONLY when an adaptation is really applied — otherwise descendants would
  stand down for a clamp that never happened, which is the regression this fixes.
  */
  const drawerKeyboardSurface = useKeyboardViewportSurface(overlayRef, {
    enabled: !effectiveHidden && windowSurface.surfaceActive && mobileDrawer,
    standalone: true,
    anchor: "layout-bottom",
    bottomInsetProperty: "--mobile-drawer-keyboard-inset",
  });
  /*
  FNXC:DashboardWindowSurfaceRefIdentity 2026-09-17-19:34:
  FN-515: this composed root ref MUST keep a stable identity across renders. `windowSurface.rootRef`
  publishes into the window manager, which treats a `root` change as a real change, so an inline
  callback made React detach (publish null) then re-attach (publish the node) on every render. Each
  pair bumped `surfaceRevision` twice, the provider re-rendered this consumer, and the next render
  produced yet another callback — the runaway loop that surfaced as React #185 on modal open.

  Depend ONLY on `windowSurface.rootRef` (already stable), never on the whole `windowSurface` binding,
  which is a fresh object each render. `null` is still forwarded on a genuine detach so the registry
  can release the surface.
  */
  const setOverlayRef = useCallback((node: HTMLDivElement | null) => {
    overlayRef.current = node;
    windowSurface.rootRef(node);
  }, [windowSurface.rootRef]);
  const drawerKeyboardBounded = mobileDrawer && drawerKeyboardSurface.bottomInset > 0;
  const windowKeyboardBounded = !mobileDrawer && keyboardSurface.maxBlockSize !== null;
  const keyboardBounded = drawerKeyboardBounded || windowKeyboardBounded;
  const keyboardOwnership = useMemo(() => ({ owned: keyboardBounded }), [keyboardBounded]);

  const panelStyle = {
    left: `${position.x}px`,
    top: `${position.y}px`,
    width: `${size.width}px`,
    height: `${size.height}px`,
    ...(windowKeyboardBounded ? { maxHeight: `${keyboardSurface.maxBlockSize}px` } : {}),
    zIndex,
  } as CSSProperties;

  /*
  FNXC:FloatingWindowSnap 2026-09-14-21:10:
  The preview is pure paint: it is `aria-hidden`, never focusable, and `pointer-events: none`, so it can
  neither receive a click nor intercept the gesture that armed it. It is rendered only while a zone is
  armed and is discarded on pointerup, pointercancel, hide, and unmount.

  FNXC:FloatingWindowSnap 2026-09-15-04:01:
  FN-401: it is also rendered in its OWN body portal, outside this window's overlay. The overlay's inline
  z-index opens a closed stacking context, so a preview nested inside it could never outrank the board or
  another window no matter what z it carried. A hidden window shows no preview at all, which also guarantees
  no orphan node survives in `document.body`.
  */
  const previewRect = snapPreview && !effectiveHidden ? resolveSnapRect(snapPreview, availableBounds) : null;
  const snapPreviewLayer = previewRect
    ? createPortal(
      <div
        className={`floating-window__snap-preview floating-window__snap-preview--${snapPreview}`}
        data-testid={`floating-window-snap-preview-${windowKey}`}
        data-snap-zone={snapPreview ?? undefined}
        aria-hidden
        style={{
          left: `${previewRect.position.x}px`,
          top: `${previewRect.position.y}px`,
          width: `${previewRect.size.width}px`,
          height: `${previewRect.size.height}px`,
          zIndex: snapPreviewZ ?? zIndex,
        }}
      />,
      document.body,
    )
    : null;

  /*
  FNXC:FloatingWindow 2026-06-22-21:10:
  Rendered via a portal to document.body so the window escapes every ancestor stacking context (board card badges, the List view's sticky sort header + column divider, transformed columns, etc.). Without the portal the panel's z-index battles inside whatever subtree mounted it, letting card dependency/overlap tags and the list divider/sort header paint over the modal. At document.body the 4000+ z-index wins over all page content.

  FNXC:FloatingWindowVisibility 2026-09-14-11:35:
  Hidden windows remain portaled and layout-participating so child identity, geometry, and scroll survive. Visibility, inertness, aria state, and suspended handlers remove retained surfaces from paint, focus, and interaction without display removal.
  */
  return (
    <>
    {snapPreviewLayer}
    {createPortal(
    <div
      ref={setOverlayRef}
      className={`floating-window-overlay${effectiveModal ? " floating-window-overlay--modal" : ""}${mobileDrawer ? " floating-window-overlay--mobile-drawer" : ""}${drawerKeyboardBounded ? " floating-window-overlay--keyboard-bounded" : ""}${effectiveHidden ? " floating-window-overlay--hidden" : ""}${overlayClassName ? ` ${overlayClassName}` : ""}`}
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
        if (mobileDrawer && event.target === event.currentTarget) onClose();
      }}
      onMouseUp={effectiveHidden ? undefined : backdropMouseHandlers?.onMouseUp}
      onClick={effectiveHidden ? undefined : backdropMouseHandlers?.onClick}
      onTouchStart={effectiveHidden ? undefined : backdropMouseHandlers?.onTouchStart}
      onTouchEnd={effectiveHidden ? undefined : backdropMouseHandlers?.onTouchEnd}
      // FNXC:ModalTouchGeometry 2026-07-27-12:00: FN-8619 keeps Agent Detail's paired mouse-only backdrop contract at the shared modal backdrop; this deliberately does not alter pointer-down dismissal.
      // FNXC:FloatingWindow 2026-06-22-23:00: The z-index MUST live on the position:fixed overlay (which creates a stacking context), not the panel. A panel z-index is trapped inside the overlay's context and loses to page elements that are stacking contexts in body's context (e.g. the right dock at position:absolute z-index:20). With z on the overlay, the whole window sits at the shared floating band in body's stacking context and reliably paints above page content + tap-to-front reorders correctly.
      // FN-523: an engaged gesture paints this overlay above the transient band; `stackOrder` keeps the ordinary claim.
      style={{ zIndex: engagedZ ?? zIndex, ...(mobileDrawer ? drawerKeyboardSurface.style : {}) } as CSSProperties}
      data-keyboard-bounded={drawerKeyboardBounded || undefined}
    >
      <div
        ref={panelRef}
        data-snap-mode={snapMode}
        data-keyboard-bounded={keyboardBounded || undefined}
        className={`floating-window${hideHeader ? " floating-window--headerless" : ""}${hasTabletTouchGeometry ? " floating-window--touch-geometry" : ""}${isTabletViewportMode ? " floating-window--tablet-viewport" : ""}${mobileDrawer ? " floating-window--mobile-drawer" : ""}${snapMode === "floating" ? "" : ` floating-window--snapped floating-window--snap-${snapMode}`}${className ? ` ${className}` : ""}`}
        style={panelStyle}
        data-testid={`floating-window-${windowKey}`}
        onPointerDownCapture={windowSurface.surfaceActive ? bringToFront : undefined}
        onPointerDown={(event) => {
          if (mobileDrawer) dismissHandleProps.onPointerDown(event);
          else handlePanelPointerDown(event);
        }}
        onPointerMove={mobileDrawer ? dismissHandleProps.onPointerMove : undefined}
        onPointerUp={mobileDrawer ? dismissHandleProps.onPointerUp : undefined}
        onPointerCancel={mobileDrawer ? dismissHandleProps.onPointerCancel : undefined}
        onLostPointerCapture={mobileDrawer ? dismissHandleProps.onLostPointerCapture : undefined}
        onFocusCapture={windowSurface.surfaceActive ? bringToFrontOnFocus : undefined}
        tabIndex={effectiveModal ? -1 : undefined}
      >
        {/*
        FNXC:ModalTouchGeometry 2026-07-26-16:54:
        Phone and short-viewport callers opt into a full-screen sheet. Do not merely hide resize
        handles with CSS there: removing them from the accessibility tree ensures those sheets
        expose no floating-window affordance or touch gesture surface.
        */}
        {mobileDrawer && (
          <ViewDrawerHandle className="floating-window__drawer-handle-target" barClassName="floating-window__drawer-handle" />
        )}
        {/*
        FNXC:FloatingWindowSnap 2026-09-14-21:10:
        A snapped window owns the full half or the full work area, so free resizing is meaningless there:
        the handles are REMOVED from the accessibility tree, not merely hidden, and detaching restores them.
        */}
        {!sheetPresentation && snapMode === "floating" && RESIZE_DIRECTIONS.map((direction) => (
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
            {!mobileDrawer && (
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
            <KeyboardViewportOwnerProvider value={keyboardOwnership}>
              <DrawerPresentationProvider value={mobileDrawer}>{children}</DrawerPresentationProvider>
            </KeyboardViewportOwnerProvider>
          </DashboardWindowSurfaceActivityProvider>
        </ViewLayoutContent>
      </div>
    </div>,
    document.body,
    )}
    </>
  );
}
