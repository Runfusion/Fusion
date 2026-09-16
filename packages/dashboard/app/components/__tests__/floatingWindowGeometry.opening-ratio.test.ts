import { describe, expect, it } from "vitest";
import type { DashboardWindowBounds } from "../../context/DashboardWindowManagerContext";
import {
  FLOATING_WINDOW_OPENING_ASPECT_RATIO,
  FLOATING_WINDOW_OPENING_SIZE_SCALE,
  FLOATING_WINDOW_STANDARD_HEIGHT,
  FLOATING_WINDOW_STANDARD_HEIGHT_RATIO,
  FLOATING_WINDOW_STANDARD_WIDTH,
  FLOATING_WINDOW_TASK_STANDARD_HEIGHT,
  FLOATING_WINDOW_TASK_STANDARD_WIDTH,
  clampFloatingWindowSize,
  resolveDetachedRect,
  resolveSnapRect,
  resolveStandardSize,
} from "../floatingWindowGeometry";

/*
FNXC:FloatingWindowGeometry 2026-09-16-05:45:
FN-456 unit contract. The operator asked that EVERY modal open at the same 1.43 landscape shape, so this suite
asserts the INVARIANT across a representative sample of real host `defaultSize` declarations and two work
areas — not a single reproduction. It also pins the deliberate exceptions, because a rule with silent
exceptions is indistinguishable from a broken rule: `minSize` and the live work area keep the last word, and
manual/snap/detach trajectories are never normalized.

FNXC:FloatingWindowGeometry 2026-09-16-07:38:
FN-460 keeps every FN-456 invariant and adds its own: the opening box is 20% larger on BOTH axes, so the
shape is unchanged while the window is bigger. The expectations below are therefore expressed through
`FLOATING_WINDOW_OPENING_SIZE_SCALE` rather than as literals, and the `minSize` negative control had to be
re-targeted at a shorter work area — on the previous one the enlarged ratio box cleared the minimum, so the
"the ratio is deliberately broken" assertion would have become a false green.
*/

const minSize = { width: 320, height: 240 };

function boundsOf(height: number, width: number): DashboardWindowBounds {
  return { left: 0, top: 64, right: width, bottom: 64 + height, width, height };
}

/** Desktop work area (1440x900 viewport minus header/footer) and the FN-418 laptop report area. */
const desktop = boundsOf(836, 1440);
const laptop = boundsOf(668, 1024);

/** Real host `defaultSize` declarations sampled across the whole span of shapes shipped today. */
const HOST_DEFAULTS: Array<[string, { width: number; height: number }]> = [
  ["ConfirmDialog", { width: 520, height: 320 }],
  ["CreateRoomModal", { width: 640, height: 640 }],
  ["task/chat standard", { width: FLOATING_WINDOW_TASK_STANDARD_WIDTH, height: FLOATING_WINDOW_TASK_STANDARD_HEIGHT }],
  ["WorkflowResultsTab", { width: 900, height: 660 }],
  ["RightDockExpandModal", { width: 960, height: 600 }],
  ["SettingsModal", { width: 1100, height: 720 }],
  ["GitHubImportModal", { width: 1200, height: 720 }],
];

function ratioOf(size: { width: number; height: number }): number {
  return size.width / size.height;
}

describe("FN-456 opening aspect ratio invariant", () => {
  it.each(HOST_DEFAULTS)("opens %s at the shared 1.43 ratio on a desktop work area", (_name, defaultSize) => {
    const size = resolveStandardSize(defaultSize, minSize, desktop);
    expect(Math.abs(ratioOf(size) - FLOATING_WINDOW_OPENING_ASPECT_RATIO)).toBeLessThan(0.01);
    // No clamp is active here: the window fits the work area and clears minSize.
    expect(size.width).toBeLessThanOrEqual(desktop.width);
    expect(size.height).toBeGreaterThan(minSize.height);
  });

  it.each(HOST_DEFAULTS)("opens %s at the shared 1.43 ratio on a laptop work area", (_name, defaultSize) => {
    const size = resolveStandardSize(defaultSize, minSize, laptop);
    expect(Math.abs(ratioOf(size) - FLOATING_WINDOW_OPENING_ASPECT_RATIO)).toBeLessThan(0.01);
  });

  it("applies the ratio to the no-defaultSize fallback too, at the FN-460 enlarged size", () => {
    const size = resolveStandardSize(undefined, minSize, desktop);
    expect(Math.abs(ratioOf(size) - FLOATING_WINDOW_OPENING_ASPECT_RATIO)).toBeLessThan(0.01);
    // FN-460: the host's standard width is a scaled BASE now, no longer the opening width itself.
    expect(size.width).toBe(Math.round(FLOATING_WINDOW_STANDARD_WIDTH * FLOATING_WINDOW_OPENING_SIZE_SCALE));
    expect(size.height).toBe(
      Math.round((FLOATING_WINDOW_STANDARD_WIDTH * FLOATING_WINDOW_OPENING_SIZE_SCALE) / FLOATING_WINDOW_OPENING_ASPECT_RATIO),
    );
    expect(size.width).toBeGreaterThan(FLOATING_WINDOW_STANDARD_WIDTH);
    expect(size.height).toBeGreaterThan(FLOATING_WINDOW_STANDARD_HEIGHT);
  });

  /*
  FNXC:FloatingWindowGeometry 2026-09-16-07:38:
  FN-460 central invariant, asserted across the SAME representative host sample rather than on one repro:
  wherever no clamp binds, every host opens at exactly 1.2x its pre-FN-460 rectangle and keeps the 1.43 shape.
  The pre-FN-460 rectangle is recomputed locally from the ratio constant, so this case compares the seam
  against the formula it replaced instead of against a frozen literal.
  */
  it.each(HOST_DEFAULTS)("opens %s exactly 20%% larger than pre-FN-460 when nothing clamps", (_name, defaultSize) => {
    // Tall and wide enough that neither the proportional cap, the work-area width, nor minSize can bind.
    const roomy = boundsOf(1400, 2400);
    const size = resolveStandardSize(defaultSize, minSize, roomy);
    const legacyWidth = defaultSize.width;
    const legacyHeight = Math.round(defaultSize.width / FLOATING_WINDOW_OPENING_ASPECT_RATIO);
    expect(Math.abs(size.width - legacyWidth * FLOATING_WINDOW_OPENING_SIZE_SCALE)).toBeLessThanOrEqual(1);
    expect(Math.abs(size.height - legacyHeight * FLOATING_WINDOW_OPENING_SIZE_SCALE)).toBeLessThanOrEqual(1);
    expect(Math.abs(ratioOf(size) - FLOATING_WINDOW_OPENING_ASPECT_RATIO)).toBeLessThan(0.01);
  });

  it("derives both standard heights from the shared ratio so no literal can drift", () => {
    expect(FLOATING_WINDOW_STANDARD_HEIGHT).toBe(Math.round(FLOATING_WINDOW_STANDARD_WIDTH / FLOATING_WINDOW_OPENING_ASPECT_RATIO));
    expect(FLOATING_WINDOW_TASK_STANDARD_HEIGHT).toBe(Math.round(FLOATING_WINDOW_TASK_STANDARD_WIDTH / FLOATING_WINDOW_OPENING_ASPECT_RATIO));
  });

  it("treats an omitted opening policy exactly like the explicit aspect-ratio policy", () => {
    const defaultSize = { width: 1100, height: 720 };
    expect(resolveStandardSize(defaultSize, minSize, laptop)).toEqual(
      resolveStandardSize(defaultSize, minSize, laptop, "aspect-ratio"),
    );
  });

  it("keeps the FN-418 proportional height cap, carried by the FN-460 factor, while preserving the shape", () => {
    // A 1200-wide host on the laptop area would want 839px of height; the effective cap is 62% x 1.2 = 74.4%.
    const effectiveCap =
      Math.round(laptop.height * FLOATING_WINDOW_STANDARD_HEIGHT_RATIO) * FLOATING_WINDOW_OPENING_SIZE_SCALE;
    const size = resolveStandardSize({ width: 1200, height: 720 }, minSize, laptop);
    expect(size.height).toBeLessThanOrEqual(Math.round(effectiveCap));
    // FN-418's own intent survives FN-460: a window still never fills the band between header and footer.
    expect(size.height).toBeLessThan(laptop.height);
    expect(Math.abs(ratioOf(size) - FLOATING_WINDOW_OPENING_ASPECT_RATIO)).toBeLessThan(0.01);
  });
});

describe("FN-456 deliberate exceptions: the clamps still have the last word", () => {
  it("lets a larger minSize break the ratio rather than open unusably small", () => {
    /*
    PrCreateModal-shaped minimum. FN-460 re-targets this case at a SHORTER work area: on the previous 600px
    area the enlarged ratio box already cleared 480x420, so the minimum stopped being the limiting factor and
    the assertion below would have passed for the wrong reason.
    */
    const shortArea = boundsOf(450, 1280);
    const declaredMin = { width: 480, height: 420 };
    const size = resolveStandardSize({ width: 720, height: 720 }, declaredMin, shortArea);
    // The minimum really is what wins here: the result IS the declared minimum on both axes.
    expect(size).toEqual(declaredMin);
    // ... and the ratio box it replaced was genuinely smaller, on both axes.
    const unclamped = resolveStandardSize({ width: 720, height: 720 }, { width: 0, height: 0 }, shortArea);
    expect(unclamped.width).toBeLessThan(declaredMin.width);
    expect(unclamped.height).toBeLessThan(declaredMin.height);
    expect(Math.abs(ratioOf(size) - FLOATING_WINDOW_OPENING_ASPECT_RATIO)).toBeGreaterThan(0.01);
  });

  it("lets a very short work area have the last word over the ratio", () => {
    const shortArea = boundsOf(240, 1280);
    const size = resolveStandardSize({ width: 1100, height: 720 }, { width: 320, height: 480 }, shortArea);
    expect(size.height).toBe(240);
    expect(size.width).toBeLessThanOrEqual(shortArea.width);
  });

  it("never widens a window beyond the live work area to satisfy the ratio", () => {
    const narrow = boundsOf(900, 600);
    const size = resolveStandardSize({ width: 1200, height: 720 }, { width: 320, height: 240 }, narrow);
    expect(size.width).toBeLessThanOrEqual(narrow.width);
  });

  it("keeps the plain-clamp result for degenerate work areas", () => {
    // FN-460: a zero-height area no longer bounds the target scale, so the clamped box is the ENLARGED one.
    const zero = boundsOf(0, 1280);
    const enlarged = {
      width: Math.round(720 * FLOATING_WINDOW_OPENING_SIZE_SCALE),
      height: Math.round((720 * FLOATING_WINDOW_OPENING_SIZE_SCALE) / FLOATING_WINDOW_OPENING_ASPECT_RATIO),
    };
    expect(resolveStandardSize({ width: 720, height: 720 }, minSize, zero)).toEqual(
      clampFloatingWindowSize(enlarged, minSize, zero),
    );

    const nonFinite: DashboardWindowBounds = {
      left: 0, top: 0, right: Number.NaN, bottom: Number.NaN, width: Number.NaN, height: Number.NaN,
    };
    const legacy = clampFloatingWindowSize({ width: 720, height: 720 }, minSize, nonFinite);
    const resolved = resolveStandardSize({ width: 720, height: 720 }, minSize, nonFinite);
    expect(Number.isNaN(resolved.width)).toBe(Number.isNaN(legacy.width));
    expect(Number.isNaN(resolved.height)).toBe(Number.isNaN(legacy.height));
  });
});

describe("FN-456 negative controls: only OPENING is normalized", () => {
  it("does not apply the ratio to any snap zone", () => {
    expect(resolveSnapRect("maximized", desktop)?.size).toEqual({ width: desktop.width, height: desktop.height });
    expect(resolveSnapRect("left", desktop)?.size).toEqual({ width: desktop.width / 2, height: desktop.height });
    expect(resolveSnapRect("right", desktop)?.size).toEqual({ width: desktop.width / 2, height: desktop.height });
  });

  it("restores the captured floating size verbatim when a docked window detaches", () => {
    const restore = { position: { x: 100, y: 120 }, size: { width: 640, height: 600 } };
    const detached = resolveDetachedRect(restore, { x: 400, y: 300 }, minSize, desktop);
    // 640x600 is ~1.07, deliberately NOT normalized: the operator resized it freely.
    expect(detached.size).toEqual({ width: 640, height: 600 });
  });

  it("does not apply the ratio inside the shared size clamp used by manual resize", () => {
    expect(clampFloatingWindowSize({ width: 900, height: 850 }, minSize, desktop)).toEqual({ width: 900, height: 836 });
  });
});
