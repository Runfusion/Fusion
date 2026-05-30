import { describe, expect, it } from "vitest";
import { computeIcbOffsets } from "../viewportOffset";

describe("computeIcbOffsets", () => {
  it("returns zero offsets for healthy viewport", () => {
    const offsets = computeIcbOffsets({
      innerWidth: 390,
      innerHeight: 844,
      vvWidth: 390,
      vvHeight: 844,
      vvOffsetTop: 0,
      vvOffsetLeft: 0,
      vvScale: 1,
      activeElementIsKeyboardFocusable: false,
      baselineViewportHeight: 844,
    });

    expect(offsets).toEqual({ rightOffset: 0, bottomOffset: 0 });
  });

  it("clamps iOS keyboard shrink to keep bottom offset pinned", () => {
    const offsets = computeIcbOffsets({
      innerWidth: 390,
      innerHeight: 844,
      vvWidth: 390,
      vvHeight: 520,
      vvOffsetTop: 0,
      vvOffsetLeft: 0,
      vvScale: 1,
      activeElementIsKeyboardFocusable: true,
      baselineViewportHeight: 844,
    });

    expect(offsets.bottomOffset).toBe(0);
  });

  it("preserves pinch-zoom offset compensation", () => {
    const offsets = computeIcbOffsets({
      innerWidth: 390,
      innerHeight: 844,
      vvWidth: 280,
      vvHeight: 600,
      vvOffsetTop: 0,
      vvOffsetLeft: 0,
      vvScale: 1.2,
      activeElementIsKeyboardFocusable: true,
      baselineViewportHeight: 844,
    });

    expect(offsets.bottomOffset).toBeGreaterThan(0);
    expect(offsets.rightOffset).toBeGreaterThan(0);
  });

  it("preserves Android ICB-stuck compensation without focus", () => {
    const offsets = computeIcbOffsets({
      innerWidth: 430,
      innerHeight: 932,
      vvWidth: 412,
      vvHeight: 850,
      vvOffsetTop: 0,
      vvOffsetLeft: 0,
      vvScale: 1,
      activeElementIsKeyboardFocusable: false,
      baselineViewportHeight: 932,
    });

    expect(offsets.bottomOffset).toBe(82);
    expect(offsets.rightOffset).toBe(18);
  });

  it("does not clamp unfocused viewport shrink as keyboard", () => {
    const offsets = computeIcbOffsets({
      innerWidth: 390,
      innerHeight: 844,
      vvWidth: 390,
      vvHeight: 760,
      vvOffsetTop: 0,
      vvOffsetLeft: 0,
      vvScale: 1,
      activeElementIsKeyboardFocusable: false,
      baselineViewportHeight: 844,
    });

    expect(offsets.bottomOffset).toBe(84);
  });
});
