import { useEffect, useState } from "react";

/** Whether the current device is likely mobile (touch-primary, small viewport). */
function isMobileDevice(): boolean {
  if (typeof window === "undefined") return false;
  const hasTouchScreen =
    "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const isNarrow = window.innerWidth <= 768;
  return hasTouchScreen && isNarrow;
}

/** Cached initial viewport height before any keyboard opened. */
let _initialViewportHeight: number | null = null;

/** Returns the viewport height at page load (before any keyboard opens). */
function getInitialViewportHeight(): number {
  if (_initialViewportHeight === null) {
    _initialViewportHeight = window.innerHeight;
  }
  return _initialViewportHeight;
}

/**
 * Compute how many CSS pixels the virtual keyboard covers from the bottom
 * of the layout viewport. Returns 0 on desktop or when visualViewport is
 * unavailable.
 *
 * Strategy:
 * - Primary: window.innerHeight - vv.offsetTop - vv.height
 *   Works on Chrome Android where window.innerHeight stays at full height.
 * - Fallback: initial viewport height - vv.height - vv.offsetTop
 *   Works on iOS Safari where window.innerHeight shrinks with the keyboard.
 */
function getKeyboardOverlap(): number {
  if (typeof window === "undefined" || !window.visualViewport) return 0;
  const vv = window.visualViewport;
  const chromeOverlap = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
  if (chromeOverlap > 0) return chromeOverlap;

  const initialHeight = getInitialViewportHeight();
  const gap = initialHeight - vv.offsetTop - vv.height;
  return gap >= 30 && gap > 80 ? gap : 0;
}

/** Reset cached initial viewport height. Exported for tests only. */
export function _resetInitialViewportHeight(): void {
  _initialViewportHeight = null;
}

interface UseMobileKeyboardOptions {
  enabled?: boolean;
}

export function useMobileKeyboard(
  { enabled = true }: UseMobileKeyboardOptions = {},
): { keyboardOverlap: number; viewportHeight: number | null } {
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled || !isMobileDevice()) {
      setKeyboardOverlap(0);
      setViewportHeight(null);
      return;
    }

    const vv = window.visualViewport;
    if (!vv) {
      setKeyboardOverlap(0);
      setViewportHeight(null);
      return;
    }

    const update = () => {
      const overlap = getKeyboardOverlap();
      setKeyboardOverlap(overlap);
      setViewportHeight(overlap > 0 ? vv.height : null);
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      setKeyboardOverlap(0);
      setViewportHeight(null);
    };
  }, [enabled]);

  return { keyboardOverlap, viewportHeight };
}
