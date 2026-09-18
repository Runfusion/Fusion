import { describe, expect, it } from "vitest";
import {
  getTaskPlanningOrExecutionLivenessSignal,
  isPlanningContinuationDispatchClaim,
  isTaskPlanningOrExecutionLive,
  PLANNING_CONTINUATION_DISPATCH_LEASE_OWNER_PREFIX,
  planningContinuationDispatchLeaseOwner,
} from "../agents/planning-execution-liveness.js";

/*
FNXC:PlanningExecutionLiveness 2026-09-17-01:20:
Reimplemented for FN-332's overlap-wait claim/complete gate, which needs to know whether a task's
planner or executor still owns it before publishing a decision. Covers the signal-resolution order
(active session > executing lock > task-active > planning-processor getter > registered probe) and
the dispatch-claim lease-owner helpers.
*/
describe("planning-execution-liveness", () => {
  it("resolves undefined when nothing reports the task live", () => {
    expect(getTaskPlanningOrExecutionLivenessSignal("FN-1", {
      activeSessionRegistry: { pathsForTask: () => [], isPathActive: () => false },
      executingTaskLock: { has: () => false },
      isTaskActive: () => false,
      getPlanningTaskIds: () => new Set(),
      isPlanningLive: () => false,
    })).toBeUndefined();
    expect(isTaskPlanningOrExecutionLive("FN-1", {
      activeSessionRegistry: { pathsForTask: () => [], isPathActive: () => false },
      executingTaskLock: { has: () => false },
    })).toBe(false);
  });

  it("prefers active-session over every other signal", () => {
    const signal = getTaskPlanningOrExecutionLivenessSignal("FN-1", {
      activeSessionRegistry: { pathsForTask: () => ["/work/fn-1"], isPathActive: (p) => p === "/work/fn-1" },
      executingTaskLock: { has: () => true },
      isTaskActive: () => true,
    });
    expect(signal).toBe("active-session");
  });

  it("falls through to executing-lock, then task-active, then planning-processor, then planning-probe", () => {
    expect(getTaskPlanningOrExecutionLivenessSignal("FN-1", {
      activeSessionRegistry: { pathsForTask: () => [], isPathActive: () => false },
      executingTaskLock: { has: () => true },
    })).toBe("executing-lock");

    expect(getTaskPlanningOrExecutionLivenessSignal("FN-1", {
      activeSessionRegistry: { pathsForTask: () => [], isPathActive: () => false },
      executingTaskLock: { has: () => false },
      isTaskActive: () => true,
    })).toBe("task-active");

    expect(getTaskPlanningOrExecutionLivenessSignal("FN-1", {
      activeSessionRegistry: { pathsForTask: () => [], isPathActive: () => false },
      executingTaskLock: { has: () => false },
      getPlanningTaskIds: () => new Set(["FN-1"]),
    })).toBe("planning-processor");

    expect(getTaskPlanningOrExecutionLivenessSignal("FN-1", {
      activeSessionRegistry: { pathsForTask: () => [], isPathActive: () => false },
      executingTaskLock: { has: () => false },
      isPlanningLive: (id) => id === "FN-1",
    })).toBe("planning-probe");
  });

  it("fails closed (treats as live) when the planning-processor getter throws", () => {
    expect(getTaskPlanningOrExecutionLivenessSignal("FN-1", {
      activeSessionRegistry: { pathsForTask: () => [], isPathActive: () => false },
      executingTaskLock: { has: () => false },
      getPlanningTaskIds: () => { throw new Error("boom"); },
    })).toBe("planning-processor");
  });

  it("derives a stable, prefixed lease owner from item id + attempt", () => {
    const owner = planningContinuationDispatchLeaseOwner({ id: "item-1", attempt: 2 });
    expect(owner).toBe(`${PLANNING_CONTINUATION_DISPATCH_LEASE_OWNER_PREFIX}item-1:2`);
    expect(isPlanningContinuationDispatchClaim({ state: "running", leaseOwner: owner })).toBe(true);
    expect(isPlanningContinuationDispatchClaim({ state: "running", leaseOwner: "someone-else" })).toBe(false);
    expect(isPlanningContinuationDispatchClaim({ state: "held", leaseOwner: owner })).toBe(false);
  });
});
