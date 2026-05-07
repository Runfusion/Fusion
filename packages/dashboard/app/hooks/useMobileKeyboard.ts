import { useEffect, useState } from "react";

const IOS_FALLBACK_MIN_GAP_PX = 30;
const IOS_FALLBACK_MIN_FOCUSED_GAP_PX = 16;
const IOS_VIEWPORT_SHRINK_MIN_PX = 16;

/** Whether the current device is likely mobile (touch-primary, small viewport). */
function isMobileDevice(): boolean {
  if (typeof window === "undefined") return false;
  const hasTouchScreen =
    "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const isNarrow = window.innerWidth <= 768;
  return hasTouchScreen && isNarrow;
}

/**
 * Baseline viewport height captured while keyboard is likely closed.
 * Kept as max-observed value to recover if first sample was keyboard-open.
 */
let _baselineViewportHeight: number | null = null;

function getBaselineViewportHeight(): number {
  if (_baselineViewportHeight === null) {
    _baselineViewportHeight = window.visualViewport?.height ?? window.innerHeight;
  }
  return _baselineViewportHeight;
}

function updateBaselineViewportHeight(nextHeight: number): void {
  const current = getBaselineViewportHeight();
  if (nextHeight > current) {
    _baselineViewportHeight = nextHeight;
  }
}

function isKeyboardFocusableElement(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    const nonTextTypes = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "hidden"]);
    return !nonTextTypes.has(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

interface KeyboardMetrics {
  overlap: number;
  open: boolean;
  vvHeight: number | null;
  vvOffsetTop: number;
}

function getKeyboardMetrics(): KeyboardMetrics {
  if (typeof window === "undefined" || !window.visualViewport) {
    return { overlap: 0, open: false, vvHeight: null, vvOffsetTop: 0 };
  }

  const vv = window.visualViewport;
  const focused = isKeyboardFocusableElement(document.activeElement);
  const offsetTop = vv.offsetTop;

  // Only refresh baseline while keyboard is likely closed.
  if (!focused) {
    updateBaselineViewportHeight(vv.height);
  }

  // Android/Chrome style overlap. Only treat as open while an input is
  // actually focused — without this, the (often slow) visualViewport
  // dismissal animation keeps reporting overlap > 0 for hundreds of ms
  // after the user has tapped Done, which leaves App-level layout (mobile
  // nav bar visibility, project-content padding) stuck in keyboard-up
  // mode and makes downstream components (ChatView) jump on settle.
  const chromeOverlap = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
  if (chromeOverlap > 0 && focused) {
    return { overlap: chromeOverlap, open: true, vvHeight: vv.height, vvOffsetTop: offsetTop };
  }

  // iOS fallback (window.innerHeight shrinks with keyboard). Same focused
  // requirement as above — the dismissal animation otherwise leaves the
  // gap > the open-threshold for the duration of the slide.
  const baselineHeight = getBaselineViewportHeight();
  const gap = Math.max(0, baselineHeight - vv.offsetTop - vv.height);

  if (gap >= IOS_FALLBACK_MIN_GAP_PX && focused) {
    return { overlap: gap, open: true, vvHeight: vv.height, vvOffsetTop: offsetTop };
  }

  if (gap >= IOS_FALLBACK_MIN_FOCUSED_GAP_PX && focused) {
    return { overlap: gap, open: true, vvHeight: vv.height, vvOffsetTop: offsetTop };
  }

  // Last-resort signal: focused input + meaningful viewport shrink.
  const viewportShrink = Math.max(0, baselineHeight - vv.height);
  if (focused && viewportShrink >= IOS_VIEWPORT_SHRINK_MIN_PX) {
    return { overlap: 0, open: true, vvHeight: vv.height, vvOffsetTop: offsetTop };
  }

  return { overlap: 0, open: false, vvHeight: null, vvOffsetTop: 0 };
}

/** Reset cached viewport baseline. Exported for tests only. */
export function _resetInitialViewportHeight(): void {
  _baselineViewportHeight = null;
}

interface UseMobileKeyboardOptions {
  enabled?: boolean;
}

export function useMobileKeyboard(
  { enabled = true }: UseMobileKeyboardOptions = {},
): { keyboardOverlap: number; viewportHeight: number | null; viewportOffsetTop: number; keyboardOpen: boolean } {
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [viewportOffsetTop, setViewportOffsetTop] = useState(0);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    if (!enabled || !isMobileDevice()) {
      setKeyboardOverlap(0);
      setViewportHeight(null);
      setViewportOffsetTop(0);
      setKeyboardOpen(false);
      return;
    }

    const vv = window.visualViewport;
    if (!vv) {
      setKeyboardOverlap(0);
      setViewportHeight(null);
      setViewportOffsetTop(0);
      setKeyboardOpen(false);
      return;
    }

    // Full update for resize + focus transitions (real keyboard
    // open/close events).
    const update = () => {
      const metrics = getKeyboardMetrics();
      setKeyboardOverlap(metrics.overlap);
      setViewportHeight(metrics.vvHeight);
      setViewportOffsetTop(metrics.vvOffsetTop);
      setKeyboardOpen(metrics.open);
    };

    // Scroll-only update: visualViewport.scroll fires at 60fps during
    // an iOS pan with the keyboard up. Routing offsetTop through React
    // state on every event amplifies the pan into a visible judder via
    // the .chat-thread translateY(--vv-offset-top) transform. We skip
    // offsetTop here; it stays pinned to whatever resize/focus last
    // captured. Other metrics still update so a true viewport shrink
    // is reflected.
    const updateScrollOnly = () => {
      const metrics = getKeyboardMetrics();
      setKeyboardOverlap(metrics.overlap);
      setViewportHeight(metrics.vvHeight);
      setKeyboardOpen(metrics.open);
    };

    const timeoutIds: number[] = [];

    const scheduleUpdate = (delayMs: number) => {
      if (typeof window === "undefined") return;
      const timeoutId = window.setTimeout(() => {
        if (typeof window === "undefined") return;
        update();
      }, delayMs);
      timeoutIds.push(timeoutId);
    };

    // Re-snapshot once iOS has settled. focusin/page-restore frequently
    // fire while the visualViewport is still mid-transition; the
    // synchronous read captures stale offsetTop and the chat-thread
    // anchors wrong. We combine two strategies:
    //   1. A short tail of timed updates (50/200/500/1000/1500 ms) for
    //      cases where settlement is on a fixed schedule.
    //   2. A rAF poll that stops once offsetTop is stable across two
    //      frames, capped at 1.5s. Catches slow / variable settles
    //      (e.g. switching tabs back with the keyboard up) where the
    //      timed reads miss the right window.
    let rafId: number | null = null;
    let pollDeadline = 0;
    let lastOffsetTop = -1;
    let stableFrames = 0;
    const cancelPoll = () => {
      if (rafId !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
    const pollFrame = () => {
      if (typeof window === "undefined") return;
      update();
      const currentOffsetTop = window.visualViewport?.offsetTop ?? 0;
      if (currentOffsetTop === lastOffsetTop) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
        lastOffsetTop = currentOffsetTop;
      }
      if (stableFrames >= 2 || performance.now() > pollDeadline) {
        rafId = null;
        return;
      }
      rafId = window.requestAnimationFrame(pollFrame);
    };
    const startStabilityPoll = () => {
      if (typeof window === "undefined") return;
      cancelPoll();
      pollDeadline = performance.now() + 1500;
      lastOffsetTop = -1;
      stableFrames = 0;
      rafId = window.requestAnimationFrame(pollFrame);
    };
    const updateWithTail = () => {
      update();
      scheduleUpdate(50);
      scheduleUpdate(200);
      scheduleUpdate(500);
      scheduleUpdate(1000);
      scheduleUpdate(1500);
      startStabilityPoll();
    };

    updateWithTail();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", updateScrollOnly);
    document.addEventListener("focusin", updateWithTail);
    document.addEventListener("focusout", update);
    // When the user navigates back to this view, force a fresh snapshot
    // — without it the hook initializes with stale metrics (keyboard up
    // from before, but our state thinks it's closed).
    document.addEventListener("visibilitychange", updateWithTail);
    window.addEventListener("pageshow", updateWithTail);

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", updateScrollOnly);
      document.removeEventListener("focusin", updateWithTail);
      document.removeEventListener("focusout", update);
      document.removeEventListener("visibilitychange", updateWithTail);
      window.removeEventListener("pageshow", updateWithTail);
      for (const timeoutId of timeoutIds) {
        clearTimeout(timeoutId);
      }
      cancelPoll();
      setKeyboardOverlap(0);
      setViewportHeight(null);
      setViewportOffsetTop(0);
      setKeyboardOpen(false);
    };
  }, [enabled]);

  return { keyboardOverlap, viewportHeight, viewportOffsetTop, keyboardOpen };
}
