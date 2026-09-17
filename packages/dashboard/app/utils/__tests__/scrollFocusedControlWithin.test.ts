import { afterEach, describe, expect, it, vi } from "vitest";
import { findScrollableAncestor, scrollFocusedControlWithin } from "../scrollFocusedControlWithin";

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512 replaced page-moving `scrollIntoView({ block: "center" })` keyboard assists with a local,
minimal reveal. The properties that matter are asserted here: only the focused connected control is
acted on, only its own scroller moves, the document never does, and an already-visible control is
left exactly where it is.

jsdom has no layout, so both the scroll geometry and the element rectangles are supplied explicitly.
*/

function buildScroller({
  scrollerTop = 0,
  scrollerHeight = 400,
  fieldTop = 600,
  fieldHeight = 40,
  scrollHeight = 2000,
}: {
  scrollerTop?: number;
  scrollerHeight?: number;
  fieldTop?: number;
  fieldHeight?: number;
  scrollHeight?: number;
} = {}) {
  const scroller = document.createElement("div");
  const field = document.createElement("textarea");
  scroller.append(field);
  document.body.append(scroller);

  Object.defineProperties(scroller, {
    scrollHeight: { value: scrollHeight, configurable: true },
    clientHeight: { value: scrollerHeight, configurable: true },
  });
  scroller.style.overflowY = "auto";
  let scrollTop = 0;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (next: number) => { scrollTop = next; },
  });
  scroller.getBoundingClientRect = () => ({
    top: scrollerTop,
    bottom: scrollerTop + scrollerHeight,
    height: scrollerHeight,
    left: 0, right: 390, width: 390, x: 0, y: scrollerTop, toJSON: () => ({}),
  }) as DOMRect;
  field.getBoundingClientRect = () => ({
    top: fieldTop,
    bottom: fieldTop + fieldHeight,
    height: fieldHeight,
    left: 0, right: 390, width: 390, x: 0, y: fieldTop, toJSON: () => ({}),
  }) as DOMRect;

  return { scroller, field };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("scrollFocusedControlWithin", () => {
  it("scrolls the field's own scroller by the minimum needed amount", () => {
    const { scroller, field } = buildScroller({ scrollerHeight: 400, fieldTop: 420, fieldHeight: 40 });
    field.focus();

    expect(scrollFocusedControlWithin(field)).toBe("scrolled");
    // The field's bottom sits 60px below the scroller's bottom, so exactly 60px are scrolled.
    expect(scroller.scrollTop).toBe(60);
  });

  it("stops at the visible bound when the keyboard covers part of the scroller", () => {
    const { scroller, field } = buildScroller({ scrollerHeight: 800, fieldTop: 480, fieldHeight: 40 });
    field.focus();

    expect(scrollFocusedControlWithin(field, { visibleBottom: 500 })).toBe("scrolled");
    expect(scroller.scrollTop).toBe(20);
  });

  it("keeps an extra margin below the control when asked", () => {
    // The field's bottom sits exactly on the scroller's bottom edge: without a margin nothing
    // moves, and the requested 16px of breathing room is the entire scroll.
    const { scroller, field } = buildScroller({ scrollerHeight: 400, fieldTop: 360, fieldHeight: 40 });
    field.focus();

    expect(scrollFocusedControlWithin(field)).toBe("already-visible");
    expect(scrollFocusedControlWithin(field, { margin: 16 })).toBe("scrolled");
    expect(scroller.scrollTop).toBe(16);
  });

  it("does nothing at all when the control is already comfortably visible", () => {
    const { scroller, field } = buildScroller({ scrollerHeight: 400, fieldTop: 100, fieldHeight: 40 });
    field.focus();

    expect(scrollFocusedControlWithin(field)).toBe("already-visible");
    expect(scroller.scrollTop).toBe(0);
  });

  it("reveals a control that sits above the scroller's top", () => {
    const { scroller, field } = buildScroller({ scrollerTop: 100, scrollerHeight: 400, fieldTop: 40, fieldHeight: 40 });
    field.focus();

    expect(scrollFocusedControlWithin(field)).toBe("scrolled");
    expect(scroller.scrollTop).toBe(-60);
  });

  it("refuses when the element is no longer the focused control", () => {
    const { scroller, field } = buildScroller();
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();

    expect(scrollFocusedControlWithin(field)).toBe("not-focused");
    expect(scroller.scrollTop).toBe(0);
  });

  it("refuses a field that has been detached from the document", () => {
    const { field } = buildScroller();
    field.focus();
    field.remove();

    expect(scrollFocusedControlWithin(field)).toBe("disconnected");
  });

  it("refuses null and undefined targets", () => {
    expect(scrollFocusedControlWithin(null)).toBe("disconnected");
    expect(scrollFocusedControlWithin(undefined)).toBe("disconnected");
  });

  it("never scrolls the document when the control has no scrollable ancestor", () => {
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    expect(scrollFocusedControlWithin(field)).toBe("no-scroller");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("never calls scrollIntoView, which would move every scrollable ancestor", () => {
    const { field } = buildScroller();
    field.focus();
    const scrollIntoView = vi.fn();
    field.scrollIntoView = scrollIntoView;

    scrollFocusedControlWithin(field);

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("findScrollableAncestor", () => {
  it("skips a non-scrolling wrapper and returns the real scroller", () => {
    const { scroller, field } = buildScroller();
    const wrapper = document.createElement("div");
    scroller.append(wrapper);
    wrapper.append(field);

    expect(findScrollableAncestor(field)).toBe(scroller);
  });

  it("returns null rather than the document element", () => {
    const field = document.createElement("textarea");
    document.body.append(field);

    expect(findScrollableAncestor(field)).toBeNull();
  });
});
