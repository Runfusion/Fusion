/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512: reveal a focused control by scrolling ITS OWN scroller by the minimum amount, never by
moving the page.

`element.scrollIntoView({ block: "center" })` scrolls every scrollable ancestor up to the document,
so a keyboard assist in one form could shift the whole dashboard — and on WebKit a programmatic
document scroll while the keyboard is being raised is itself a reason to abort the raise. It also
re-centres a control that is already comfortably visible, which is a visible jump for no benefit.

This helper instead:
- refuses unless the element is the CURRENTLY focused, still-connected control, so a late callback
  from a form the user already left cannot move the surface they are now looking at;
- finds the nearest genuinely scrollable ancestor and stops there — the document is never scrolled;
- moves by the minimum delta needed, and not at all when the control already fits;
- clamps the target against the scroller's own visible bound, so it cannot overshoot.
*/

export interface ScrollFocusedControlOptions {
  /**
   * Bottom edge of the visible area in viewport coordinates. Defaults to the scroller's own bottom.
   * Pass the shared frame's `visibleBottom` when the keyboard covers part of the scroller.
   */
  visibleBottom?: number;
  /** Extra breathing room to keep below the control, in CSS pixels. */
  margin?: number;
}

export type ScrollFocusedControlResult =
  | "scrolled"
  | "already-visible"
  | "not-focused"
  | "disconnected"
  | "no-scroller";

function isScrollable(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.scrollHeight <= element.clientHeight + 1) return false;
  if (typeof getComputedStyle !== "function") return true;
  const overflowY = getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

/** Nearest scrollable ancestor, or null when only the document could scroll. */
export function findScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    if (isScrollable(current)) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * Bring the focused control fully inside its own scroller.
 *
 * Returns why nothing happened when it declines, so callers and tests can distinguish "already
 * visible" from "refused because this is no longer the focused control".
 */
export function scrollFocusedControlWithin(
  element: HTMLElement | null | undefined,
  { visibleBottom, margin = 0 }: ScrollFocusedControlOptions = {},
): ScrollFocusedControlResult {
  if (!element) return "disconnected";
  if (!element.isConnected) return "disconnected";
  if (typeof document !== "undefined" && document.activeElement !== element) return "not-focused";

  const scroller = findScrollableAncestor(element);
  if (!scroller) return "no-scroller";

  const elementRect = element.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  if (!Number.isFinite(elementRect.height) || !Number.isFinite(scrollerRect.height)) return "no-scroller";

  const lowerBound = Math.min(
    scrollerRect.bottom,
    Number.isFinite(visibleBottom ?? Number.NaN) ? (visibleBottom as number) : scrollerRect.bottom,
  );
  const upperBound = scrollerRect.top;

  const overflowBelow = elementRect.bottom + margin - lowerBound;
  const overflowAbove = upperBound - elementRect.top;

  // Prefer revealing the bottom edge: that is the one a keyboard covers. Never do both, and never
  // scroll so far up that the control's own top leaves the scroller.
  let delta = 0;
  if (overflowBelow > 0) {
    delta = Math.min(overflowBelow, Math.max(0, elementRect.top - upperBound));
  } else if (overflowAbove > 0) {
    delta = -overflowAbove;
  }

  if (delta === 0) return "already-visible";

  scroller.scrollTop += delta;
  return "scrolled";
}
