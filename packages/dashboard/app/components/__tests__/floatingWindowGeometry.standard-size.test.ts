import { describe, expect, it } from "vitest";
import type { DashboardWindowBounds } from "../../context/DashboardWindowManagerContext";
import {
  FLOATING_WINDOW_OPENING_ASPECT_RATIO,
  FLOATING_WINDOW_STANDARD_HEIGHT_RATIO,
  FLOATING_WINDOW_STANDARD_WIDTH,
  FLOATING_WINDOW_TASK_STANDARD_HEIGHT,
  clampFloatingWindowSize,
  resolveOpeningRect,
  resolveSnapRect,
  resolveStandardSize,
} from "../floatingWindowGeometry";

/*
FNXC:FloatingWindowGeometry 2026-09-15-13:41:
FN-418 unit contract for the proportional opening cap. A fixed-pixel opening height used to be clamped
straight down to the work area, so any host asking for more than the live band between header and footer
opened at 100% of it. These cases pin the cap itself, the untouched small dialogs, the `minSize` priority,
the degenerate work areas, and the fact that snapping still fills the full area.

FNXC:FloatingWindowGeometry 2026-09-16-05:45:
FN-456 keeps the PURPOSE of that contract — an opening height never fills the work area — but changes the
expected numbers, because the opening height is now derived from the width through the shared 1.43 ratio and
the cap is applied as a scale factor on BOTH axes. Expectations are therefore expressed in terms of
`FLOATING_WINDOW_OPENING_ASPECT_RATIO` and `FLOATING_WINDOW_STANDARD_HEIGHT_RATIO` rather than as literals.
The "width is deliberately untouched" assertion is no longer true for ordinary dialogs — FN-456 replaced that
contract — so it lives on in the `full-view` cases below, where it still holds exactly.
*/

const minSize = { width: 320, height: 240 };

function boundsOf(height: number, width = 1280): DashboardWindowBounds {
  return { left: 0, top: 64, right: width, bottom: 64 + height, width, height };
}

/** Laptop work area from the operator's report: 1024x768 viewport, 64px header, 36px footer. */
const LAPTOP_WORK_AREA_HEIGHT = 668;
const laptop = boundsOf(LAPTOP_WORK_AREA_HEIGHT, 1024);
const cappedLaptopHeight = Math.round(LAPTOP_WORK_AREA_HEIGHT * FLOATING_WINDOW_STANDARD_HEIGHT_RATIO);

describe("resolveStandardSize opening height cap (FN-418, FN-456 shape)", () => {
  it("caps a tall host default to ~62% of the work area instead of filling it", () => {
    for (const requestedHeight of [720, FLOATING_WINDOW_TASK_STANDARD_HEIGHT]) {
      const size = resolveStandardSize({ width: 800, height: requestedHeight }, minSize, laptop);
      expect(size.height).toBe(cappedLaptopHeight);
      const ratio = size.height / laptop.height;
      expect(ratio).toBeGreaterThanOrEqual(0.6);
      expect(ratio).toBeLessThanOrEqual(0.65);
      // FN-456: the width now follows the capped height through the shared opening ratio.
      expect(size.width).toBe(Math.round(cappedLaptopHeight * FLOATING_WINDOW_OPENING_ASPECT_RATIO));
    }
  });

  it("caps the no-defaultSize fallback and keeps it at the shared ratio", () => {
    const size = resolveStandardSize(undefined, minSize, laptop);
    expect(FLOATING_WINDOW_STANDARD_WIDTH / FLOATING_WINDOW_OPENING_ASPECT_RATIO).toBeGreaterThan(cappedLaptopHeight);
    expect(size.height).toBe(cappedLaptopHeight);
    expect(Math.abs(size.width / size.height - FLOATING_WINDOW_OPENING_ASPECT_RATIO)).toBeLessThan(0.01);
  });

  it("leaves a small dialog default below the cap, at the shared ratio", () => {
    // ConfirmDialog-sized window: already far below the cap, so no scale factor is applied.
    const size = resolveStandardSize({ width: 420, height: 320 }, minSize, laptop);
    expect(size.width).toBe(420);
    expect(size.height).toBe(Math.round(420 / FLOATING_WINDOW_OPENING_ASPECT_RATIO));
    expect(size.height).toBeLessThan(cappedLaptopHeight);
  });

  it("lets minSize win over the proportional cap", () => {
    const bounds = boundsOf(600);
    // Cap would be 372, but the host's declared minimum is the floor.
    expect(resolveStandardSize({ width: 720, height: 720 }, { width: 320, height: 480 }, bounds).height).toBe(480);
  });

  it("keeps the pre-cap behaviour for degenerate work areas", () => {
    // A zero-height work area (jsdom without measured landmarks) still clamps to 0, as before the cap.
    const zero = boundsOf(0);
    expect(resolveStandardSize({ width: 720, height: 720 }, minSize, zero)).toEqual(
      clampFloatingWindowSize({ width: 720, height: 720 }, minSize, zero),
    );

    // A non-finite work area never reaches the cap branch, so the result is exactly the legacy clamp.
    const nonFinite: DashboardWindowBounds = {
      left: 0, top: 0, right: Number.NaN, bottom: Number.NaN, width: Number.NaN, height: Number.NaN,
    };
    const legacy = clampFloatingWindowSize({ width: 720, height: 720 }, minSize, nonFinite);
    const capped = resolveStandardSize({ width: 720, height: 720 }, minSize, nonFinite);
    expect(Number.isNaN(capped.height)).toBe(Number.isNaN(legacy.height));
    expect(Number.isNaN(capped.width)).toBe(Number.isNaN(legacy.width));
  });

  it("lets a short work area have the last word over minSize", () => {
    const shortArea = boundsOf(400);
    expect(resolveStandardSize({ width: 720, height: 720 }, { width: 320, height: 480 }, shortArea).height).toBe(400);
  });
});

/*
FNXC:FloatingWindowGeometry 2026-09-16-05:45:
The FN-418 "width is never capped" contract survives unchanged for the FN-456 integral views, which the
operator exempted from the opening ratio. Keeping the assertion here, re-targeted, is what makes that
exemption a tested promise rather than a side effect.
*/
describe("resolveStandardSize under the full-view policy (FN-456 exemption)", () => {
  it("caps the height alone and leaves the width completely untouched", () => {
    const size = resolveStandardSize({ width: 1368, height: 828 }, minSize, laptop, "full-view");
    expect(size.height).toBe(cappedLaptopHeight);
    expect(size.width).toBe(laptop.width); // clamped only by the live work area, never by the ratio
  });

  it("leaves an integral view that already fits entirely alone", () => {
    const size = resolveStandardSize({ width: 900, height: 380 }, minSize, laptop, "full-view");
    expect(size).toEqual({ width: 900, height: 380 });
  });
});

describe("opening and snapping geometry around the cap", () => {
  it("re-centres the capped opening in the work area", () => {
    const rect = resolveOpeningRect({ defaultSize: { width: 800, height: 720 }, minSize, bounds: laptop });
    expect(rect.size.height).toBe(cappedLaptopHeight);
    expect(rect.position.y).toBe(laptop.top + (laptop.height - rect.size.height) / 2);
    expect(rect.position.x).toBe(laptop.left + (laptop.width - rect.size.width) / 2);
  });

  it("still fills the whole work area when maximized", () => {
    const snapped = resolveSnapRect("maximized", laptop);
    expect(snapped?.size.height).toBe(laptop.height);
    expect(snapped?.size.width).toBe(laptop.width);
  });
});
