import { describe, expect, it } from "vitest";
import { computeFixedMenuPosition, getLayoutViewportSize } from "../fixedMenuPosition";

/*
FNXC:QuickAddDepsMenu 2026-07-25-12:00:
Regression coverage for the Quick Add Deps (and sibling portal) anchor-first geometry:
menus must stay attached to the trigger and shrink height into free space instead of floating
too high when the preferred height does not fit.
*/

describe("computeFixedMenuPosition", () => {
  const baseTrigger = {
    top: 200,
    bottom: 232,
    left: 100,
    width: 80,
  };

  it("attaches the menu immediately below the trigger when space below is ample", () => {
    const position = computeFixedMenuPosition({
      triggerRect: baseTrigger,
      viewportWidth: 1000,
      viewportHeight: 800,
      preferredWidth: 280,
      preferredHeight: 320,
      minWidth: 240,
      gap: 4,
    });

    expect(position.openUpward).toBe(false);
    expect(position.top).toBe(baseTrigger.bottom + 4);
    expect(position.bottom).toBeNull();
    expect(position.left).toBe(baseTrigger.left);
    expect(position.width).toBe(280);
    expect(position.maxHeight).toBe(320);
  });

  it("opens upward attached to the trigger top when space below is short and space above is larger", () => {
    const trigger = { top: 500, bottom: 532, left: 40, width: 72 };
    const position = computeFixedMenuPosition({
      triggerRect: trigger,
      viewportWidth: 800,
      viewportHeight: 600,
      preferredWidth: 280,
      preferredHeight: 320,
      gap: 4,
      verticalPadding: 16,
    });

    expect(position.openUpward).toBe(true);
    expect(position.top).toBeNull();
    expect(position.bottom).toBe(600 - trigger.top + 4);
    expect(position.maxHeight).toBeLessThanOrEqual(320);
    expect(position.maxHeight).toBeGreaterThan(0);
  });

  it("does not float the menu too high when preferred height exceeds free space above (Deps symptom)", () => {
    // Trigger near the bottom; little room below, limited room above vs preferred 320.
    const trigger = { top: 150, bottom: 182, left: 20, width: 64 };
    const viewportHeight = 220;
    const gap = 4;
    const verticalPadding = 16;
    const position = computeFixedMenuPosition({
      triggerRect: trigger,
      viewportWidth: 390,
      viewportHeight,
      preferredWidth: 280,
      preferredHeight: 320,
      gap,
      verticalPadding,
    });

    // Available above after padding+gap: 150 - 16 - 4 = 130.
    // Old math floored maxHeight to 200 and clamped top to verticalPadding (16), detaching the menu.
    expect(position.openUpward).toBe(true);
    expect(position.maxHeight).toBe(130);
    expect(position.top).toBeNull();
    // The CSS bottom offset is height-independent, even when maxHeight shrinks.
    expect(position.bottom).toBe(viewportHeight - trigger.top + gap);
  });

  it("shrinks maxHeight when opening downward into a short viewport instead of lifting top off the trigger", () => {
    const trigger = { top: 40, bottom: 72, left: 16, width: 80 };
    const position = computeFixedMenuPosition({
      triggerRect: trigger,
      viewportWidth: 800,
      viewportHeight: 200,
      preferredWidth: 280,
      preferredHeight: 320,
      gap: 4,
      verticalPadding: 16,
    });

    expect(position.openUpward).toBe(false);
    expect(position.top).toBe(trigger.bottom + 4);
    // spaceBelow = 200 - 72 - 16 - 4 = 108
    expect(position.maxHeight).toBe(108);
  });

  it("clamps a right-side trigger menu inside horizontal padding without changing vertical attachment", () => {
    const trigger = { top: 100, bottom: 132, left: 720, width: 64 };
    const position = computeFixedMenuPosition({
      triggerRect: trigger,
      viewportWidth: 800,
      viewportHeight: 720,
      preferredWidth: 448,
      preferredHeight: 320,
      minWidth: 240,
      horizontalPadding: 16,
      gap: 4,
    });

    expect(position.top).toBe(trigger.bottom + 4);
    expect(position.left).toBeGreaterThanOrEqual(16);
    expect(position.left + position.width).toBeLessThanOrEqual(800 - 16);
    expect(position.width).toBeGreaterThan(64);
  });
});

describe("getLayoutViewportSize", () => {
  it("prefers documentElement client dimensions over window.inner*", () => {
    const size = getLayoutViewportSize(
      { documentElement: { clientWidth: 390, clientHeight: 720 } as HTMLElement },
      { innerWidth: 1000, innerHeight: 900 },
    );
    expect(size).toEqual({ width: 390, height: 720 });
  });

  it("falls back to window.inner* when client dimensions are zero", () => {
    const size = getLayoutViewportSize(
      { documentElement: { clientWidth: 0, clientHeight: 0 } as HTMLElement },
      { innerWidth: 1024, innerHeight: 768 },
    );
    expect(size).toEqual({ width: 1024, height: 768 });
  });
});
