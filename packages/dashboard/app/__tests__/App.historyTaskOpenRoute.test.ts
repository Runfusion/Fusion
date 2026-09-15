import { describe, expect, it } from "vitest";
import { getCoexistingTaskOpenRoute } from "../App";

/*
FNXC:HistoryModalSurface 2026-09-15-19:12:
FN-428: History is a coexisting FloatingWindow, so activating one of its entries must resolve to a coexisting task
window on desktop/tablet and to the main panel on mobile, where task pop-outs are deliberately purged so a single owner
renders task detail. Both breakpoints are proved here on the pure resolver the production callback consumes.
*/
describe("coexisting task detail routing", () => {
  it("routes a coexisting surface open to a task window on desktop and tablet", () => {
    expect(getCoexistingTaskOpenRoute({ mobileDrawerActive: false })).toBe("task-window");
  });

  it("routes a coexisting surface open to the main panel on mobile", () => {
    expect(getCoexistingTaskOpenRoute({ mobileDrawerActive: true })).toBe("main-panel");
  });
});
