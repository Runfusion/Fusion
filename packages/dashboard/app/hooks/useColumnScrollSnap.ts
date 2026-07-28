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
/*
FNXC:BoardNavigation 2026-07-24-10:05:
Board paging must feel fast: the post-momentum quiet window is 2 frames (~32ms), not 3 (~48ms), so
the settle commits sooner after a swipe. Keep it above one frame — a single-frame window can fire
mid-fling and page against travel.
*/
/**
 * Fallback quiet window for settles that cannot page at lift (wheel, net-zero direction).
 * Directional finger swipes no longer wait on it — see `commitDirectionalPage`.
 */
const SCROLL_IDLE_SETTLE_MS = 32;
const CENTER_TOLERANCE_PX = 1;
/** Minimum finger travel to count as a horizontal pan (short swipe still commits). */
const MIN_PAN_CLIENT_PX = 12;
/** Keep a WebKit compositor write from outliving the main-thread hard jump. */
const PIN_REASSERT_INTERVAL_MS = 16;

/*
FNXC:BoardNavigation 2026-07-24-11:20:
Board paging must feel fast, and the slow part was never the settle timer — it was waiting for the
BROWSER's fling to decelerate before paging (native inertia can coast for most of a second, so a
flick sat visibly drifting before it committed). The hook now owns the momentum: at finger-up a
directional swipe kills native inertia and animates to its target column in ~200ms, so the page
starts moving on lift instead of after the coast. Fling reach is preserved by deriving a page COUNT
from release velocity rather than from how far inertia happens to travel.

Trade-off accepted: tap-to-stop-during-momentum no longer exists as an interaction (there is no
long coast left to interrupt). A re-touch during the page animation cancels it and hands control
back to the finger, which covers the same corrective intent.
*/
/** Base duration of the owned page animation (single-column hop). */
const PAGE_ANIMATION_BASE_MS = 190;
/** Added per extra column so multi-column flings do not crawl. */
const PAGE_ANIMATION_PER_EXTRA_PAGE_MS = 45;
const PAGE_ANIMATION_MAX_MS = 300;
/** Only release-adjacent scroll samples describe fling speed. */
const VELOCITY_SAMPLE_WINDOW_MS = 120;
/** px/ms of release velocity that buys one extra column of paging. */
const FLING_VELOCITY_PER_EXTRA_PAGE = 1.6;
/** Ceiling so a hard flick cannot fly across the whole board. */
const MAX_PAGES_PER_SWIPE = 3;
/*
FNXC:BoardNavigation 2026-07-25-09:40:
A SHORT swipe must never cross more than one column, however fast the flick was. Velocity alone
over-reached: a quick thumb flick of ~30px reads as multiple px/ms and paged two or three columns,
so the board jumped past what the user aimed at. Each extra column now also has to be earned with
travel — the gesture must move at least this fraction of the viewport width per extra page — so
reach stays proportional to the swipe the user actually made.
*/
const TRAVEL_FRACTION_PER_EXTRA_PAGE = 0.6;
/** Below this the animation is pointless — jump. */
const MIN_ANIMATED_DISTANCE_PX = 2;

function now(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/** Ease-out cubic: fast departure, soft arrival — reads as "snappy", not "floaty". */
function easeOutCubic(progress: number): number {
  const clamped = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  return 1 - (1 - clamped) ** 3;
}

/**
 * Columns to advance for a release velocity, in px/ms (absolute value).
 *
 * A deliberate slow swipe pages exactly one column; faster releases buy extra columns so the
 * hook's owned animation keeps the reach a native fling used to provide.
 *
 * FNXC:BoardNavigation 2026-07-25-09:40:
 * Extra columns must be earned by BOTH speed and distance. `travelPx` (net gesture travel — the
 * larger of board scroll delta and horizontal finger travel) against `viewportWidth` caps the
 * count, so a fast but short flick pages exactly one column instead of jumping across the board.
 * The travel gate is skipped when the caller cannot supply a usable viewport width.
 */
export function resolvePageCount(
  velocityPxPerMs: number,
  travel?: { travelPx: number; viewportWidth: number },
): number {
  const speed = Math.abs(velocityPxPerMs);
  if (!Number.isFinite(speed) || speed <= 0) return 1;
  const extraFromVelocity = Math.floor(speed / FLING_VELOCITY_PER_EXTRA_PAGE);

  let extra = extraFromVelocity;
  if (travel && Number.isFinite(travel.viewportWidth) && travel.viewportWidth > 0) {
    const travelPx = Math.abs(travel.travelPx);
    const extraFromTravel = Number.isFinite(travelPx)
      ? Math.floor(travelPx / (travel.viewportWidth * TRAVEL_FRACTION_PER_EXTRA_PAGE))
      : 0;
    extra = Math.min(extraFromVelocity, extraFromTravel);
  }

  return Math.min(1 + Math.max(0, extra), MAX_PAGES_PER_SWIPE);
}

/** Duration for a `pageCount`-column hop. */
export function resolvePageAnimationMs(pageCount: number): number {
  const extraPages = Math.max(0, pageCount - 1);
  return Math.min(
    PAGE_ANIMATION_BASE_MS + extraPages * PAGE_ANIMATION_PER_EXTRA_PAGE_MS,
    PAGE_ANIMATION_MAX_MS,
  );
}

/**
 * Target column for an owned directional page.
 *
 * `originIndex` + `direction * pageCount`, clamped to the column range, then clamped forward to
 * `floorIndex` (the column the finger already dragged onto) so a long slow drag never animates
 * backwards to a stale origin-derived target.
 */
export function resolveFlingTargetIndex(options: {
  columnCount: number;
  originIndex: number;
  direction: number;
  pageCount: number;
  /** Nearest column at release; keeps a long drag's own landing point. */
  nearestIndex: number;
}): number {
  const { columnCount, originIndex, direction, pageCount, nearestIndex } = options;
  if (columnCount <= 1) return 0;
  const lastIndex = columnCount - 1;
  const clamp = (value: number) => Math.min(Math.max(value, 0), lastIndex);
  const origin = clamp(originIndex);
  const nearest = clamp(nearestIndex);
  if (direction === 0) return nearest;
  const paged = clamp(origin + direction * Math.max(1, pageCount));
  return direction > 0 ? Math.max(paged, nearest) : Math.min(paged, nearest);
}

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

/*
FNXC:BoardNavigation 2026-07-26-09:15:
A swipe starting on the FAR-LEFT column jumped two columns while the same swipe mid-board moved one.
Cause: columns are narrower than the phone viewport, so the edge columns' ideal centered scrollLeft
falls OUTSIDE the reachable range (negative at the left edge, past max at the right edge). The board
therefore never read as "centered" while resting at an edge, `gestureStartCentered` was false, and
`commitDirectionalPage` fell back to taking its origin at RELEASE — which had already advanced onto
the next column — so the +1 page landed two columns over.
Clamping the centering target to the reachable scroll range makes an edge rest count as centered
(rest position IS the column's reachable center), so edge swipes page exactly one column like every
other position. It also stops `applySnapTo` from pinning an unreachable value, which left the pin
watchdog hard-jumping to a scrollLeft the browser keeps clamping away.
*/
/**
 * scrollLeft that centers `column` in the scroller viewport (integer pixels), clamped to the
 * scroller's reachable range so edge columns resolve to the position they actually rest at.
 *
 * The upper clamp is skipped when `scrollWidth` is unusable (jsdom reports 0); the lower clamp at 0
 * is always valid.
 */
function scrollLeftToCenterColumn(scroller: HTMLElement, column: HTMLElement): number {
  const scrollerRect = scroller.getBoundingClientRect();
  const viewportWidth = scroller.clientWidth || scrollerRect.width;
  const viewportCenter = scrollerRect.left + viewportWidth / 2;
  const columnRect = column.getBoundingClientRect();
  const ideal = Math.round(
    scroller.scrollLeft + columnRect.left + columnRect.width / 2 - viewportCenter,
  );
  const maxScrollLeft = scroller.scrollWidth - viewportWidth;
  const upperBound = maxScrollLeft > 0 ? maxScrollLeft : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(ideal, 0), upperBound);
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
    /*
    FNXC:BoardNavigation 2026-07-24-11:20:
    Release velocity comes from board scrollLeft samples taken while the finger is down, not from
    finger coordinates: on iOS the native pan owns the touch stream, so scroll ticks are the only
    faithful record of how fast the content was actually moving at lift.
    */
    let velocitySampleScrollLeft = scroller.scrollLeft;
    let velocitySampleAt = now();
    let releaseVelocityPxPerMs = 0;
    /** rAF handle for the hook-owned page animation. */
    let pageAnimationFrame: number | null = null;
    /** Inline styles frozen for the duration of the page animation. */
    let animationStyleRestore: (() => void) | null = null;

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
     * Stop the hook-owned page animation and give the axis back to the browser.
     *
     * FNXC:BoardNavigation 2026-07-24-11:20:
     * A re-touch during the animation must hand control straight back to the finger — this is the
     * corrective seam that replaces tap-to-stop-during-momentum.
     */
    const cancelPageAnimation = () => {
      if (pageAnimationFrame !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(pageAnimationFrame);
      }
      pageAnimationFrame = null;
      if (animationStyleRestore) {
        const restore = animationStyleRestore;
        animationStyleRestore = null;
        restore();
      }
    };

    /*
    FNXC:BoardNavigation 2026-07-24-11:20:
    `overflow-x: hidden` stays on for the WHOLE animation, not just the first frame: it is what
    makes the compositor drop the native fling, and a fling left alive fights every per-frame
    scrollLeft write (the board visibly stutters and can land off-center). Programmatic scrollLeft
    still applies while the axis is hidden, so the animation itself is unaffected.
    */
    const freezeScrollerForAnimation = () => {
      if (animationStyleRestore) return;
      const priorOverflowX = scroller.style.overflowX;
      const priorBehavior = scroller.style.scrollBehavior;
      const priorWebkit = scroller.style.getPropertyValue("-webkit-overflow-scrolling");
      scroller.style.scrollBehavior = "auto";
      scroller.style.overflowX = "hidden";
      scroller.style.setProperty("-webkit-overflow-scrolling", "auto");
      animationStyleRestore = () => {
        scroller.style.overflowX = priorOverflowX;
        scroller.style.scrollBehavior = priorBehavior;
        if (priorWebkit) {
          scroller.style.setProperty("-webkit-overflow-scrolling", priorWebkit);
        } else {
          scroller.style.removeProperty("-webkit-overflow-scrolling");
        }
      };
    };

    /**
     * Animate to a column center over `durationMs`, then pin as a normal settle.
     *
     * Falls back to the instant hard jump when motion is reduced, `requestAnimationFrame` is
     * unavailable, or the distance is not worth animating.
     */
    const animateSnapTo = (targetLeft: number, durationMs: number) => {
      const target = Math.round(targetLeft);
      const from = scroller.scrollLeft;
      const distance = target - from;

      pointerHeld = false;
      suspendNativeSnap();
      cancelPageAnimation();

      if (
        Math.abs(distance) < MIN_ANIMATED_DISTANCE_PX ||
        durationMs <= 0 ||
        prefersReducedMotion() ||
        typeof window.requestAnimationFrame !== "function"
      ) {
        applySnapTo(target);
        return;
      }

      freezeScrollerForAnimation();
      const startedAt = now();

      const step = () => {
        pageAnimationFrame = null;
        const elapsed = now() - startedAt;
        const progress = elapsed / durationMs;
        if (progress >= 1) {
          cancelPageAnimation();
          applySnapTo(target);
          return;
        }
        scroller.scrollLeft = Math.round(from + distance * easeOutCubic(progress));
        pageAnimationFrame = window.requestAnimationFrame(step);
      };

      pageAnimationFrame = window.requestAnimationFrame(step);
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

    /**
     * Page immediately at finger-up, animating the board there ourselves.
     *
     * FNXC:BoardNavigation 2026-07-24-11:20:
     * This is the "faster momentum" path: instead of arming the idle settle and waiting out native
     * inertia, a directional lift resolves its target from the ORIGIN column plus a velocity-derived
     * page count and animates there in ~200ms. Reach scales with flick speed, so a hard fling still
     * crosses multiple columns without the long coast.
     */
    const commitDirectionalPage = (direction: number) => {
      clearIdleTimer();

      const columns = getSnapColumns(scroller);
      const viewportWidth = scroller.clientWidth || scroller.getBoundingClientRect().width;
      if (columns.length < 2 || viewportWidth <= 0) {
        interactionActive = false;
        restoreNativeSnap();
        return;
      }

      const nearestIndex = nearestColumnIndex(scroller, columns);
      /*
      FNXC:BoardNavigation 2026-07-26-09:15:
      A gesture begun mid-transit has no trustworthy rest origin, so it pages from where it actually
      is — but that origin must never sit FURTHER ALONG the travel direction than the column the
      gesture started on, or the drag gets counted twice (once as travel, once as a bumped origin)
      and the board advances two columns for a one-column swipe. `resolveFlingTargetIndex` still
      floors the result at `nearestIndex`, so a long drag keeps its own landing point.
      */
      const startIndex = Math.min(Math.max(gestureStartColumnIndex, 0), columns.length - 1);
      const originIndex = gestureStartCentered
        ? gestureStartColumnIndex
        : direction > 0
          ? Math.min(nearestIndex, startIndex)
          : Math.max(nearestIndex, startIndex);
      /*
      FNXC:BoardNavigation 2026-07-25-09:40:
      Net gesture travel gates multi-column reach. Take the larger of the board's own scroll delta
      and the finger's horizontal travel: on iOS the native pan owns the touch stream (scroll delta
      is the faithful signal), while a finger that dragged against a rubber-banding edge shows
      travel only in the client coordinates.
      */
      const scrollTravel = Math.abs(scroller.scrollLeft - gestureStartScrollLeft);
      const fingerTravel =
        gestureStartClientX !== null && lastClientX !== null
          ? Math.abs(gestureStartClientX - lastClientX)
          : 0;
      const pageCount = resolvePageCount(resolveReleaseVelocity(), {
        travelPx: Math.max(scrollTravel, fingerTravel),
        viewportWidth,
      });
      const targetIndex = resolveFlingTargetIndex({
        columnCount: columns.length,
        originIndex,
        direction,
        pageCount,
        nearestIndex,
      });

      interactionActive = false;
      sawHorizontalMovement = false;
      lockedDirection = 0;
      gestureStartClientX = null;
      lastClientX = null;
      gestureStartClientY = null;
      lastClientY = null;
      releaseVelocityPxPerMs = 0;

      animateSnapTo(
        scrollLeftToCenterColumn(scroller, columns[targetIndex]),
        resolvePageAnimationMs(pageCount),
      );
    };

    /** Reset the release-velocity window at the start of every fresh gesture baseline. */
    const resetVelocitySampling = () => {
      velocitySampleScrollLeft = scroller.scrollLeft;
      velocitySampleAt = now();
      releaseVelocityPxPerMs = 0;
    };

    /** Fold one scroll tick into the release-velocity estimate (px/ms, signed). */
    const sampleVelocity = (currentScrollLeft: number) => {
      const at = now();
      const elapsed = at - velocitySampleAt;
      // Synchronous same-instant ticks (and test batches) carry no speed information.
      if (elapsed <= 0) return;
      releaseVelocityPxPerMs = (currentScrollLeft - velocitySampleScrollLeft) / elapsed;
      velocitySampleScrollLeft = currentScrollLeft;
      velocitySampleAt = at;
    };

    /*
    FNXC:BoardNavigation 2026-07-24-11:20:
    A finger that moved fast and then held still before lifting must NOT page like a flick: the last
    sample would still read fast. Velocity older than the sample window counts as a resting finger.
    */
    const resolveReleaseVelocity = (): number =>
      now() - velocitySampleAt > VELOCITY_SAMPLE_WINDOW_MS ? 0 : releaseVelocityPxPerMs;

    /*
    FNXC:BoardNavigation 2026-07-22-15:10:
    A second touch during post-lift momentum must cancel the pending directional settle and start a fresh gesture at the current scrollLeft.
    Previously, re-touch while interactionActive only re-captured the pointer and returned early — pointerHeld stayed false, the idle timer kept the original swipe direction, and the board hard-jumped away from where the user tapped to stop.
    */
    const beginInteraction = (event: Event) => {
      if (!isUserInteraction(event)) return;

      if (event.type === "touchstart") touchSequenceActive = true;
      clearPin();
      /*
      FNXC:BoardNavigation 2026-07-24-11:20:
      A touch landing mid-animation takes the axis back immediately (overflow restored, rAF
      dropped) so the finger drags from wherever the page had reached.
      */
      cancelPageAnimation();
      resetVelocitySampling();

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

      // While finger is down: free-scroll only, sampling speed for the release page count.
      if (pointerHeld) {
        sampleVelocity(current);
        return;
      }
      // Post-lift ticks (residual inertia before our page takes over): keep the fallback armed.
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
      /*
      FNXC:BoardNavigation 2026-07-24-11:20:
      Directional lift pages NOW instead of arming the idle settle — the whole point of owning the
      momentum. Net-zero-direction pans (weak or reversed gestures) still fall through to the idle
      settle, which rests them on the nearest center.
      */
      if (lockedDirection !== 0) {
        commitDirectionalPage(lockedDirection);
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
      if (lockedDirection !== 0) {
        // Genuine cancel with pan intent: page like a lift rather than coasting to an idle settle.
        commitDirectionalPage(lockedDirection);
      } else if (sawHorizontalMovement) {
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
      // Unmount mid-animation must not leave the scroller frozen at `overflow-x: hidden`.
      cancelPageAnimation();
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
