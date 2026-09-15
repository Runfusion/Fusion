import { describe, expect, it } from "vitest";
import type { DashboardWindowBounds } from "../../context/DashboardWindowManagerContext";
import {
  FLOATING_WINDOW_SNAP_CONTACT_PX,
  detectSnapZoneForRect,
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

  it("gives the top wall priority in both top corners", () => {
    expect(detectSnapZoneForRect(rect(bounds.left, bounds.top), bounds)).toBe("maximized");
    expect(detectSnapZoneForRect(rect(bounds.right - 600, bounds.top), bounds)).toBe("maximized");
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
});
