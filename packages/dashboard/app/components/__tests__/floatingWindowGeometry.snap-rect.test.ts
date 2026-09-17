import { describe, expect, it } from "vitest";
import type { DashboardWindowBounds } from "../../context/DashboardWindowManagerContext";
import {
  FLOATING_WINDOW_CORNER_SNAP_MODES,
  FLOATING_WINDOW_DRAG_THRESHOLD_PX,
  FLOATING_WINDOW_SNAP_CONTACT_PX,
  demoteBottomAnchoredSnapMode,
  detectSnapZoneForRect,
  isBottomAnchoredSnapMode,
  isCornerSnapMode,
  rectRestsOnBottomWall,
  resolveSnapRect,
  shouldDetachSnappedWindow,
  type FloatingWindowRect,
} from "../floatingWindowGeometry";

/*
FNXC:FloatingWindowSnap 2026-09-15-04:01:
FN-401 unit contract for rect-driven zone arming. The dragged PANEL's own edges decide, so a window pushed
against a wall arms its column even when the pointer stays in the middle of the work area, and a large
window merely sitting NEAR a wall arms nothing. These cases pin wall contact, the corner priority, the
degenerate inputs, and the deliberate both-walls refusal.

The former 24px pointer band is gone on purpose: it would arm a zone for almost any window large relative
to the work area. Contact is exact, with a sub-pixel guard only.
*/

const bounds: DashboardWindowBounds = {
  left: 0,
  top: 64,
  right: 1280,
  bottom: 764,
  width: 1280,
  height: 700,
};

function rect(x: number, y: number, width = 600, height = 400): FloatingWindowRect {
  return { position: { x, y }, size: { width, height } };
}

describe("detectSnapZoneForRect", () => {
  it("arms the left column only when the panel's left edge touches the left wall", () => {
    expect(detectSnapZoneForRect(rect(bounds.left, 300), bounds)).toBe("left");
    // Near the wall is not against it: a big window must not arm a zone it was never pushed into.
    expect(detectSnapZoneForRect(rect(bounds.left + 20, 300), bounds)).toBeNull();
  });

  it("arms the right column only when the panel's right edge touches the right wall", () => {
    expect(detectSnapZoneForRect(rect(bounds.right - 600, 300), bounds)).toBe("right");
    expect(detectSnapZoneForRect(rect(bounds.right - 600 - 20, 300), bounds)).toBeNull();
  });

  it("arms the filled work area only when the panel's top edge touches the top wall", () => {
    expect(detectSnapZoneForRect(rect(400, bounds.top), bounds)).toBe("maximized");
    expect(detectSnapZoneForRect(rect(400, bounds.top + 20), bounds)).toBeNull();
  });

  /*
  FNXC:FloatingWindowSnap 2026-09-17-07:21:
  FN-493 replaces the former "the top wall wins in both top corners" case: an unambiguous top corner now arms its
  quadrant, which is the whole point of the 2x2 grid. The top rule itself is unchanged and is still pinned by the
  top-wall-only case above and by the vertical-ambiguity case below.
  */
  it("arms the top quadrants in both unambiguous top corners", () => {
    expect(detectSnapZoneForRect(rect(bounds.left, bounds.top), bounds)).toBe("top-left");
    expect(detectSnapZoneForRect(rect(bounds.right - 600, bounds.top), bounds)).toBe("top-right");
  });

  it("arms nothing from the middle of the work area", () => {
    expect(detectSnapZoneForRect(rect(340, 300), bounds)).toBeNull();
  });

  it("refuses to guess a side when the panel touches both side walls at once", () => {
    // A panel as wide as the work area is already equivalent to the filled area: it must detach first.
    expect(detectSnapZoneForRect(rect(bounds.left, 300, bounds.width), bounds)).toBeNull();
    // One pixel narrower is unambiguous again and arms the wall it is actually against.
    expect(detectSnapZoneForRect(rect(bounds.left, 300, bounds.width - 1), bounds)).toBe("left");
  });

  it("tolerates sub-pixel contact from a fractional work area", () => {
    expect(detectSnapZoneForRect(rect(bounds.left + 0.25, 300), bounds)).toBe("left");
    expect(detectSnapZoneForRect(rect(bounds.left + FLOATING_WINDOW_SNAP_CONTACT_PX + 0.1, 300), bounds)).toBeNull();
  });

  it("arms nothing for a degenerate work area", () => {
    expect(detectSnapZoneForRect(rect(0, 300), { ...bounds, width: 0 })).toBeNull();
    expect(detectSnapZoneForRect(rect(0, 300), { ...bounds, height: 0 })).toBeNull();
    expect(detectSnapZoneForRect(rect(0, 300), { ...bounds, width: -10 })).toBeNull();
  });

  it("arms nothing for non-finite geometry", () => {
    expect(detectSnapZoneForRect(rect(Number.NaN, 300), bounds)).toBeNull();
    expect(detectSnapZoneForRect(rect(0, Number.POSITIVE_INFINITY), bounds)).toBeNull();
    expect(detectSnapZoneForRect(rect(0, 300, Number.NaN), bounds)).toBeNull();
    expect(detectSnapZoneForRect(rect(0, 300), { ...bounds, right: Number.NaN })).toBeNull();
  });

  it("honours a caller-supplied contact tolerance", () => {
    expect(detectSnapZoneForRect(rect(40, 300), bounds)).toBeNull();
    expect(detectSnapZoneForRect(rect(40, 300), bounds, 48)).toBe("left");
  });

  /*
  FNXC:FloatingWindowSnap 2026-09-16-18:31:
  FN-469 bottom band. These cases pin the DELIBERATE last-place priority: a full-height column always rests on the
  bottom wall, so arming `bottom` before the sides would have re-routed every existing column snap.
  */
  it("arms the bottom band only when the panel's bottom edge touches the bottom wall", () => {
    expect(detectSnapZoneForRect(rect(340, bounds.bottom - 400), bounds)).toBe("bottom");
    expect(detectSnapZoneForRect(rect(340, bounds.bottom - 400 - 20), bounds)).toBeNull();
  });

  /*
  FNXC:FloatingWindowSnap 2026-09-17-07:21:
  FN-493 replaces the former "the side walls win in both bottom corners" case for the same reason: a bottom corner
  is unambiguous on both axes, so it arms its quadrant. The side rule is unchanged outside a corner (side-wall-only
  cases above) and the band rule is unchanged outside a corner (bottom-wall-only case above).
  */
  it("arms the bottom quadrants in both unambiguous bottom corners", () => {
    expect(detectSnapZoneForRect(rect(bounds.left, bounds.bottom - 400), bounds)).toBe("bottom-left");
    expect(detectSnapZoneForRect(rect(bounds.right - 600, bounds.bottom - 400), bounds)).toBe("bottom-right");
  });

  it("arms the bottom band for a panel as wide as the work area resting on the bottom wall", () => {
    // The both-walls refusal is a SIDE rule: such a panel is ambiguous about its side, never about its bottom.
    expect(detectSnapZoneForRect(rect(bounds.left, bounds.bottom - 400, bounds.width), bounds)).toBe("bottom");
  });

  it("tolerates sub-pixel contact on the bottom wall", () => {
    expect(detectSnapZoneForRect(rect(340, bounds.bottom - 400 - 0.25), bounds)).toBe("bottom");
    expect(detectSnapZoneForRect(rect(340, bounds.bottom - 400 - FLOATING_WINDOW_SNAP_CONTACT_PX - 0.1), bounds)).toBeNull();
  });

  it("arms no bottom band for a degenerate or non-finite work area", () => {
    expect(detectSnapZoneForRect(rect(340, bounds.bottom - 400), { ...bounds, height: 0 })).toBeNull();
    expect(detectSnapZoneForRect(rect(340, bounds.bottom - 400), { ...bounds, bottom: Number.NaN })).toBeNull();
  });

  /*
  FNXC:FloatingWindowSnap 2026-09-17-07:21:
  FN-493 corner quadrants. Case (a): the four corners arm, and the five existing single-wall / middle results are
  unchanged negative controls. The invariant is "both axes unambiguous" — nothing else arms a quadrant.
  */
  it("arms each of the four quadrants from its own corner", () => {
    expect(detectSnapZoneForRect(rect(bounds.left, bounds.top), bounds)).toBe("top-left");
    expect(detectSnapZoneForRect(rect(bounds.right - 600, bounds.top), bounds)).toBe("top-right");
    expect(detectSnapZoneForRect(rect(bounds.left, bounds.bottom - 400), bounds)).toBe("bottom-left");
    expect(detectSnapZoneForRect(rect(bounds.right - 600, bounds.bottom - 400), bounds)).toBe("bottom-right");
  });

  it("arms no quadrant outside a corner (negative controls for every existing mode)", () => {
    expect(detectSnapZoneForRect(rect(bounds.left, 300), bounds)).toBe("left");
    expect(detectSnapZoneForRect(rect(bounds.right - 600, 300), bounds)).toBe("right");
    expect(detectSnapZoneForRect(rect(400, bounds.top), bounds)).toBe("maximized");
    expect(detectSnapZoneForRect(rect(340, bounds.bottom - 400), bounds)).toBe("bottom");
    expect(detectSnapZoneForRect(rect(340, 300), bounds)).toBeNull();
  });

  /*
  Case (b): VERTICAL AMBIGUITY. A panel as tall as the work area touches top AND bottom, so no quadrant is armed
  and the historical top rule still wins — including against a side wall, whose result is bit-for-bit unchanged.
  */
  it("arms no quadrant for a full-height panel against either side wall and still returns maximized", () => {
    const fullHeight = rect(bounds.left, bounds.top, 600, bounds.height);
    expect(detectSnapZoneForRect(fullHeight, bounds)).toBe("maximized");
    const fullHeightRight = rect(bounds.right - 600, bounds.top, 600, bounds.height);
    expect(detectSnapZoneForRect(fullHeightRight, bounds)).toBe("maximized");
  });

  /* HORIZONTAL AMBIGUITY: touching both side walls arms no quadrant and keeps the existing refusal order. */
  it("arms no quadrant for a full-width panel and keeps the historical side refusal", () => {
    expect(detectSnapZoneForRect(rect(bounds.left, bounds.top, bounds.width, 400), bounds)).toBe("maximized");
    expect(detectSnapZoneForRect(rect(bounds.left, bounds.bottom - 400, bounds.width), bounds)).toBe("bottom");
    expect(detectSnapZoneForRect(rect(bounds.left, 300, bounds.width), bounds)).toBeNull();
  });

  /* Case (c): sub-pixel contact on EACH of a corner's two walls still arms the quadrant; beyond it, nothing. */
  it("tolerates sub-pixel contact on both walls of a corner", () => {
    expect(detectSnapZoneForRect(rect(bounds.left + 0.25, bounds.top + 0.25), bounds)).toBe("top-left");
    expect(detectSnapZoneForRect(rect(bounds.left + 0.25, bounds.top + FLOATING_WINDOW_SNAP_CONTACT_PX + 0.1), bounds)).toBe("left");
    expect(detectSnapZoneForRect(rect(bounds.left + FLOATING_WINDOW_SNAP_CONTACT_PX + 0.1, bounds.top + 0.25), bounds)).toBe("maximized");
  });

  /* Case (g): degenerate or non-finite bounds arm no quadrant, exactly like every other mode. */
  it("arms no quadrant for degenerate or non-finite bounds", () => {
    expect(detectSnapZoneForRect(rect(bounds.left, bounds.top), { ...bounds, width: 0 })).toBeNull();
    expect(detectSnapZoneForRect(rect(bounds.left, bounds.top), { ...bounds, height: -10 })).toBeNull();
    expect(detectSnapZoneForRect(rect(bounds.left, bounds.top), { ...bounds, right: Number.NaN })).toBeNull();
    expect(detectSnapZoneForRect(rect(Number.NaN, bounds.top), bounds)).toBeNull();
  });
});

/*
FNXC:FloatingWindowSnap 2026-09-17-07:21:
FN-493: each quadrant is exactly half the live work area on both axes, and the four of them tile that area with
no gap and no overlap — that tiling IS the 2x2 grid the operator asked for.
*/
describe("resolveSnapRect corner quadrants", () => {
  const half = { width: bounds.width / 2, height: bounds.height / 2 };

  it("places each quadrant at its own corner of the live work area", () => {
    expect(resolveSnapRect("top-left", bounds)).toEqual({ position: { x: 0, y: 64 }, size: half });
    expect(resolveSnapRect("top-right", bounds)).toEqual({ position: { x: 640, y: 64 }, size: half });
    expect(resolveSnapRect("bottom-left", bounds)).toEqual({ position: { x: 0, y: 414 }, size: half });
    expect(resolveSnapRect("bottom-right", bounds)).toEqual({ position: { x: 640, y: 414 }, size: half });
  });

  it("tiles the work area exactly: no gap, no overlap, union equal to the area", () => {
    const rects = FLOATING_WINDOW_CORNER_SNAP_MODES.map((mode) => resolveSnapRect(mode, bounds)!);
    const area = rects.reduce((sum, r) => sum + r.size.width * r.size.height, 0);
    expect(area).toBe(bounds.width * bounds.height);
    expect(Math.min(...rects.map((r) => r.position.x))).toBe(bounds.left);
    expect(Math.min(...rects.map((r) => r.position.y))).toBe(bounds.top);
    expect(Math.max(...rects.map((r) => r.position.x + r.size.width))).toBe(bounds.right);
    expect(Math.max(...rects.map((r) => r.position.y + r.size.height))).toBe(bounds.bottom);
    // The two columns meet on one seam and the two rows on another: adjacency, never overlap.
    expect(rects[0].position.x + rects[0].size.width).toBe(rects[1].position.x);
    expect(rects[0].position.y + rects[0].size.height).toBe(rects[2].position.y);
  });

  it("re-derives from the live work area rather than any stored rectangle", () => {
    const narrower = { ...bounds, right: 900, width: 900 };
    expect(resolveSnapRect("bottom-right", narrower)).toEqual({
      position: { x: 450, y: 414 },
      size: { width: 450, height: 350 },
    });
  });

  it("returns null for non-finite bounds and a zero-sized rect for a degenerate area", () => {
    expect(resolveSnapRect("top-left", { ...bounds, bottom: Number.NaN })).toBeNull();
    expect(resolveSnapRect("bottom-right", { ...bounds, width: 0, height: 0 })).toEqual({
      position: { x: bounds.left, y: bounds.top },
      size: { width: 0, height: 0 },
    });
  });
});

/*
FNXC:FloatingWindowSnap 2026-09-17-07:21:
FN-493 pure helpers consumed by the gesture layer: the undock artifact only ever plasters the BOTTOM edge, so the
demotion removes the bottom component alone and a legitimate side contact survives it.
*/
describe("demoteBottomAnchoredSnapMode / rectRestsOnBottomWall / isCornerSnapMode", () => {
  it("removes only the bottom component of a zone", () => {
    expect(demoteBottomAnchoredSnapMode("bottom")).toBeNull();
    expect(demoteBottomAnchoredSnapMode("bottom-left")).toBe("left");
    expect(demoteBottomAnchoredSnapMode("bottom-right")).toBe("right");
    expect(demoteBottomAnchoredSnapMode("left")).toBe("left");
    expect(demoteBottomAnchoredSnapMode("maximized")).toBe("maximized");
    expect(demoteBottomAnchoredSnapMode("top-left")).toBe("top-left");
    expect(demoteBottomAnchoredSnapMode(null)).toBeNull();
  });

  it("describes exactly the detection's own bottom-wall contact", () => {
    expect(rectRestsOnBottomWall(rect(340, bounds.bottom - 400), bounds)).toBe(true);
    expect(rectRestsOnBottomWall(rect(340, bounds.bottom - 400 - 0.25), bounds)).toBe(true);
    expect(rectRestsOnBottomWall(rect(340, bounds.bottom - 400 - 20), bounds)).toBe(false);
    expect(rectRestsOnBottomWall(rect(340, Number.NaN), bounds)).toBe(false);
  });

  it("classifies quadrants and bottom-anchored modes", () => {
    for (const mode of FLOATING_WINDOW_CORNER_SNAP_MODES) expect(isCornerSnapMode(mode)).toBe(true);
    expect(isCornerSnapMode("bottom")).toBe(false);
    expect(isCornerSnapMode(null)).toBe(false);
    expect(isBottomAnchoredSnapMode("bottom")).toBe(true);
    expect(isBottomAnchoredSnapMode("bottom-left")).toBe(true);
    expect(isBottomAnchoredSnapMode("bottom-right")).toBe(true);
    expect(isBottomAnchoredSnapMode("top-left")).toBe(false);
    expect(isBottomAnchoredSnapMode("left")).toBe(false);
  });
});

/*
FNXC:FloatingWindowSnap 2026-09-16-18:31:
FN-469: the bottom band rectangle is full width over the LOWER HALF of the live work area, mirroring the columns'
half split on the other axis, and it degenerates exactly like every other mode.
*/
describe("resolveSnapRect bottom band", () => {
  it("fills the full width of the lower half of the live work area", () => {
    expect(resolveSnapRect("bottom", bounds)).toEqual({
      position: { x: bounds.left, y: bounds.top + bounds.height / 2 },
      size: { width: bounds.width, height: bounds.height / 2 },
    });
  });

  it("re-derives from the live work area rather than any stored rectangle", () => {
    const narrower = { ...bounds, right: 900, width: 900 };
    expect(resolveSnapRect("bottom", narrower)?.size.width).toBe(900);
  });

  it("returns null for non-finite or degenerate bounds", () => {
    expect(resolveSnapRect("bottom", { ...bounds, bottom: Number.NaN })).toBeNull();
    expect(resolveSnapRect("bottom", { ...bounds, height: 0 })).toEqual({
      position: { x: bounds.left, y: bounds.top },
      size: { width: bounds.width, height: 0 },
    });
  });
});

/*
FNXC:FloatingWindowSnap 2026-09-15-14:07:
FN-422 unit contract for the omnidirectional undock predicate. A docked window used to come loose only by
dragging DOWN 24px, so a column or full-screen window looked stuck in every other direction. Release now
happens as soon as the gesture stops being a click, whatever its direction; below the threshold the gesture
is still a click and the dock survives.
*/
describe("shouldDetachSnappedWindow", () => {
  const start = { x: 300, y: 300 };

  it("detaches exactly at the drag threshold and not just below it", () => {
    expect(shouldDetachSnappedWindow(start, { x: 300, y: 300 + FLOATING_WINDOW_DRAG_THRESHOLD_PX })).toBe(true);
    expect(shouldDetachSnappedWindow(start, { x: 300, y: 300 + FLOATING_WINDOW_DRAG_THRESHOLD_PX - 0.1 })).toBe(false);
  });

  it("keeps a motionless pointer a click", () => {
    expect(shouldDetachSnappedWindow(start, { x: 300, y: 300 })).toBe(false);
  });

  it.each([
    ["up", { x: 300, y: 280 }],
    ["down", { x: 300, y: 320 }],
    ["left", { x: 280, y: 300 }],
    ["right", { x: 320, y: 300 }],
    ["diagonal", { x: 320, y: 280 }],
  ])("detaches on a %s gesture beyond the threshold", (_direction, pointer) => {
    expect(shouldDetachSnappedWindow(start, pointer)).toBe(true);
  });

  it("honours a caller-supplied threshold", () => {
    expect(shouldDetachSnappedWindow(start, { x: 310, y: 300 }, 48)).toBe(false);
    expect(shouldDetachSnappedWindow(start, { x: 360, y: 300 }, 48)).toBe(true);
  });

  it("never detaches on non-finite input", () => {
    expect(shouldDetachSnappedWindow(start, { x: Number.NaN, y: 300 })).toBe(false);
    expect(shouldDetachSnappedWindow(start, { x: 300, y: Number.POSITIVE_INFINITY })).toBe(false);
    expect(shouldDetachSnappedWindow({ x: Number.NaN, y: 300 }, { x: 900, y: 900 })).toBe(false);
    expect(shouldDetachSnappedWindow(start, { x: 900, y: 900 }, Number.NaN)).toBe(false);
  });
});
