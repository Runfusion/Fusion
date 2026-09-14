import { describe, expect, it } from "vitest";

import {
  STICKY_BOTTOM_ECHO_EPSILON_PX,
  STICKY_BOTTOM_REARM_THRESHOLD_PX,
  distanceToBottom,
  isAtClampedBottom,
  isIntentUnableToMove,
  isProgrammaticScrollEcho,
  isScrollable,
  isWithinBottomRearmWindow,
  resolveKeyIntentDirection,
  resolveStickyBottomFollow,
  type StickyBottomGeometry,
  type StickyBottomState,
} from "../stickyBottomScroll";

function geometry(overrides: Partial<StickyBottomGeometry> = {}): StickyBottomGeometry {
  return { scrollTop: 1600, scrollHeight: 2000, clientHeight: 400, ...overrides };
}

function state(overrides: Partial<StickyBottomState> = {}): StickyBottomState {
  return { following: true, geometry: geometry(), ...overrides };
}

describe("stickyBottomScroll geometry helpers", () => {
  it("measures the distance to the bottom edge", () => {
    expect(distanceToBottom(geometry())).toBe(0);
    expect(distanceToBottom(geometry({ scrollTop: 1570 }))).toBe(30);
  });

  it("treats a container smaller than its viewport as not scrollable", () => {
    expect(isScrollable(geometry({ scrollHeight: 400, clientHeight: 400 }))).toBe(false);
    expect(isScrollable(geometry())).toBe(true);
  });

  it("separates the rearm window from the clamped bottom", () => {
    const thirtyPxUp = geometry({ scrollTop: 1570 });
    expect(isWithinBottomRearmWindow(thirtyPxUp)).toBe(true);
    expect(isAtClampedBottom(thirtyPxUp)).toBe(false);
    expect(isAtClampedBottom(geometry())).toBe(true);
  });
});

describe("isProgrammaticScrollEcho", () => {
  it("is false when no programmatic write is outstanding", () => {
    expect(isProgrammaticScrollEcho({ scrollTop: 1600, expectedScrollTop: null })).toBe(false);
    expect(isProgrammaticScrollEcho({ scrollTop: 1600 })).toBe(false);
  });

  it("attributes a scroll to our own write by expected position, not by a time window", () => {
    expect(isProgrammaticScrollEcho({ scrollTop: 1600, expectedScrollTop: 1600 })).toBe(true);
    expect(
      isProgrammaticScrollEcho({ scrollTop: 1600 - STICKY_BOTTOM_ECHO_EPSILON_PX, expectedScrollTop: 1600 }),
    ).toBe(true);
    expect(isProgrammaticScrollEcho({ scrollTop: 1570, expectedScrollTop: 1600 })).toBe(false);
  });
});

describe("isIntentUnableToMove", () => {
  it("reports a non-scrollable container as unable to move", () => {
    expect(isIntentUnableToMove(geometry({ scrollHeight: 400, clientHeight: 400 }), "up")).toBe(true);
  });

  it("reports an upward gesture at the very top as unable to move", () => {
    expect(isIntentUnableToMove(geometry({ scrollTop: 0 }), "up")).toBe(true);
    expect(isIntentUnableToMove(geometry({ scrollTop: 10 }), "up")).toBe(false);
  });

  it("reports residual downward momentum at the clamped bottom as unable to move", () => {
    expect(isIntentUnableToMove(geometry(), "down")).toBe(true);
    expect(isIntentUnableToMove(geometry({ scrollTop: 1570 }), "down")).toBe(false);
  });

  it("reports a gesture with no vertical direction as unable to move", () => {
    expect(isIntentUnableToMove(geometry({ scrollTop: 800 }), "none")).toBe(true);
  });
});

describe("resolveStickyBottomFollow — user intent always wins", () => {
  it("disengages on a wheel-up smaller than the rearm threshold (FN-398 reported regression)", () => {
    const thirtyPxUp = geometry({ scrollTop: 1570 });
    expect(isWithinBottomRearmWindow(thirtyPxUp)).toBe(true);
    const decision = resolveStickyBottomFollow(state({ geometry: thirtyPxUp }), { kind: "wheel", direction: "up" });
    expect(decision.following).toBe(false);
    expect(decision.isUserIntent).toBe(true);
  });

  it("disengages on an upward touch pan regardless of geometry", () => {
    const decision = resolveStickyBottomFollow(
      state({ geometry: geometry({ scrollTop: 1595 }) }),
      { kind: "touch", direction: "up" },
    );
    expect(decision.following).toBe(false);
  });

  it("keeps following on residual downward momentum at the clamped bottom", () => {
    const decision = resolveStickyBottomFollow(state(), { kind: "wheel", direction: "down" });
    expect(decision.following).toBe(true);
  });

  it("keeps following when an upward gesture cannot move the viewport", () => {
    expect(
      resolveStickyBottomFollow(state({ geometry: geometry({ scrollTop: 0 }) }), { kind: "wheel", direction: "up" })
        .following,
    ).toBe(true);
    expect(
      resolveStickyBottomFollow(
        state({ geometry: geometry({ scrollHeight: 400, clientHeight: 400, scrollTop: 0 }) }),
        { kind: "touch", direction: "up" },
      ).following,
    ).toBe(true);
  });

  it("rearms when a downward gesture brings the reader back into the rearm window", () => {
    const decision = resolveStickyBottomFollow(
      state({ following: false, geometry: geometry({ scrollTop: 1570 }) }),
      { kind: "touch", direction: "down" },
    );
    expect(decision.following).toBe(true);
  });

  it("does not rearm a downward gesture that is still far above the bottom", () => {
    const decision = resolveStickyBottomFollow(
      state({ following: false, geometry: geometry({ scrollTop: 800 }) }),
      { kind: "wheel", direction: "down" },
    );
    expect(decision.following).toBe(false);
  });
});

describe("resolveStickyBottomFollow — keyboard", () => {
  it("disengages on ArrowUp, PageUp and Home", () => {
    for (const key of ["ArrowUp", "PageUp", "Home"]) {
      const intent = resolveKeyIntentDirection(key);
      expect(intent).not.toBeNull();
      const decision = resolveStickyBottomFollow(
        state({ geometry: geometry({ scrollTop: 1590 }) }),
        { kind: "key", direction: intent!.direction, toEnd: intent!.toEnd },
      );
      expect(decision.following, key).toBe(false);
    }
  });

  it("rearms on End even from far above the bottom", () => {
    const intent = resolveKeyIntentDirection("End");
    const decision = resolveStickyBottomFollow(
      state({ following: false, geometry: geometry({ scrollTop: 0 }) }),
      { kind: "key", direction: intent!.direction, toEnd: intent!.toEnd },
    );
    expect(decision.following).toBe(true);
  });

  it("ignores a key already consumed by a nested widget", () => {
    const decision = resolveStickyBottomFollow(
      state({ geometry: geometry({ scrollTop: 1590 }) }),
      { kind: "key", direction: "up", defaultPrevented: true },
    );
    expect(decision.following).toBe(true);
    expect(decision.isUserIntent).toBe(false);
  });

  it("returns null for keys that are not vertical navigation", () => {
    expect(resolveKeyIntentDirection("a")).toBeNull();
    expect(resolveKeyIntentDirection("Enter")).toBeNull();
  });
});

describe("resolveStickyBottomFollow — scroll events", () => {
  it("treats a scroll matching the expected programmatic position as an echo that changes nothing", () => {
    const decision = resolveStickyBottomFollow(
      state({ following: true, geometry: geometry(), expectedScrollTop: 1600, previousScrollTop: 2000 }),
      { kind: "scroll" },
    );
    expect(decision.isEcho).toBe(true);
    expect(decision.following).toBe(true);
    expect(decision.isUserIntent).toBe(false);
  });

  it("disengages on a non-echo upward scroll (scrollbar drag, find-in-page)", () => {
    const decision = resolveStickyBottomFollow(
      state({ geometry: geometry({ scrollTop: 1590 }), previousScrollTop: 1600 }),
      { kind: "scroll" },
    );
    expect(decision.following).toBe(false);
    expect(decision.isUserIntent).toBe(true);
  });

  it("rearms on a non-echo scroll back into the rearm window", () => {
    const decision = resolveStickyBottomFollow(
      state({ following: false, geometry: geometry({ scrollTop: 1590 }), previousScrollTop: 800 }),
      { kind: "scroll" },
    );
    expect(decision.following).toBe(true);
  });

  it("stays detached on a downward scroll that is still above the rearm window", () => {
    const decision = resolveStickyBottomFollow(
      state({ following: false, geometry: geometry({ scrollTop: 900 }), previousScrollTop: 800 }),
      { kind: "scroll" },
    );
    expect(decision.following).toBe(false);
  });

  it("honours a caller-supplied threshold", () => {
    const twentyPxUp = geometry({ scrollTop: 1580 });
    expect(
      resolveStickyBottomFollow(
        state({ following: false, geometry: twentyPxUp, previousScrollTop: 800 }),
        { kind: "scroll" },
        10,
      ).following,
    ).toBe(false);
    expect(
      resolveStickyBottomFollow(
        state({ following: false, geometry: twentyPxUp, previousScrollTop: 800 }),
        { kind: "scroll" },
        STICKY_BOTTOM_REARM_THRESHOLD_PX,
      ).following,
    ).toBe(true);
  });
});

describe("resolveStickyBottomFollow — growth and explicit commands", () => {
  it("never changes the follow state on growth, in either direction", () => {
    expect(resolveStickyBottomFollow(state({ following: false }), { kind: "growth" }).following).toBe(false);
    expect(
      resolveStickyBottomFollow(state({ following: true, geometry: geometry({ scrollTop: 0 }) }), { kind: "growth" })
        .following,
    ).toBe(true);
  });

  it("engages on explicit-follow and disengages on explicit-detach", () => {
    expect(
      resolveStickyBottomFollow(state({ following: false, geometry: geometry({ scrollTop: 0 }) }), {
        kind: "explicit-follow",
      }).following,
    ).toBe(true);
    expect(resolveStickyBottomFollow(state({ following: true }), { kind: "explicit-detach" }).following).toBe(false);
  });
});
