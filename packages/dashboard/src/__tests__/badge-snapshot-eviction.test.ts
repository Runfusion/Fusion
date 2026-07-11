import { describe, expect, it } from "vitest";
import { isBadgeEligibleTask } from "../server.js";

/*
FNXC:BadgeSnapshotEviction 2026-07-10-15:00:
Regression for the slow badge-cache memory leak: archived tasks were re-cached on
task:updated but only evicted on hard-delete, so they accumulated for the daemon's
lifetime. The badge cache is board-scoped — archived tasks must be ineligible so both
the create and update listeners evict rather than retain them.
*/
describe("isBadgeEligibleTask", () => {
  it("excludes archived tasks from the live-board badge cache", () => {
    expect(isBadgeEligibleTask({ column: "archived" })).toBe(false);
  });

  it("includes tasks on any live board column", () => {
    for (const column of ["todo", "in-progress", "in-review", "done"] as const) {
      expect(isBadgeEligibleTask({ column })).toBe(true);
    }
  });
});
