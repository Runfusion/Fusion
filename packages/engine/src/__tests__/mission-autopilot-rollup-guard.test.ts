/*
FNXC:MissionStatusRollup 2026-08-13-22:40:
Engine cascade and terminal-reconcile tests use a stateful store seam that applies the same core
ownership predicate as persistence. This proves both engine entry points preserve blocked and
archived intent while an unprotected sibling rollup is still written and emits its status-change event.
*/
import { ROLLUP_OWNED_MILESTONE_STATUSES, ROLLUP_OWNED_MISSION_STATUSES, shouldApplyRecomputedStatus } from "../../../core/src/missions/mission-types.js";
import { describe, expect, it, vi } from "vitest";
import { MissionAutopilot } from "../missions/mission-autopilot.js";
import { reconcileMissionState } from "../missions/mission-state-reconcile.js";

const taskStore = {
  on: vi.fn(),
  off: vi.fn(),
  getSettings: vi.fn(),
  getLatestSpecDriftReport: vi.fn().mockResolvedValue(undefined),
  listTasks: vi.fn().mockResolvedValue([]),
};

function rollupStore(status: "blocked" | "archived" = "blocked") {
  const mission = { id: "M-1", title: "Protected", status, autopilotEnabled: true, autopilotState: "inactive" };
  const milestone = { id: "MS-1", missionId: mission.id, title: "Protected milestone", status: "blocked" };
  const controlMilestone = { id: "MS-2", missionId: mission.id, title: "Control milestone", status: "planning" };
  const slice = { id: "S-1", milestoneId: milestone.id, title: "Derived slice", status: "pending", features: [{ id: "F-1", sliceId: "S-1", title: "Protected terminal feature", taskId: "T-1", status: "defined" }] };
  const controlSlice = { id: "S-2", milestoneId: controlMilestone.id, title: "Control slice", status: "pending", features: [{ id: "F-2", sliceId: "S-2", title: "Control terminal feature", taskId: "T-2", status: "defined" }] };
  const events: Array<{ entity: "mission" | "milestone"; id: string }> = [];
  const milestones = [milestone, controlMilestone];
  const slices = [slice, controlSlice];
  const recomputeMission = () => {
    const computed = milestones.every((candidate) => candidate.status === "complete") ? "complete" : milestones.some((candidate) => candidate.status === "active" || candidate.status === "complete") ? "active" : "planning";
    if (shouldApplyRecomputedStatus(mission.status, computed, ROLLUP_OWNED_MISSION_STATUSES)) {
      mission.status = computed;
      events.push({ entity: "mission", id: mission.id });
    }
  };
  const recomputeMilestone = (candidate: typeof milestone) => {
    const computed = slices.filter((item) => item.milestoneId === candidate.id).every((item) => item.status === "complete") ? "complete" : "planning";
    if (shouldApplyRecomputedStatus(candidate.status, computed, ROLLUP_OWNED_MILESTONE_STATUSES)) {
      candidate.status = computed;
      events.push({ entity: "milestone", id: candidate.id });
      recomputeMission();
    }
  };
  return {
    mission,
    milestone,
    controlMilestone,
    events,
    getMission: vi.fn().mockImplementation(async () => mission),
    listMissions: vi.fn().mockResolvedValue([mission]),
    getMissionWithHierarchy: vi.fn().mockImplementation(async () => ({ ...mission, milestones: milestones.map((candidate) => ({ ...candidate, slices: slices.filter((item) => item.milestoneId === candidate.id) })) })),
    listMilestones: vi.fn().mockResolvedValue(milestones),
    updateMission: vi.fn(),
    updateSlice: vi.fn().mockImplementation(async (id: string, updates: { status: string }) => {
      const target = slices.find((candidate) => candidate.id === id)!;
      target.status = updates.status;
      recomputeMilestone(milestones.find((candidate) => candidate.id === target.milestoneId)!);
      return target;
    }),
    computeSliceStatus: vi.fn().mockResolvedValue("complete"),
    updateFeatureStatus: vi.fn().mockImplementation(async (featureId: string, status: string) => {
      const target = slices.flatMap((candidate) => candidate.features.map((feature) => ({ slice: candidate, feature }))).find(({ feature }) => feature.id === featureId);
      if (!target) throw new Error("feature not found");
      target.feature.status = status;
      target.slice.status = "complete";
      recomputeMilestone(milestones.find((candidate) => candidate.id === target.slice.milestoneId)!);
      return target.feature;
    }),
    reconcileFeatureDoneWithTerminalTask: vi.fn().mockImplementation(async (featureId: string, taskId: string) => {
      const target = slices.flatMap((candidate) => candidate.features.map((feature) => ({ slice: candidate, feature }))).find(({ feature }) => feature.id === featureId);
      if (!target || target.feature.taskId !== taskId) throw new Error("terminal feature mismatch");
      target.feature.status = "done";
      target.slice.status = "complete";
      recomputeMilestone(milestones.find((candidate) => candidate.id === target.slice.milestoneId)!);
      return target.feature;
    }),
    on: vi.fn(),
    off: vi.fn(),
  };
}

describe("MissionAutopilot rollup ownership", () => {
  it("preserves protected mission and milestone intent while persisting an unprotected cascade", async () => {
    const store = rollupStore();
    const autopilot = new MissionAutopilot(taskStore as never, store as never);

    await (autopilot as any).recomputeMissionStatusChain(store.mission.id);

    expect(store.updateSlice).toHaveBeenCalledWith("S-1", { status: "complete" });
    expect(store.updateSlice).toHaveBeenCalledWith("S-2", { status: "complete" });
    expect(store.mission.status).toBe("blocked");
    expect(store.milestone.status).toBe("blocked");
    expect(store.controlMilestone.status).toBe("complete");
    expect(store.events).toEqual([{ entity: "milestone", id: store.controlMilestone.id }]);
    expect(store.updateMission).not.toHaveBeenCalled();
    autopilot.stop();
  });

  it.each(["blocked", "archived"] as const)("does not start a protected %s mission", async (status) => {
    const store = rollupStore(status);
    const autopilot = new MissionAutopilot(taskStore as never, store as never);

    await autopilot.checkAndStartMission(store.mission.id);

    expect(store.updateMission).not.toHaveBeenCalled();
    expect(store.mission.status).toBe(status);
    autopilot.stop();
  });

  it("reconciles live Complete tasks without clobbering protected intent", async () => {
    const store = rollupStore();
    const reconciliationTaskStore = {
      ...taskStore,
      getTask: vi.fn().mockImplementation(async (id: string) => ({ id, column: "done" })),
    };

    const result = await reconcileMissionState({ taskStore: reconciliationTaskStore as never, missionStore: store }, { source: "self-healing" });

    expect(store.updateFeatureStatus).toHaveBeenCalledTimes(2);
    expect(store.updateFeatureStatus).toHaveBeenCalledWith("F-1", "done", expect.anything());
    expect(store.updateFeatureStatus).toHaveBeenCalledWith("F-2", "done", expect.anything());
    expect(store.reconcileFeatureDoneWithTerminalTask).not.toHaveBeenCalled();
    expect(result.statusUpdates).toBe(2);
    expect(result.terminalRepairs).toBe(0);
    expect(store.mission.status).toBe("blocked");
    expect(store.milestone.status).toBe("blocked");
    expect(store.controlMilestone.status).toBe("complete");
    expect(store.events).toEqual([{ entity: "milestone", id: store.controlMilestone.id }]);
    expect(store.updateMission).not.toHaveBeenCalled();
  });
});
