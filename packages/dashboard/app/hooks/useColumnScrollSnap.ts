import { useEffect, useState } from "react";
import { isMobileViewport } from "./useViewportMode";

/*
FNXC:BoardNavigation 2026-07-22-18:00:
Wrong-way snaps came from (1) settle direction using the last micro scroll tick — iOS
rubber-band/fling end often reverses for a frame — and (2) origin±nearest hybrid targets.
Direction is locked at finger-up from net gesture delta only (never post-lift ticks). Target
is always the next column in that scroll direction from the current viewport (classic
directional page snap). Pin until next touch; hard-jump kills residual fling.

FNXC:BoardNavigation 2026-07-22-15:10:
A tap during post-lift momentum must cancel the pending directional settle and re-baseline
the gesture at the current scrollLeft (pointerHeld true). Otherwise the original swipe's
idle timer still hard-jumps the board away from where the user stopped.

FNXC:BoardNavigation 2026-07-22-15:26:
After any user touch sequence ends, the board must rest on exactly one column center — never
between columns. Tap-to-stop and zero-pan lifts hard-jump to the nearest center (not the
cancelled swipe's directional page). Directional paging still applies only when the settle
gesture itself had pan intent.
*/
/** After lift/cancel/wheel: wait for scroll idle (momentum finished) before paging. */
const SCROLL_IDLE_SETTLE_MS = 48;
const CENTER_TOLERANCE_PX = 1;
/** Minimum finger travel to count as a horizontal pan (short swipe still commits). */
const MIN_PAN_CLIENT_PX = 12;
/** Keep a WebKit compositor write from outliving the main-thread hard jump. */
const PIN_REASSERT_INTERVAL_MS = 16;

export interface UseColumnScrollSnapOptions {
  /** Restrict magnetic snapping to phone-class viewports. */
  mobileOnly?: boolean;
  /** Test seam; production callers must use the default trusted-event predicate. */
  isUserInteraction?: (event: Event) => boolean;
}

function defaultIsUserInteraction(event: Event): boolean {
  return event.isTrusted;
}

function addMediaChangeListener(query: MediaQueryList, listener: () => void): () => void {
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }
  query.addListener(listener);
  return () => query.removeListener(listener);
}

function getClientPoint(event: Event): { x: number; y: number } | null {
  if (typeof TouchEvent !== "undefined" && event instanceof TouchEvent) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  if ("clientX" in event && typeof (event as PointerEvent).clientX === "number") {
    return { x: (event as PointerEvent).clientX, y: (event as PointerEvent).clientY };
  }
  return null;
}

/** Prefer `.column` children so spacers/chrome are not snap targets. */
export function getSnapColumns(scroller: HTMLElement): HTMLElement[] {
  const all = Array.from(scroller.children).filter(
    (node): node is HTMLElement => node instanceof HTMLElement,
  );
  const columns = all.filter((el) => el.classList.contains("column"));
  return columns.length >= 2 ? columns : all;
}

/** Index of the column whose center is closest to the scroller viewport center. */
export function nearestColumnIndex(scroller: HTMLElement, columns: HTMLElement[]): number {
  const scrollerRect = scroller.getBoundingClientRect();
  const viewportWidth = scroller.clientWidth || scrollerRect.width;
  if (viewportWidth <= 0 || columns.length === 0) return 0;

  const viewportCenter = scrollerRect.left + viewportWidth / 2;
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < columns.length; index++) {
    const rect = columns[index].getBoundingClientRect();
    const distance = Math.abs(rect.left + rect.width / 2 - viewportCenter);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  }
  return nearestIndex;
}

/** scrollLeft that centers `column` in the scroller viewport (integer pixels). */
function scrollLeftToCenterColumn(scroller: HTMLElement, column: HTMLElement): number {
  const scrollerRect = scroller.getBoundingClientRect();
  const viewportWidth = scroller.clientWidth || scrollerRect.width;
  const viewportCenter = scrollerRect.left + viewportWidth / 2;
  const columnRect = column.getBoundingClientRect();
  return Math.round(scroller.scrollLeft + columnRect.left + columnRect.width / 2 - viewportCenter);
}

/** Whether the viewport is already centered on one of its eligible snap columns. */
export function isColumnCentered(
  scroller: HTMLElement,
  columns: HTMLElement[],
  tolerance = CENTER_TOLERANCE_PX,
): boolean {
  if (columns.length === 0) return false;
  const nearest = nearestColumnIndex(scroller, columns);
  return Math.abs(scroller.scrollLeft - scrollLeftToCenterColumn(scroller, columns[nearest])) <= tolerance;
}

/**
 * Resolve pan direction from the full gesture (net deltas only).
 * Do NOT pass last micro-tick direction for settle — rubber-band flips it.
 * +1 = scroll right / next columns, -1 = scroll left / previous.
 *
 * FNXC:BoardNavigation 2026-07-22-21:40:
 * Finger travel counts as horizontal pan intent only when it dominates the vertical axis —
 * a vertical card-list scroll with incidental diagonal drift must not page the board.
 * The board's own horizontal scrollDelta stays authoritative regardless of finger axis.
 */
export function resolvePanDirection(options: {
  scrollDelta: number;
  /** gestureStartClientX - endClientX: finger left → positive → next column */
  clientDelta: number;
  /** gestureStartClientY - endClientY: vertical finger travel for axis dominance. */
  clientDeltaY?: number;
}): number {
  const { scrollDelta, clientDelta, clientDeltaY = 0 } = options;
  if (scrollDelta > CENTER_TOLERANCE_PX) return 1;
  if (scrollDelta < -CENTER_TOLERANCE_PX) return -1;
  if (Math.abs(clientDelta) <= Math.abs(clientDeltaY)) return 0;
  if (clientDelta >= MIN_PAN_CLIENT_PX) return 1;
  if (clientDelta <= -MIN_PAN_CLIENT_PX) return -1;
  return 0;
}

/*
FNXC:BoardNavigation 2026-07-22-21:05:
The prior directional pager targeted "one past nearest" whenever the viewport center had
crossed the nearest column's center, so a fling that decelerated with a column mostly on
screen still got pushed a further column — a visible overshoot. Settle now uses the classic
paging rule: land on the NEAREST (mostly-on-screen) column, but guarantee at least one
column of progress from the gesture's ORIGIN column in the locked direction, so a short
deliberate swipe still commits to the next column and the settle never moves against travel.
*/
/**
 * Pick the column to land on at settle time.
 *
 * Nearest column wins (it is the one mostly on screen as momentum ends), clamped so a
 * directional gesture always advances at least one column from `originIndex` and never
 * settles against the locked scroll direction.
 */
export function resolveSettleTargetIndex(
  scroller: HTMLElement,
  columns: HTMLElement[],
  direction: number,
  originIndex: number,
): number {
  if (columns.length <= 1) return 0;
  const nearest = nearestColumnIndex(scroller, columns);
  if (direction === 0) return nearest;

  const origin = Math.min(Math.max(originIndex, 0), columns.length - 1);
  if (direction > 0) {
    // Content scrolling right: at least origin+1, otherwise wherever momentum landed.
    return Math.max(nearest, Math.min(origin + 1, columns.length - 1));
  }
  // Content scrolling left: mirror.
  return Math.min(nearest, Math.max(origin - 1, 0));
}

/**
 * Kill residual scroll inertia and jump to an integer scrollLeft.
 */
function hardJumpScrollLeft(scroller: HTMLElement, targetLeft: number): void {
  const target = Math.round(targetLeft);
  const priorOverflowX = scroller.style.overflowX;
  const priorBehavior = scroller.style.scrollBehavior;
  const priorWebkit = scroller.style.getPropertyValue("-webkit-overflow-scrolling");

  scroller.style.scrollBehavior = "auto";
  scroller.style.scrollSnapType = "none";
  scroller.style.overflowX = "hidden";
  scroller.style.setProperty("-webkit-overflow-scrolling", "auto");
  scroller.scrollLeft = target;
  void scroller.offsetWidth;
  scroller.scrollLeft = target;

  scroller.style.overflowX = priorOverflowX;
  scroller.style.scrollBehavior = priorBehavior;
  if (priorWebkit) {
    scroller.style.setProperty("-webkit-overflow-scrolling", priorWebkit);
  } else {
    scroller.style.removeProperty("-webkit-overflow-scrolling");
  }
  scroller.scrollLeft = target;
}

/**
 * Mobile board: free-scroll + momentum, then hard-page only in the scroll direction.
 *
 * FNXC:BoardNavigation 2026-07-22-18:00:
 * Lock settle direction at finger-up from net gesture deltas. Pin until next touch.
 *
 * FNXC:BoardNavigation 2026-07-22-21:05:
 * Target via resolveSettleTargetIndex: nearest (mostly-on-screen) column, clamped to at least
 * one column of progress from the gesture's origin column — commits short swipes without
 * overshooting a fling that already decelerated onto a column.
 */
export function useColumnScrollSnap(
  scroller: HTMLElement | null,
  { mobileOnly = false, isUserInteraction = defaultIsUserInteraction }: UseColumnScrollSnapOptions = {},
): void {
  const [isEligibleViewport, setIsEligibleViewport] = useState(() => !mobileOnly || isMobileViewport());

  useEffect(() => {
    if (!mobileOnly || typeof window === "undefined") return;

    const updateEligibility = () => setIsEligibleViewport(isMobileViewport());
    const widthQuery = window.matchMedia("(max-width: 768px)");
    const heightQuery = window.matchMedia("(max-height: 480px)");
    const removeWidthListener = addMediaChangeListener(widthQuery, updateEligibility);
    const removeHeightListener = addMediaChangeListener(heightQuery, updateEligibility);
    const visualViewport = window.visualViewport;

    window.addEventListener("resize", updateEligibility);
    window.addEventListener("orientationchange", updateEligibility);
    visualViewport?.addEventListener("resize", updateEligibility);
    updateEligibility();

    return () => {
      removeWidthListener();
      removeHeightListener();
      window.removeEventListener("resize", updateEligibility);
      window.removeEventListener("orientationchange", updateEligibility);
      visualViewport?.removeEventListener("resize", updateEligibility);
    };
  }, [mobileOnly]);

  useEffect(() => {
    if (!scroller || !isEligibleViewport) return;

    let interactionActive = false;
    let pointerHeld = false;
    /*
    FNXC:BoardNavigation 2026-07-22-20:10:
    iOS/Android fire `pointercancel` when the native scroll pan claims a touch, but the TOUCH
    stream (touchmove/touchend) keeps going. Treating that pointercancel as gesture end either
    orphaned the gesture (early cancel, no movement yet → interactionActive false → the later
    touchend no-ops and the board rests mid-column until the next tap) or armed the idle settle
    while the finger was still down (slow drag with a brief pause hard-jumped/fought the finger,
    worst at the edge columns where rubber-band makes WebKit claim the pan aggressively).
    Track whether a touch sequence is live and ignore pointercancel while it is — touchend is
    the real finger lift. touchcancel remains a genuine gesture cancel.
    */
    let touchSequenceActive = false;
    let gestureStartScrollLeft = scroller.scrollLeft;
    /** Column the viewport rested on when the gesture began — the paging baseline. */
    let gestureStartColumnIndex = 0;
    /*
    FNXC:BoardNavigation 2026-07-22-21:40:
    The commit-one-column paging rule assumes the gesture began AT REST centered on its origin
    column. A re-touch mid-transit (tap-to-stop during momentum, then drag) is not at rest: the
    forced min-one-column progress from a mid-transit origin overrode the user's corrective drag
    and paged past where they dragged. Such gestures settle on the plain nearest column instead —
    the new drag's landing point always wins over the interrupted scroll.
    */
    let gestureStartCentered = true;
    let lastScrollLeft = scroller.scrollLeft;
    let gestureStartClientX: number | null = null;
    let lastClientX: number | null = null;
    let gestureStartClientY: number | null = null;
    let lastClientY: number | null = null;
    /** Locked at finger-up / cancel — never updated by post-lift rubber-band ticks. */
    let lockedDirection = 0;
    let sawHorizontalMovement = false;
    let nativeSnapSuspended = false;
    let priorInlineScrollSnapType = "";
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let capturedPointerId: number | null = null;
    /** Force scrollLeft until the next user touch. */
    let pinnedScrollLeft: number | null = null;
    /** Continues correcting late WebKit compositor writes until the next user interaction. */
    let pinReassertTimer: ReturnType<typeof setTimeout> | null = null;

    const clearIdleTimer = () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
    };

    const clearPinReassertion = () => {
      if (pinReassertTimer !== null) clearTimeout(pinReassertTimer);
      pinReassertTimer = null;
    };

    const restoreNativeSnap = () => {
      if (!nativeSnapSuspended) return;
      scroller.style.scrollSnapType = priorInlineScrollSnapType;
      nativeSnapSuspended = false;
    };

    const suspendNativeSnap = () => {
      if (nativeSnapSuspended) return;
      priorInlineScrollSnapType = scroller.style.scrollSnapType;
      scroller.style.scrollSnapType = "none";
      nativeSnapSuspended = true;
    };

    const releasePointerCapture = () => {
      if (capturedPointerId === null) return;
      try {
        if (scroller.hasPointerCapture?.(capturedPointerId)) {
          scroller.releasePointerCapture(capturedPointerId);
        }
      } catch {
        // already released
      }
      capturedPointerId = null;
    };

    const clearPin = () => {
      clearPinReassertion();
      pinnedScrollLeft = null;
    };

    /**
     * Freeze direction from the whole gesture (net scroll + finger travel).
     * Called once at lift/cancel — not on later scroll ticks.
     */
    const lockDirectionFromGesture = () => {
      const scrollDelta = scroller.scrollLeft - gestureStartScrollLeft;
      const clientDelta =
        gestureStartClientX !== null && lastClientX !== null
          ? gestureStartClientX - lastClientX
          : 0;
      const clientDeltaY =
        gestureStartClientY !== null && lastClientY !== null
          ? gestureStartClientY - lastClientY
          : 0;
      lockedDirection = resolvePanDirection({ scrollDelta, clientDelta, clientDeltaY });
    };

    /*
    FNXC:BoardNavigation 2026-07-22-19:15:
    On phone-class WebKit, `scrollend` can precede a final compositor fling write that has no
    usable `scroll` callback. Two post-jump tasks can both run before that late write, so retain a
    lightweight pin watchdog until the next user interaction. It corrects only a changed value,
    preserving free-scroll while held and CSS proximity rather than making snap mandatory.
    */
    const reassertPinnedScrollLeft = () => {
      pinReassertTimer = setTimeout(() => {
        pinReassertTimer = null;
        if (pinnedScrollLeft === null) return;
        if (scroller.scrollLeft !== pinnedScrollLeft) {
          hardJumpScrollLeft(scroller, pinnedScrollLeft);
        }
        reassertPinnedScrollLeft();
      }, PIN_REASSERT_INTERVAL_MS);
    };

    const applySnapTo = (targetLeft: number) => {
      const target = Math.round(targetLeft);
      pointerHeld = false;
      suspendNativeSnap();
      hardJumpScrollLeft(scroller, target);
      pinnedScrollLeft = target;
      scroller.scrollLeft = target;
      clearPinReassertion();
      reassertPinnedScrollLeft();
    };

    /**
     * FNXC:BoardNavigation 2026-07-22-15:26:
     * Hard-jump to the nearest column center when off-center. Returns true when a snap
     * applied (or already centered); false only when there are no usable snap columns.
     */
    const snapToNearestColumnIfNeeded = (): boolean => {
      const columns = getSnapColumns(scroller);
      if (columns.length < 2) {
        restoreNativeSnap();
        return false;
      }
      const viewportWidth = scroller.clientWidth || scroller.getBoundingClientRect().width;
      if (viewportWidth <= 0) {
        restoreNativeSnap();
        return false;
      }
      if (isColumnCentered(scroller, columns)) {
        restoreNativeSnap();
        return true;
      }
      const targetIndex = nearestColumnIndex(scroller, columns);
      applySnapTo(scrollLeftToCenterColumn(scroller, columns[targetIndex]));
      return true;
    };

    const snapInScrollDirection = () => {
      clearIdleTimer();
      if (!interactionActive) return;
      if (pointerHeld) return;

      const scrollDelta = scroller.scrollLeft - gestureStartScrollLeft;
      const clientDelta =
        gestureStartClientX !== null && lastClientX !== null
          ? gestureStartClientX - lastClientX
          : 0;
      const clientDeltaY =
        gestureStartClientY !== null && lastClientY !== null
          ? gestureStartClientY - lastClientY
          : 0;

      // Prefer direction locked at lift; recompute only if never locked.
      const direction =
        lockedDirection !== 0
          ? lockedDirection
          : resolvePanDirection({ scrollDelta, clientDelta, clientDeltaY });

      // FNXC:BoardNavigation 2026-07-22-21:40: finger travel implies pan only when horizontal dominates.
      const hadPanIntent =
        sawHorizontalMovement ||
        Math.abs(scrollDelta) > CENTER_TOLERANCE_PX ||
        (Math.abs(clientDelta) >= MIN_PAN_CLIENT_PX && Math.abs(clientDelta) > Math.abs(clientDeltaY));

      const startedCentered = gestureStartCentered;
      interactionActive = false;
      sawHorizontalMovement = false;
      lockedDirection = 0;
      gestureStartClientX = null;
      lastClientX = null;
      gestureStartClientY = null;
      lastClientY = null;

      /*
      FNXC:BoardNavigation 2026-07-22-15:26:
      No pan on this settle gesture (tap-to-stop after re-baseline, pure tap): still never
      rest between columns — nearest-center only. Do not reuse a cancelled swipe's direction.
      */
      if (!hadPanIntent) {
        snapToNearestColumnIfNeeded();
        return;
      }

      const columns = getSnapColumns(scroller);
      if (columns.length < 2) {
        restoreNativeSnap();
        return;
      }

      const viewportWidth = scroller.clientWidth || scroller.getBoundingClientRect().width;
      if (viewportWidth <= 0) {
        restoreNativeSnap();
        return;
      }

      /*
      FNXC:BoardNavigation 2026-07-22-18:30:
      A user-driven mobile settle must rest at the integer center of exactly one `.column`,
      never between columns. Keep CSS proximity (not prohibited mandatory snap) and free
      scrolling while held: a locked direction pages in that direction, while an off-center
      zero-direction settle hard-jumps to its nearest center and pins until the next touch.
      */
      if (direction === 0 && isColumnCentered(scroller, columns)) {
        restoreNativeSnap();
        return;
      }

      /*
      FNXC:BoardNavigation 2026-07-22-21:40:
      Commit-one-column paging only applies to gestures that began at rest centered on their
      origin column. A gesture begun mid-transit (tap-to-stop during momentum, then drag)
      settles on the plain nearest column so the new drag's landing point wins over the
      interrupted scroll's pending destination.
      */
      const targetIndex = direction === 0 || !startedCentered
        ? nearestColumnIndex(scroller, columns)
        : resolveSettleTargetIndex(scroller, columns, direction, gestureStartColumnIndex);
      const targetLeft = scrollLeftToCenterColumn(scroller, columns[targetIndex]);
      applySnapTo(targetLeft);
    };

    const armIdleSettle = () => {
      clearIdleTimer();
      idleTimer = setTimeout(snapInScrollDirection, SCROLL_IDLE_SETTLE_MS);
    };

    /*
    FNXC:BoardNavigation 2026-07-22-15:10:
    A second touch during post-lift momentum must cancel the pending directional settle and start a fresh gesture at the current scrollLeft.
    Previously, re-touch while interactionActive only re-captured the pointer and returned early — pointerHeld stayed false, the idle timer kept the original swipe direction, and the board hard-jumped away from where the user tapped to stop.
    */
    const beginInteraction = (event: Event) => {
      if (!isUserInteraction(event)) return;

      if (event.type === "touchstart") touchSequenceActive = true;
      clearPin();

      // Mid-momentum re-touch (or duplicate pointerdown+touchstart): cancel pending snap and re-baseline.
      if (interactionActive) {
        clearIdleTimer();
        lockedDirection = 0;
        sawHorizontalMovement = false;
        gestureStartScrollLeft = scroller.scrollLeft;
        const columns = getSnapColumns(scroller);
        gestureStartColumnIndex = nearestColumnIndex(scroller, columns);
        gestureStartCentered = isColumnCentered(scroller, columns);
        lastScrollLeft = scroller.scrollLeft;
        const point = getClientPoint(event);
        gestureStartClientX = point?.x ?? null;
        lastClientX = point?.x ?? null;
        gestureStartClientY = point?.y ?? null;
        lastClientY = point?.y ?? null;

        if (event.type === "wheel") {
          pointerHeld = false;
          suspendNativeSnap();
          armIdleSettle();
          return;
        }

        pointerHeld = true;
        if (event.type === "pointerdown" && "pointerId" in event) {
          try {
            scroller.setPointerCapture((event as PointerEvent).pointerId);
            capturedPointerId = (event as PointerEvent).pointerId;
          } catch {
            // ignore
          }
        }
        return;
      }

      interactionActive = true;
      sawHorizontalMovement = false;
      lockedDirection = 0;
      gestureStartScrollLeft = scroller.scrollLeft;
      const columns = getSnapColumns(scroller);
      gestureStartColumnIndex = nearestColumnIndex(scroller, columns);
      gestureStartCentered = isColumnCentered(scroller, columns);
      lastScrollLeft = scroller.scrollLeft;
      const point = getClientPoint(event);
      gestureStartClientX = point?.x ?? null;
      lastClientX = point?.x ?? null;
      gestureStartClientY = point?.y ?? null;
      lastClientY = point?.y ?? null;

      if (event.type === "wheel") {
        pointerHeld = false;
        suspendNativeSnap();
        armIdleSettle();
        return;
      }

      pointerHeld = true;
      if (event.type === "pointerdown" && "pointerId" in event) {
        try {
          scroller.setPointerCapture((event as PointerEvent).pointerId);
          capturedPointerId = (event as PointerEvent).pointerId;
        } catch {
          // ignore
        }
      }
    };

    const markMoved = () => {
      if (!sawHorizontalMovement) {
        suspendNativeSnap();
      }
      sawHorizontalMovement = true;
    };

    const handlePointerMove = (event: Event) => {
      if (!interactionActive || pinnedScrollLeft !== null) return;
      const point = getClientPoint(event);
      if (point === null) return;
      lastClientX = point.x;
      lastClientY = point.y;
      // FNXC:BoardNavigation 2026-07-22-21:40: only dominant-horizontal travel is a board pan.
      const dx = gestureStartClientX !== null ? Math.abs(gestureStartClientX - point.x) : 0;
      const dy = gestureStartClientY !== null ? Math.abs(gestureStartClientY - point.y) : 0;
      if (dx >= MIN_PAN_CLIENT_PX && dx > dy) {
        markMoved();
      }
    };

    const handleScroll = () => {
      if (pinnedScrollLeft !== null) {
        scroller.scrollLeft = pinnedScrollLeft;
        return;
      }
      if (!interactionActive) return;
      const current = scroller.scrollLeft;
      if (current === lastScrollLeft) return;
      lastScrollLeft = current;
      markMoved();

      // While finger is down: free-scroll only. After lift: re-arm idle (momentum).
      if (pointerHeld) return;
      armIdleSettle();
    };

    const handleFingerLift = (event: Event) => {
      // Clear before any early return so a stale flag can't outlive the touch sequence.
      if (event.type === "touchend") touchSequenceActive = false;
      if (!interactionActive || pinnedScrollLeft !== null) return;
      if ("isPrimary" in event && (event as PointerEvent).isPrimary === false) return;

      pointerHeld = false;
      releasePointerCapture();
      // FNXC:BoardNavigation 2026-07-22-18:00: Lock direction now from net gesture only.
      lockDirectionFromGesture();

      if (!sawHorizontalMovement && lockedDirection === 0) {
        clearIdleTimer();
        snapInScrollDirection();
        return;
      }
      armIdleSettle();
    };

    const handleGestureCancel = (event: Event) => {
      if (event.type === "touchcancel") {
        touchSequenceActive = false;
      } else if (touchSequenceActive) {
        /*
        FNXC:BoardNavigation 2026-07-22-20:10:
        pointercancel from native scroll takeover while the finger is still down: the gesture
        continues on the touch stream. Only drop the (now dead) pointer capture; touchend or
        touchcancel will end the gesture.
        */
        releasePointerCapture();
        return;
      }
      if (!interactionActive || pinnedScrollLeft !== null) return;
      pointerHeld = false;
      releasePointerCapture();
      lockDirectionFromGesture();
      if (sawHorizontalMovement || lockedDirection !== 0) {
        armIdleSettle();
      } else {
        // FNXC:BoardNavigation 2026-07-22-15:26: Cancelled zero-pan touch must not leave mid-column.
        interactionActive = false;
        snapToNearestColumnIfNeeded();
      }
    };

    const handleScrollEnd = () => {
      if (pinnedScrollLeft !== null) {
        scroller.scrollLeft = pinnedScrollLeft;
        return;
      }
      if (pointerHeld) return;
      if (!interactionActive) return;
      snapInScrollDirection();
    };

    scroller.addEventListener("pointerdown", beginInteraction);
    scroller.addEventListener("touchstart", beginInteraction, { passive: true });
    scroller.addEventListener("wheel", beginInteraction, { passive: true });
    scroller.addEventListener("pointermove", handlePointerMove, { passive: true });
    scroller.addEventListener("touchmove", handlePointerMove, { passive: true });
    scroller.addEventListener("scroll", handleScroll, { passive: true });
    scroller.addEventListener("scrollend", handleScrollEnd);
    scroller.addEventListener("pointerup", handleFingerLift);
    scroller.addEventListener("touchend", handleFingerLift);
    scroller.addEventListener("pointercancel", handleGestureCancel);
    scroller.addEventListener("touchcancel", handleGestureCancel);

    return () => {
      clearIdleTimer();
      clearPin();
      releasePointerCapture();
      restoreNativeSnap();
      scroller.removeEventListener("pointerdown", beginInteraction);
      scroller.removeEventListener("touchstart", beginInteraction);
      scroller.removeEventListener("wheel", beginInteraction);
      scroller.removeEventListener("pointermove", handlePointerMove);
      scroller.removeEventListener("touchmove", handlePointerMove);
      scroller.removeEventListener("scroll", handleScroll);
      scroller.removeEventListener("scrollend", handleScrollEnd);
      scroller.removeEventListener("pointerup", handleFingerLift);
      scroller.removeEventListener("touchend", handleFingerLift);
      scroller.removeEventListener("pointercancel", handleGestureCancel);
      scroller.removeEventListener("touchcancel", handleGestureCancel);
    };
  }, [isEligibleViewport, isUserInteraction, scroller]);
}
