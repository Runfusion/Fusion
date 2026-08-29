import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/db.js";
import { MissionStore } from "../missions/mission-store.js";
import {
  MILESTONE_STATUSES,
  MISSION_STATUSES,
  ROLLUP_OWNED_MILESTONE_STATUSES,
  ROLLUP_OWNED_MISSION_STATUSES,
  SLICE_STATUSES,
  shouldApplyRecomputedStatus,
} from "../missions/mission-types.js";

describe("shouldApplyRecomputedStatus", () => {
  it("skips identical statuses", () => {
    expect(shouldApplyRecomputedStatus("active", "active", ROLLUP_OWNED_MISSION_STATUSES)).toBe(false);
  });

  it("updates each rollup-owned mission and milestone status when the computed value differs", () => {
    for (const current of ROLLUP_OWNED_MISSION_STATUSES) {
      for (const computed of ROLLUP_OWNED_MISSION_STATUSES) {
        expect(shouldApplyRecomputedStatus(current, computed, ROLLUP_OWNED_MISSION_STATUSES))
          .toBe(current !== computed);
      }
    }
    for (const current of ROLLUP_OWNED_MILESTONE_STATUSES) {
      for (const computed of ROLLUP_OWNED_MILESTONE_STATUSES) {
        expect(shouldApplyRecomputedStatus(current, computed, ROLLUP_OWNED_MILESTONE_STATUSES))
          .toBe(current !== computed);
      }
    }
  });

  it("keeps protected no-op computations and excludes protected statuses from rollup ownership", () => {
    expect(shouldApplyRecomputedStatus("blocked", "blocked", ROLLUP_OWNED_MISSION_STATUSES)).toBe(false);
    expect(shouldApplyRecomputedStatus("archived", "archived", ROLLUP_OWNED_MISSION_STATUSES)).toBe(false);
    expect(shouldApplyRecomputedStatus("blocked", "blocked", ROLLUP_OWNED_MILESTONE_STATUSES)).toBe(false);
    expect(ROLLUP_OWNED_MISSION_STATUSES).toEqual(["planning", "active", "complete"]);
    expect(ROLLUP_OWNED_MILESTONE_STATUSES).toEqual(["planning", "active", "complete"]);
    expect(ROLLUP_OWNED_MISSION_STATUSES).not.toContain("blocked");
    expect(ROLLUP_OWNED_MISSION_STATUSES).not.toContain("archived");
    expect(ROLLUP_OWNED_MILESTONE_STATUSES).not.toContain("blocked");
  });

  it("preserves mission statuses outside automatic rollup ownership", () => {
    for (const current of MISSION_STATUSES.filter((status) => !ROLLUP_OWNED_MISSION_STATUSES.includes(status))) {
      for (const computed of ROLLUP_OWNED_MISSION_STATUSES) {
        expect(shouldApplyRecomputedStatus(current, computed, ROLLUP_OWNED_MISSION_STATUSES)).toBe(false);
      }
    }
  });

  it("preserves milestone statuses outside automatic rollup ownership", () => {
    for (const current of MILESTONE_STATUSES.filter((status) => !ROLLUP_OWNED_MILESTONE_STATUSES.includes(status))) {
      for (const computed of ROLLUP_OWNED_MILESTONE_STATUSES) {
        expect(shouldApplyRecomputedStatus(current, computed, ROLLUP_OWNED_MILESTONE_STATUSES)).toBe(false);
      }
    }
  });

  it("keeps slice rollup fully owned", () => {
    expect(SLICE_STATUSES).toEqual(["pending", "active", "complete"]);
  });
});

describe("MissionStore synchronous rollup guard", () => {
  const createStore = () => new MissionStore("/tmp/fusion-mission-store-test", {
    prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    bumpLastModified: vi.fn(),
  } as unknown as Database);

  it("preserves blocked and archived mission intent while updating rollup-owned rows", () => {
    const store = createStore();
    const updateMission = vi.spyOn(store, "updateMission").mockImplementation((id, updates) => ({ id, ...updates } as never));
    vi.spyOn(store, "computeMissionStatus").mockReturnValue("active");
    vi.spyOn(store, "getMission").mockReturnValue({ id: "M-1", status: "blocked" } as never);
    (store as any).recomputeMissionStatus("M-1");
    vi.spyOn(store, "getMission").mockReturnValue({ id: "M-2", status: "archived" } as never);
    (store as any).recomputeMissionStatus("M-2");
    vi.spyOn(store, "getMission").mockReturnValue({ id: "M-3", status: "planning" } as never);
    (store as any).recomputeMissionStatus("M-3");
    expect(updateMission).toHaveBeenCalledTimes(1);
    expect(updateMission).toHaveBeenCalledWith("M-3", { status: "active" });
  });

  it("preserves blocked milestones while updating rollup-owned rows", () => {
    const store = createStore();
    const updateMilestone = vi.spyOn(store, "updateMilestone").mockImplementation((id, updates) => ({ id, ...updates } as never));
    vi.spyOn(store, "computeMilestoneStatus").mockReturnValue("complete");
    vi.spyOn(store, "getMilestone").mockReturnValue({ id: "MS-1", status: "blocked" } as never);
    (store as any).recomputeMilestoneStatus("MS-1");
    vi.spyOn(store, "getMilestone").mockReturnValue({ id: "MS-2", status: "active" } as never);
    (store as any).recomputeMilestoneStatus("MS-2");
    expect(updateMilestone).toHaveBeenCalledTimes(1);
    expect(updateMilestone).toHaveBeenCalledWith("MS-2", { status: "complete" });
  });
});
