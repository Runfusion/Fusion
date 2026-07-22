import { useEffect, useState } from "react";
import { isMobileViewport } from "./useViewportMode";

/*
FNXC:BoardNavigation 2026-07-22-18:00:
Wrong-way snaps came from (1) settle direction using the last micro scroll tick — iOS
rubber-band/fling end often reverses for a frame — and (2) origin±nearest hybrid targets.
Direction is locked at finger-up from net gesture delta only (never post-lift ticks). Target
is always the next column in that scroll direction from the current viewport (classic
directional page snap). Pin until next touch; hard-jump kills residual fling.
*/
/** After lift/cancel/wheel: wait for scroll idle (momentum finished) before paging. */
const SCROLL_IDLE_SETTLE_MS = 48;
const CENTER_TOLERANCE_PX = 1;
/** Minimum finger travel to count as a horizontal pan (short swipe still commits). */
const MIN_PAN_CLIENT_PX = 12;

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

function getClientX(event: Event): number | null {
  if (typeof TouchEvent !== "undefined" && event instanceof TouchEvent) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return touch ? touch.clientX : null;
  }
  if ("clientX" in event && typeof (event as PointerEvent).clientX === "number") {
    return (event as PointerEvent).clientX;
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
 */
export function resolvePanDirection(options: {
  scrollDelta: number;
  /** gestureStartClientX - endClientX: finger left → positive → next column */
  clientDelta: number;
}): number {
  const { scrollDelta, clientDelta } = options;
  if (scrollDelta > CENTER_TOLERANCE_PX) return 1;
  if (scrollDelta < -CENTER_TOLERANCE_PX) return -1;
  if (clientDelta >= MIN_PAN_CLIENT_PX) return 1;
  if (clientDelta <= -MIN_PAN_CLIENT_PX) return -1;
  return 0;
}

/**
 * Pick the column to land on given locked scroll direction and current viewport.
 * Always in the scroll direction — never the opposite column.
 *
 * Moving right (dir +1): if still approaching nearest from the left, land on nearest;
 * otherwise land on nearest+1 (the next column on the right).
 * Moving left (dir -1): mirror.
 */
export function resolveTargetIndexInScrollDirection(
  scroller: HTMLElement,
  columns: HTMLElement[],
  direction: number,
): number {
  if (columns.length <= 1) return 0;
  const nearest = nearestColumnIndex(scroller, columns);
  if (direction === 0) return nearest;

  const scrollerRect = scroller.getBoundingClientRect();
  const viewportWidth = scroller.clientWidth || scrollerRect.width;
  const viewportCenter = scrollerRect.left + viewportWidth / 2;
  const nearestRect = columns[nearest].getBoundingClientRect();
  const nearestCenter = nearestRect.left + nearestRect.width / 2;

  if (direction > 0) {
    // Content scrolling right: next column on the right of travel.
    if (viewportCenter + CENTER_TOLERANCE_PX < nearestCenter) {
      return nearest;
    }
    return Math.min(columns.length - 1, nearest + 1);
  }

  // Content scrolling left: next column on the left of travel.
  if (viewportCenter - CENTER_TOLERANCE_PX > nearestCenter) {
    return nearest;
  }
  return Math.max(0, nearest - 1);
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
 * Lock settle direction at finger-up from net gesture deltas. Target via
 * resolveTargetIndexInScrollDirection so snap never goes against scroll. Pin until next touch.
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
    let gestureStartScrollLeft = scroller.scrollLeft;
    let lastScrollLeft = scroller.scrollLeft;
    let gestureStartClientX: number | null = null;
    let lastClientX: number | null = null;
    /** Locked at finger-up / cancel — never updated by post-lift rubber-band ticks. */
    let lockedDirection = 0;
    let sawHorizontalMovement = false;
    let nativeSnapSuspended = false;
    let priorInlineScrollSnapType = "";
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let capturedPointerId: number | null = null;
    /** Force scrollLeft until the next user touch. */
    let pinnedScrollLeft: number | null = null;

    const clearIdleTimer = () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
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
      lockedDirection = resolvePanDirection({ scrollDelta, clientDelta });
    };

    const applySnapTo = (targetLeft: number) => {
      const target = Math.round(targetLeft);
      pointerHeld = false;
      suspendNativeSnap();
      hardJumpScrollLeft(scroller, target);
      pinnedScrollLeft = target;
      scroller.scrollLeft = target;
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

      // Prefer direction locked at lift; recompute only if never locked.
      const direction =
        lockedDirection !== 0
          ? lockedDirection
          : resolvePanDirection({ scrollDelta, clientDelta });

      const hadPanIntent =
        sawHorizontalMovement ||
        Math.abs(scrollDelta) > CENTER_TOLERANCE_PX ||
        Math.abs(clientDelta) >= MIN_PAN_CLIENT_PX;

      interactionActive = false;
      sawHorizontalMovement = false;
      lockedDirection = 0;
      gestureStartClientX = null;
      lastClientX = null;

      if (!hadPanIntent) {
        restoreNativeSnap();
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

      const targetIndex = direction === 0
        ? nearestColumnIndex(scroller, columns)
        : resolveTargetIndexInScrollDirection(scroller, columns, direction);
      const targetLeft = scrollLeftToCenterColumn(scroller, columns[targetIndex]);
      applySnapTo(targetLeft);
    };

    const armIdleSettle = () => {
      clearIdleTimer();
      idleTimer = setTimeout(snapInScrollDirection, SCROLL_IDLE_SETTLE_MS);
    };

    const beginInteraction = (event: Event) => {
      if (!isUserInteraction(event)) return;

      clearPin();

      if (interactionActive) {
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
      lastScrollLeft = scroller.scrollLeft;
      const clientX = getClientX(event);
      gestureStartClientX = clientX;
      lastClientX = clientX;

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
      const clientX = getClientX(event);
      if (clientX === null) return;
      lastClientX = clientX;
      if (
        gestureStartClientX !== null &&
        Math.abs(gestureStartClientX - clientX) >= MIN_PAN_CLIENT_PX
      ) {
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

    const handleGestureCancel = () => {
      if (!interactionActive || pinnedScrollLeft !== null) return;
      pointerHeld = false;
      releasePointerCapture();
      lockDirectionFromGesture();
      if (sawHorizontalMovement || lockedDirection !== 0) {
        armIdleSettle();
      } else {
        interactionActive = false;
        restoreNativeSnap();
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
