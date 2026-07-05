/*
FNXC:PlannerOversight 2026-07-04-17:00:
FN-7517 focused coverage for the `PlannerRecoveryController` last-action
inspection seam: `getLastAction` reflects a dispatched bounded-recovery
action, `recordManualAction` records an operator-driven action (nudge/stop)
without consuming the autonomous attempt budget, and `clear` releases both.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { PlannerRecoveryController, type PlannerRecoveryHandlers } from "../planner-recovery-controller.js";
import type { OverseerStageObservation, OverseerWatchedStage } from "../planner-overseer.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "in-progress",
    ...overrides,
  } as Task;
}

function observation(overrides: Partial<OverseerStageObservation> = {}): OverseerStageObservation {
  return {
    taskId: "FN-1",
    stage: "executor" as OverseerWatchedStage,
    signal: "failed",
    oversightLevel: "autonomous",
    observedAt: Date.now(),
    reason: "test",
    sources: [],
    ...overrides,
  };
}

function makeController(
  obs: OverseerStageObservation | null,
  handlers: PlannerRecoveryHandlers = {},
): PlannerRecoveryController {
  return new PlannerRecoveryController({
    snapshotProvider: { getSnapshot: () => obs },
    handlers,
  });
}

describe("PlannerRecoveryController manual-action tracking (FN-7517)", () => {
  it("getLastAction reflects the last dispatched bounded-recovery action", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { retryStep });

    expect(controller.getLastAction("FN-1", "executor")).toBeUndefined();
    await controller.tick(task());
    expect(controller.getLastAction("FN-1", "executor")).toBe("retry_step");
  });

  it("recordManualAction records an operator action without consuming the attempt budget", () => {
    const controller = makeController(null);

    expect(controller.getAttemptCount("FN-1", "executor")).toBe(0);
    controller.recordManualAction("FN-1", "executor", "manual_nudge");
    expect(controller.getLastAction("FN-1", "executor")).toBe("manual_nudge");
    expect(controller.getAttemptCount("FN-1", "executor")).toBe(0);
  });

  it("recordManualAction for stop overwrites a prior autonomous last-action label", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { retryStep });
    await controller.tick(task());
    expect(controller.getLastAction("FN-1", "executor")).toBe("retry_step");

    controller.recordManualAction("FN-1", "executor", "manual_stop");
    expect(controller.getLastAction("FN-1", "executor")).toBe("manual_stop");
  });

  it("clear releases the last-action registry for a task", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { retryStep });
    await controller.tick(task());
    expect(controller.getLastAction("FN-1", "executor")).toBe("retry_step");

    controller.clear("FN-1");
    expect(controller.getLastAction("FN-1", "executor")).toBeUndefined();
  });
});
