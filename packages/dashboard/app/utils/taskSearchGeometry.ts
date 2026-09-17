/**
 * FNXC:TaskSearch 2026-09-17-09:41:
 * FN-477 geometry for the header search results panel.
 *
 * The operator requirement is concrete: before any scrolling is needed, the panel must show one
 * COMPLETE result card plus half of the next one, so it is immediately obvious that the list
 * continues. That reserve is `height(card 1) + gap + 0.5 × height(card 2)`; borders, padding, and
 * status bars belong to the cards themselves and are therefore already inside those measurements.
 *
 * This module is pure so it can be reasoned about and tested directly, but it is the SAME function
 * the popover calls — a geometry helper that nothing uses would prove nothing.
 */

/** Fallback card height used only for the first paint, before any card has been measured. */
export const TASK_SEARCH_FALLBACK_CARD_HEIGHT = 132;

/** Fallback panel width, matching the board column's minimum content width. */
export const TASK_SEARCH_FALLBACK_CARD_WIDTH = 300;

/** Fraction of the second card that must be visible before scrolling. */
export const TASK_SEARCH_PEEK_RATIO = 0.5;

/** Distance kept between the panel and the viewport edge. */
export const TASK_SEARCH_VIEWPORT_MARGIN = 8;

/**
 * Absolute floor for the scroll area. On a genuinely short viewport (landscape phone, on-screen
 * keyboard) the 1.5-card reserve does not fit; the panel then stays CONTAINED and scrollable rather
 * than shrinking the cards or overflowing the screen, because an unreadable card is worse than a
 * shorter list.
 */
export const TASK_SEARCH_MIN_SCROLL_HEIGHT = 96;

export interface TaskSearchPanelInput {
  /** Measured heights of the rendered result cards, in DOM order. */
  cardHeights: readonly number[];
  /** Vertical gap between cards, from the rendered layout. */
  gap: number;
  /** Space actually available below (or above) the field, already excluding the viewport margin. */
  availableHeight: number;
  /** Measured inner width of a board card/column, when one is measurable. */
  referenceCardWidth?: number;
  /**
   * Width the panel's own scrollbar takes from its content box, when the list scrolls.
   *
   * FNXC:TaskSearch 2026-09-17-09:41:
   * Without this the scrollbar ate into the card width and every result rendered ~2px narrower than
   * the board card it referred to (measured in Chromium). The requirement is that the CARD matches
   * the board card, so the scrollbar is added beside it rather than taken out of it.
   */
  scrollbarWidth?: number;
}

export interface TaskSearchPanelGeometry {
  /** Height reserved for the scrolling area. */
  scrollHeight: number;
  /** Panel content width: the reference card width plus any scrollbar, so a CARD measures like its board card. */
  width: number;
  /** True when the 1.5-card reserve had to be reduced to fit the viewport. */
  constrainedByViewport: boolean;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Compute the panel's scroll height and width.
 *
 * With a SINGLE result the reserve is derived from that card's own measurement rather than from a
 * fabricated second card: the panel keeps the same shape whether or not a second result exists, and
 * nothing is rendered that the server did not return.
 */
export function computeTaskSearchPanelGeometry(input: TaskSearchPanelInput): TaskSearchPanelGeometry {
  const gap = positiveOr(input.gap, 0);
  const heights = input.cardHeights.filter((height) => Number.isFinite(height) && height > 0);
  const first = positiveOr(heights[0], TASK_SEARCH_FALLBACK_CARD_HEIGHT);
  const second = positiveOr(heights[1], first);

  const desired = first + gap + second * TASK_SEARCH_PEEK_RATIO;
  const available = positiveOr(input.availableHeight, desired);
  const scrollHeight = Math.max(TASK_SEARCH_MIN_SCROLL_HEIGHT, Math.min(desired, available));

  const cardWidth = positiveOr(input.referenceCardWidth, TASK_SEARCH_FALLBACK_CARD_WIDTH);
  const scrollbarWidth = Math.max(0, input.scrollbarWidth ?? 0);

  return {
    scrollHeight,
    width: cardWidth + scrollbarWidth,
    constrainedByViewport: scrollHeight < desired,
  };
}

export interface TaskSearchAnchorInput {
  /** The search field's viewport rectangle. */
  fieldRect: { top: number; bottom: number; left: number; width: number };
  /** Current visual-viewport size, which shrinks when a mobile keyboard opens. */
  viewport: { width: number; height: number };
  /** Panel width from `computeTaskSearchPanelGeometry`. */
  panelWidth: number;
  /** Gap between the field and the panel. */
  offset: number;
}

export interface TaskSearchAnchorGeometry {
  /**
   * The anchor LINE, not the panel's box top. For `"below"` it is the panel's top edge; for
   * `"above"` it is the panel's bottom edge and the caller shifts the box up by its own height. That
   * keeps this function pure: it never needs the rendered panel height to place the panel.
   */
  top: number;
  left: number;
  /** Space available for the panel at the chosen placement, margin already removed. */
  availableHeight: number;
  placement: "below" | "above";
}

/**
 * Anchor the panel to the field. It opens downward by default and flips upward only when that side
 * is genuinely roomier, so an on-screen keyboard covering the lower half does not leave the panel
 * pinned into a few unusable pixels.
 */
export function computeTaskSearchAnchor(input: TaskSearchAnchorInput): TaskSearchAnchorGeometry {
  const { fieldRect, viewport, panelWidth, offset } = input;
  const spaceBelow = viewport.height - fieldRect.bottom - offset - TASK_SEARCH_VIEWPORT_MARGIN;
  const spaceAbove = fieldRect.top - offset - TASK_SEARCH_VIEWPORT_MARGIN;
  const placement: "below" | "above" = spaceBelow >= spaceAbove ? "below" : "above";
  const availableHeight = Math.max(0, placement === "below" ? spaceBelow : spaceAbove);

  // Align to the field's inline start, then keep the whole panel inside the viewport.
  const maxLeft = Math.max(TASK_SEARCH_VIEWPORT_MARGIN, viewport.width - panelWidth - TASK_SEARCH_VIEWPORT_MARGIN);
  const left = Math.min(Math.max(TASK_SEARCH_VIEWPORT_MARGIN, fieldRect.left), maxLeft);

  return {
    top: placement === "below" ? fieldRect.bottom + offset : Math.max(TASK_SEARCH_VIEWPORT_MARGIN, fieldRect.top - offset),
    left,
    availableHeight,
    placement,
  };
}
