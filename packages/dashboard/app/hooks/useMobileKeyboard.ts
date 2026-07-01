import { useEffect, useRef, useState } from "react";

const IOS_FALLBACK_MIN_GAP_PX = 30;
const IOS_FALLBACK_MIN_FOCUSED_GAP_PX = 16;
const IOS_VIEWPORT_SHRINK_MIN_PX = 16;
const IMPOSSIBLE_VIEWPORT_EPSILON_PX = 2;
const SETTLED_FOLDED_VIEWPORT_MIN_HEIGHT_PX = 480;

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
let _baselineViewportWidth: number | null = null;

function getCurrentViewportWidth(): number {
  return window.visualViewport?.width && window.visualViewport.width > 0
    ? window.visualViewport.width
    : window.innerWidth;
}

function setBaselineViewport(height: number, width: number): void {
  _baselineViewportHeight = height;
  _baselineViewportWidth = width;
}

function getBaselineViewportHeight(): number {
  if (_baselineViewportHeight === null) {
    setBaselineViewport(window.visualViewport?.height ?? window.innerHeight, getCurrentViewportWidth());
  }
  return _baselineViewportHeight ?? (window.visualViewport?.height ?? window.innerHeight);
}

function updateBaselineViewportHeight(nextHeight: number, nextWidth: number): void {
  const current = getBaselineViewportHeight();
  const widthChanged = _baselineViewportWidth !== null && Math.abs(nextWidth - _baselineViewportWidth) >= 1;
  /*
  FNXC:Terminal 2026-06-30-08:51:
  SessionTerminal shares the folded-phone root cause: a keyboard-closed width/posture settle can be shorter than the previous unfolded baseline, so max-only baselines overestimate later iOS keyboard overlap and lift/refit the embedded terminal against stale geometry. Replace the baseline on settled folded posture changes while preserving the max-observed recovery for same-posture keyboard-open first samples.
  */
  if (nextHeight > current || (widthChanged && nextHeight >= SETTLED_FOLDED_VIEWPORT_MIN_HEIGHT_PX)) {
    setBaselineViewport(nextHeight, nextWidth);
  }
}

function resetBaselineViewportHeight(): void {
  _baselineViewportHeight = null;
  _baselineViewportWidth = null;
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

const CLOSED_KEYBOARD_METRICS: KeyboardMetrics = {
  overlap: 0,
  open: false,
  vvHeight: null,
  vvOffsetTop: 0,
};

function hasImpossibleViewportSample(): boolean {
  if (typeof window === "undefined" || !window.visualViewport) {
    return false;
  }

  return window.visualViewport.offsetTop + window.visualViewport.height > window.innerHeight + IMPOSSIBLE_VIEWPORT_EPSILON_PX;
}

function isCollapsedRestoreViewportSample(baselineHeight: number): boolean {
  if (typeof window === "undefined" || !window.visualViewport) {
    return false;
  }

  return window.visualViewport.height >= baselineHeight - IOS_VIEWPORT_SHRINK_MIN_PX;
}

function getKeyboardMetrics(
  previousMetrics: KeyboardMetrics = CLOSED_KEYBOARD_METRICS,
  { bypassImpossibleSampleHold = false }: { bypassImpossibleSampleHold?: boolean } = {},
): KeyboardMetrics {
  if (typeof window === "undefined" || !window.visualViewport) {
    return CLOSED_KEYBOARD_METRICS;
  }

  const vv = window.visualViewport;
  const focused = isKeyboardFocusableElement(document.activeElement);
  const offsetTop = vv.offsetTop;

  // Pinch-zoom also shrinks vv.height — distinguish from keyboard by
  // checking vv.scale. Android Chrome ignores user-scalable=no for a11y,
  // so a user can be zoomed in with a focused textarea, which otherwise
  // makes (innerHeight - vv.height) huge and false-positives "keyboard open"
  // → MobileNavBar disappears.
  if (vv.scale > 1.01) {
    return CLOSED_KEYBOARD_METRICS;
  }

  // Only refresh baseline while keyboard is likely closed.
  if (!focused) {
    updateBaselineViewportHeight(vv.height, getCurrentViewportWidth());
  }

  // FN-5155: iOS focus/restore can briefly report offsetTop from the keyboard
  // transition while height is still near the pre-keyboard baseline. Reject
  // that impossible snapshot and keep the last stable metrics until settle.
  if (focused && hasImpossibleViewportSample() && !bypassImpossibleSampleHold) {
    return previousMetrics;
  }

  // Android/Chrome style overlap. Only treat as open while an input is
  // actually focused — without this, the (often slow) visualViewport
  // dismissal animation keeps reporting overlap > 0 for hundreds of ms
  // after the user has tapped Done, which leaves App-level layout (mobile
  // nav bar visibility, project-content padding) stuck in keyboard-up
  // mode and makes downstream components (ChatView) jump on settle.
  //
  // Prefer documentElement.clientHeight over window.innerHeight: Android
  // Chrome can report a stale innerHeight (multi-window / shrink-to-fit
  // edge cases — observed innerHeight=2848 while html.clientHeight=797),
  // which makes the overlap calc explode and false-positives keyboard-open
  // whenever a textarea has focus.
  const layoutHeight = document.documentElement?.clientHeight || window.innerHeight;
  const chromeOverlap = Math.max(0, layoutHeight - vv.offsetTop - vv.height);
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

  return CLOSED_KEYBOARD_METRICS;
}

/** Reset cached viewport baseline. Exported for tests only. */
export function _resetInitialViewportHeight(): void {
  resetBaselineViewportHeight();
}

interface UseMobileKeyboardOptions {
  enabled?: boolean;
  allowNonMobileViewport?: boolean;
}

export function useMobileKeyboard(
  { enabled = true, allowNonMobileViewport = false }: UseMobileKeyboardOptions = {},
): { keyboardOverlap: number; viewportHeight: number | null; viewportOffsetTop: number; keyboardOpen: boolean } {
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [viewportOffsetTop, setViewportOffsetTop] = useState(0);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const stableMetricsRef = useRef<KeyboardMetrics>(CLOSED_KEYBOARD_METRICS);

  useEffect(() => {
    if (!enabled || (!allowNonMobileViewport && !isMobileDevice())) {
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
      stableMetricsRef.current = CLOSED_KEYBOARD_METRICS;
      return;
    }

    const commitMetrics = (metrics: KeyboardMetrics) => {
      stableMetricsRef.current = metrics;
      setKeyboardOverlap(metrics.overlap);
      setViewportHeight(metrics.vvHeight);
      setViewportOffsetTop(metrics.vvOffsetTop);
      setKeyboardOpen(metrics.open);
    };

    // Full update — used on resize and focus transitions. These are the
    // events that signal an actual keyboard open/close, so we want to
    // re-snapshot offsetTop/height/overlap.
    const update = () => {
      commitMetrics(getKeyboardMetrics(stableMetricsRef.current));
    };

    // Scroll-only update — fires on every visualViewport pan (60fps on
    // iOS during a swipe with the keyboard up). Updating offsetTop on
    // each event amplifies jitter into the .chat-thread transform that
    // tracks --vv-offset-top, visibly judders the thread, and can shift
    // it hundreds of px. We deliberately skip offsetTop here and only
    // update height/keyboardOpen if those changed; offsetTop stays
    // pinned to whatever resize/focus last set it.
    const updateScrollOnly = () => {
      const metrics = getKeyboardMetrics(stableMetricsRef.current);
      stableMetricsRef.current = metrics;
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
    let headRafId: number | null = null;
    let pollDeadline = 0;
    let lastOffsetTop = -1;
    let stableFrames = 0;
    const cancelHeadUpdate = () => {
      if (headRafId !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(headRafId);
        headRafId = null;
      }
    };
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
    const scheduleTailUpdates = () => {
      scheduleUpdate(50);
      scheduleUpdate(200);
      scheduleUpdate(500);
      scheduleUpdate(1000);
      scheduleUpdate(1500);
      startStabilityPoll();
    };

    const updateWithTail = () => {
      cancelHeadUpdate();
      if (isKeyboardFocusableElement(document.activeElement) && hasImpossibleViewportSample()) {
        // FN-5155: focusin can arrive before visualViewport height catches up
        // to the keyboard transition. Defer the head commit one frame so the
        // tail/poll can converge instead of publishing the stale sample.
        headRafId = window.requestAnimationFrame(() => {
          headRafId = null;
          update();
        });
      } else {
        update();
      }
      scheduleTailUpdates();
    };

    const resetOnRestore = () => {
      cancelHeadUpdate();
      const baselineHeight = getBaselineViewportHeight();
      const collapsedRestoreSample = isCollapsedRestoreViewportSample(baselineHeight);
      if (collapsedRestoreSample) {
        resetBaselineViewportHeight();
      }
      commitMetrics(getKeyboardMetrics(stableMetricsRef.current, {
        bypassImpossibleSampleHold: collapsedRestoreSample,
      }));
      scheduleTailUpdates();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      resetOnRestore();
    };

    updateWithTail();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", updateScrollOnly);
    document.addEventListener("focusin", updateWithTail);
    document.addEventListener("focusout", update);
    // When the user navigates back to this view, force a fresh snapshot that
    // can bypass the stale impossible-sample hold if the viewport has already
    // returned to its closed baseline while the input retained focus.
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", resetOnRestore);

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", updateScrollOnly);
      document.removeEventListener("focusin", updateWithTail);
      document.removeEventListener("focusout", update);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", resetOnRestore);
      for (const timeoutId of timeoutIds) {
        clearTimeout(timeoutId);
      }
      cancelHeadUpdate();
      cancelPoll();
      stableMetricsRef.current = CLOSED_KEYBOARD_METRICS;
      setKeyboardOverlap(0);
      setViewportHeight(null);
      setViewportOffsetTop(0);
      setKeyboardOpen(false);
    };
  }, [allowNonMobileViewport, enabled]);

  return { keyboardOverlap, viewportHeight, viewportOffsetTop, keyboardOpen };
}
