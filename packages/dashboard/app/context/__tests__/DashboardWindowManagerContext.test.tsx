import { describe, expect, it } from "vitest";
import { resolveDashboardWindowBounds } from "../DashboardWindowManagerContext";

/*
FNXC:DashboardWindowBounds 2026-09-14-10:52:
Each shell edge falls back independently. Invalid or absent landmark measurements must not poison valid peers or reintroduce an artificial gutter.
*/
describe("resolveDashboardWindowBounds", () => {
  it("uses exact shell coordinates", () => {
    expect(resolveDashboardWindowBounds({
      viewportWidth: 1280,
      viewportHeight: 800,
      headerRect: { bottom: 64 },
      footerRect: { top: 764 },
      rightDockRect: { left: 980 },
    })).toEqual({ left: 0, top: 64, right: 980, bottom: 764, width: 980, height: 700 });
  });

  it("falls back invalid and absent edges independently to the viewport", () => {
    expect(resolveDashboardWindowBounds({
      viewportWidth: 1280,
      viewportHeight: 800,
      headerRect: { bottom: Number.NaN },
      footerRect: null,
      rightDockRect: { left: Number.POSITIVE_INFINITY },
    })).toEqual({ left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 });
  });

  it("collapses safely when chrome consumes the available height", () => {
    expect(resolveDashboardWindowBounds({
      viewportWidth: 320,
      viewportHeight: 240,
      headerRect: { bottom: 200 },
      footerRect: { top: 100 },
      rightDockRect: { left: -100 },
    })).toEqual({ left: 0, top: 200, right: 0, bottom: 200, width: 0, height: 0 });
  });
});
