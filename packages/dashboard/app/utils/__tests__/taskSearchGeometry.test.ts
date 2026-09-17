/**
 * FNXC:TaskSearch 2026-09-17-09:41:
 * FN-477 panel geometry. This file pins the arithmetic; the REAL proof that the panel uses it lives
 * in `TaskSearchResultsPopover.test.tsx`, which mounts the production component with injected
 * rectangles. A geometry function tested alone cannot show that anything renders at that size.
 */
import { describe, expect, it } from "vitest";
import {
  TASK_SEARCH_FALLBACK_CARD_HEIGHT,
  TASK_SEARCH_FALLBACK_CARD_WIDTH,
  TASK_SEARCH_MIN_SCROLL_HEIGHT,
  TASK_SEARCH_PEEK_RATIO,
  TASK_SEARCH_VIEWPORT_MARGIN,
  computeTaskSearchAnchor,
  computeTaskSearchPanelGeometry,
} from "../taskSearchGeometry";

describe("computeTaskSearchPanelGeometry", () => {
  it("reserves one full card plus the gap plus half of the next", () => {
    const geometry = computeTaskSearchPanelGeometry({
      cardHeights: [120, 200],
      gap: 8,
      availableHeight: 900,
    });
    expect(geometry.scrollHeight).toBe(120 + 8 + 100);
    expect(geometry.constrainedByViewport).toBe(false);
  });

  it("uses the SECOND card's own height for the peek, not the first card's", () => {
    // Cards genuinely differ in height (steps expanded, long titles, status bars).
    const tall = computeTaskSearchPanelGeometry({ cardHeights: [100, 400], gap: 0, availableHeight: 5000 });
    const short = computeTaskSearchPanelGeometry({ cardHeights: [100, 40], gap: 0, availableHeight: 5000 });
    expect(tall.scrollHeight).toBe(100 + 400 * TASK_SEARCH_PEEK_RATIO);
    expect(short.scrollHeight).toBe(100 + 40 * TASK_SEARCH_PEEK_RATIO);
  });

  it("derives the reserve from the single card's measurement without fabricating a second card", () => {
    const geometry = computeTaskSearchPanelGeometry({ cardHeights: [160], gap: 10, availableHeight: 900 });
    expect(geometry.scrollHeight).toBe(160 + 10 + 80);
  });

  it("falls back to tokens before anything has been measured", () => {
    const geometry = computeTaskSearchPanelGeometry({ cardHeights: [], gap: 0, availableHeight: 900 });
    expect(geometry.scrollHeight).toBe(TASK_SEARCH_FALLBACK_CARD_HEIGHT * (1 + TASK_SEARCH_PEEK_RATIO));
    expect(geometry.width).toBe(TASK_SEARCH_FALLBACK_CARD_WIDTH);
  });

  it("uses the measured reference card width in preference to the token", () => {
    expect(computeTaskSearchPanelGeometry({
      cardHeights: [100, 100],
      gap: 0,
      availableHeight: 900,
      referenceCardWidth: 372,
    }).width).toBe(372);
  });

  it("adds the scrollbar beside the card instead of taking it out of the card", () => {
    // Measured in Chromium: without this the result card rendered ~2px narrower than its board card.
    expect(computeTaskSearchPanelGeometry({
      cardHeights: [100, 100],
      gap: 0,
      availableHeight: 900,
      referenceCardWidth: 344,
      scrollbarWidth: 15,
    }).width).toBe(359);

    // A non-scrolling panel adds nothing.
    expect(computeTaskSearchPanelGeometry({
      cardHeights: [100, 100],
      gap: 0,
      availableHeight: 900,
      referenceCardWidth: 344,
      scrollbarWidth: 0,
    }).width).toBe(344);
  });

  it("stays contained on a short viewport and reports that it was constrained", () => {
    const geometry = computeTaskSearchPanelGeometry({ cardHeights: [220, 220], gap: 8, availableHeight: 180 });
    expect(geometry.scrollHeight).toBe(180);
    expect(geometry.constrainedByViewport).toBe(true);
  });

  it("never collapses below a usable floor even with almost no room", () => {
    const geometry = computeTaskSearchPanelGeometry({ cardHeights: [220, 220], gap: 8, availableHeight: 4 });
    expect(geometry.scrollHeight).toBe(TASK_SEARCH_MIN_SCROLL_HEIGHT);
  });

  it("ignores degenerate measurements instead of producing a zero-height panel", () => {
    const geometry = computeTaskSearchPanelGeometry({
      cardHeights: [0, Number.NaN, 150],
      gap: Number.NaN,
      availableHeight: 900,
    });
    // The zero and NaN rows are discarded, so 150 becomes the first usable card.
    expect(geometry.scrollHeight).toBe(150 * (1 + TASK_SEARCH_PEEK_RATIO));
  });
});

describe("computeTaskSearchAnchor", () => {
  const field = { top: 60, bottom: 92, left: 400, width: 220 };

  it("opens below the field on a normal desktop viewport", () => {
    const anchor = computeTaskSearchAnchor({
      fieldRect: field,
      viewport: { width: 1440, height: 900 },
      panelWidth: 340,
      offset: 4,
    });
    expect(anchor.placement).toBe("below");
    expect(anchor.top).toBe(96);
    expect(anchor.left).toBe(400);
    expect(anchor.availableHeight).toBe(900 - 92 - 4 - TASK_SEARCH_VIEWPORT_MARGIN);
  });

  it("flips above when a keyboard leaves almost no room below", () => {
    const anchor = computeTaskSearchAnchor({
      fieldRect: { top: 300, bottom: 340, left: 20, width: 300 },
      viewport: { width: 390, height: 380 },
      panelWidth: 340,
      offset: 4,
    });
    expect(anchor.placement).toBe("above");
    expect(anchor.availableHeight).toBeGreaterThan(0);
  });

  it("keeps the panel inside the viewport when the field sits near the right edge", () => {
    const anchor = computeTaskSearchAnchor({
      fieldRect: { top: 60, bottom: 92, left: 1300, width: 120 },
      viewport: { width: 1440, height: 900 },
      panelWidth: 340,
      offset: 4,
    });
    expect(anchor.left).toBe(1440 - 340 - TASK_SEARCH_VIEWPORT_MARGIN);
  });

  it("does not push the panel off the left edge on a narrow phone", () => {
    const anchor = computeTaskSearchAnchor({
      fieldRect: { top: 60, bottom: 92, left: 2, width: 380 },
      viewport: { width: 390, height: 844 },
      panelWidth: 380,
      offset: 4,
    });
    expect(anchor.left).toBeGreaterThanOrEqual(TASK_SEARCH_VIEWPORT_MARGIN);
  });

  it("never reports a negative available height", () => {
    const anchor = computeTaskSearchAnchor({
      fieldRect: { top: 0, bottom: 800, left: 0, width: 300 },
      viewport: { width: 390, height: 300 },
      panelWidth: 300,
      offset: 4,
    });
    expect(anchor.availableHeight).toBeGreaterThanOrEqual(0);
  });
});
