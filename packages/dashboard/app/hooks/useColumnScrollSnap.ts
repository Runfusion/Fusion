import { useEffect, useState } from "react";
import { isMobileViewport } from "./useViewportMode";

const SCROLL_IDLE_DELAY_MS = 120;
const SNAP_RELEASE_DELAY_MS = 300;
const CENTER_TOLERANCE_PX = 1;

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

/**
 * Adds a mobile-only, user-driven scroll-end snap to a horizontal column scroller.
 *
 * FNXC:BoardNavigation 2026-07-15-13:30:
 * Mobile Kanban swipes must settle on one column, but CSS `scroll-snap-type: x mandatory`
 * regressed FN-001 by snapping against stale iOS layout metrics. Preserve proximity CSS and
 * snap only after verified user horizontal movement has ended; mount, reflow, resize, pageshow,
 * and programmatic scrolling must never choose a board column.
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
    let interactionScrollLeft = scroller.scrollLeft;
    let sawHorizontalMovement = false;
    let isSnapping = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let snapReleaseTimer: ReturnType<typeof setTimeout> | null = null;

    const clearIdleTimer = () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
    };

    const releaseSnap = () => {
      if (snapReleaseTimer !== null) clearTimeout(snapReleaseTimer);
      snapReleaseTimer = setTimeout(() => {
        isSnapping = false;
        snapReleaseTimer = null;
      }, SNAP_RELEASE_DELAY_MS);
    };

    const snapToNearestColumn = () => {
      clearIdleTimer();
      if (!interactionActive || !sawHorizontalMovement || isSnapping) return;
      interactionActive = false;
      sawHorizontalMovement = false;

      const columns = Array.from(scroller.children) as HTMLElement[];
      if (columns.length < 2) return;

      const scrollerRect = scroller.getBoundingClientRect();
      const viewportWidth = scroller.clientWidth || scrollerRect.width;
      if (viewportWidth <= 0) return;

      const viewportCenter = scrollerRect.left + viewportWidth / 2;
      let nearestColumn: HTMLElement | null = null;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const column of columns) {
        const rect = column.getBoundingClientRect();
        const distance = Math.abs(rect.left + rect.width / 2 - viewportCenter);
        if (distance < nearestDistance) {
          nearestColumn = column;
          nearestDistance = distance;
        }
      }
      if (!nearestColumn || nearestDistance <= CENTER_TOLERANCE_PX) return;

      const columnRect = nearestColumn.getBoundingClientRect();
      const targetLeft = scroller.scrollLeft + columnRect.left + columnRect.width / 2 - viewportCenter;
      isSnapping = true;
      if (typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ left: targetLeft, behavior: "smooth" });
      } else {
        scroller.scrollLeft = targetLeft;
      }
      releaseSnap();
    };

    const beginInteraction = (event: Event) => {
      if (isSnapping || !isUserInteraction(event)) return;
      interactionActive = true;
      sawHorizontalMovement = false;
      interactionScrollLeft = scroller.scrollLeft;
    };

    const handleScroll = () => {
      if (isSnapping || !interactionActive) return;
      if (scroller.scrollLeft === interactionScrollLeft) return;
      sawHorizontalMovement = true;
      interactionScrollLeft = scroller.scrollLeft;
      clearIdleTimer();
      idleTimer = setTimeout(snapToNearestColumn, SCROLL_IDLE_DELAY_MS);
    };

    const handleInteractionEnd = () => {
      if (!interactionActive || !sawHorizontalMovement || isSnapping) return;
      clearIdleTimer();
      idleTimer = setTimeout(snapToNearestColumn, SCROLL_IDLE_DELAY_MS);
    };

    const handleScrollEnd = () => {
      if (isSnapping) {
        isSnapping = false;
        if (snapReleaseTimer !== null) clearTimeout(snapReleaseTimer);
        snapReleaseTimer = null;
        return;
      }
      snapToNearestColumn();
    };

    scroller.addEventListener("pointerdown", beginInteraction);
    scroller.addEventListener("touchstart", beginInteraction);
    scroller.addEventListener("wheel", beginInteraction, { passive: true });
    scroller.addEventListener("scroll", handleScroll, { passive: true });
    scroller.addEventListener("scrollend", handleScrollEnd);
    scroller.addEventListener("pointerup", handleInteractionEnd);
    scroller.addEventListener("touchend", handleInteractionEnd);

    return () => {
      clearIdleTimer();
      if (snapReleaseTimer !== null) clearTimeout(snapReleaseTimer);
      scroller.removeEventListener("pointerdown", beginInteraction);
      scroller.removeEventListener("touchstart", beginInteraction);
      scroller.removeEventListener("wheel", beginInteraction);
      scroller.removeEventListener("scroll", handleScroll);
      scroller.removeEventListener("scrollend", handleScrollEnd);
      scroller.removeEventListener("pointerup", handleInteractionEnd);
      scroller.removeEventListener("touchend", handleInteractionEnd);
    };
  }, [isEligibleViewport, isUserInteraction, scroller]);
}
