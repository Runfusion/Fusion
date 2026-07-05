/**
 * FNXC:PlannerOverseer 2026-07-04-15:00:
 * FN-7514 Symptom Verification: for a user-paused task AND an auto-merge-off
 * / human-review task with a pending recoverable condition, NO action
 * handler may fire (bounded-recovery, retry, and pending-confirmation all
 * withheld), and a `recordHumanControlWithheld` no-action notification must
 * be delivered with the correct reason. Also asserts a non-paused,
 * auto-merge-eligible task still receives normal oversight (guard does not
 * over-block), and that the invariant holds across every watched stage the
 * seam exposes (not only in-review/merger).
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
    column: "in-review",
    ...overrides,
  } as Task;
}

function observation(overrides: Partial<OverseerStageObservation> = {}): OverseerStageObservation {
  return {
    taskId: "FN-1",
    stage: "merger" as OverseerWatchedStage,
    signal: "failed",
    oversightLevel: "autonomous",
    observedAt: Date.now(),
    reason: "test",
    sources: [],
    ...overrides,
  };
}

function allHandlers() {
  return {
    injectGuidance: vi.fn().mockResolvedValue(undefined),
    retryStep: vi.fn().mockResolvedValue(undefined),
    requestTargetedFix: vi.fn().mockResolvedValue(undefined),
    requestConfirmation: vi.fn().mockResolvedValue(undefined),
    executeMergePrAction: vi.fn().mockResolvedValue(undefined),
    executeDestructiveExternalAction: vi.fn().mockResolvedValue(undefined),
    recordHumanControlWithheld: vi.fn().mockResolvedValue(undefined),
  } satisfies PlannerRecoveryHandlers;
}

function makeController(obs: OverseerStageObservation | null, handlers: PlannerRecoveryHandlers) {
  return new PlannerRecoveryController({
    snapshotProvider: { getSnapshot: () => obs },
    handlers,
  });
}

const WATCHED_STAGES: OverseerWatchedStage[] = ["executor", "reviewer", "merger", "pull-request", "workflow-gate"];

describe("PlannerRecoveryController — human-control guard (FN-7514)", () => {
  it("is fully inert for a user-paused task with a pending recoverable/confirmation-required condition", async () => {
    const handlers = allHandlers();
    const controller = makeController(observation({ stage: "merger" }), handlers);

    const decision = await controller.tick(task({ userPaused: true }));

    expect(decision).toBeNull();
    expect(handlers.injectGuidance).not.toHaveBeenCalled();
    expect(handlers.retryStep).not.toHaveBeenCalled();
    expect(handlers.requestTargetedFix).not.toHaveBeenCalled();
    expect(handlers.requestConfirmation).not.toHaveBeenCalled();
    expect(handlers.executeMergePrAction).not.toHaveBeenCalled();
    expect(handlers.executeDestructiveExternalAction).not.toHaveBeenCalled();
    expect(controller.getPendingConfirmations("FN-1")).toEqual([]);

    expect(handlers.recordHumanControlWithheld).toHaveBeenCalledTimes(1);
    const [withheldTask, withheldDecision] = handlers.recordHumanControlWithheld.mock.calls[0]!;
    expect(withheldTask.id).toBe("FN-1");
    expect(withheldDecision.reason).toBe("user-paused");
  });

  it("is fully inert for an auto-merge-off / human-review task with a pending recoverable condition", async () => {
    const handlers = allHandlers();
    const controller = makeController(observation({ stage: "merger" }), handlers);

    const decision = await controller.tick(task({ autoMerge: undefined }), { settings: { autoMerge: false } });

    expect(decision).toBeNull();
    expect(handlers.injectGuidance).not.toHaveBeenCalled();
    expect(handlers.retryStep).not.toHaveBeenCalled();
    expect(handlers.requestTargetedFix).not.toHaveBeenCalled();
    expect(handlers.requestConfirmation).not.toHaveBeenCalled();
    expect(handlers.executeMergePrAction).not.toHaveBeenCalled();
    expect(handlers.executeDestructiveExternalAction).not.toHaveBeenCalled();
    expect(controller.getPendingConfirmations("FN-1")).toEqual([]);

    expect(handlers.recordHumanControlWithheld).toHaveBeenCalledTimes(1);
    const [, withheldDecision] = handlers.recordHumanControlWithheld.mock.calls[0]!;
    expect(withheldDecision.reason).toBe("auto-merge-off-human-review");
  });

  // FN-7521: Move-Task hard-cancel contract (AGENTS.md "Move-Task contract") —
  // `moveTask(in-progress -> todo)` is a hard cancel. `resolveWatchedStage`
  // (packages/engine/src/planner-overseer.ts, covered in planner-overseer.test.ts)
  // already proves `todo` is a non-monitorable column that yields a `null`
  // observation. This test proves the OTHER half of the composition end to
  // end through the recovery controller: once a task is back in `todo` and
  // its snapshot provider reports no observation (exactly what a real
  // `PlannerOverseerMonitor.observeTask()` call returns post hard-cancel),
  // `tick()` takes no action of any kind — not even a human-control-withheld
  // notification, since there's nothing pending to withhold.
  it("is inert with no action and no withheld-notification for a hard-cancelled task back in todo (obs: null)", async () => {
    const handlers = allHandlers();
    const controller = makeController(null, handlers);

    const decision = await controller.tick(task({ column: "todo", userPaused: false }));

    expect(decision).toBeNull();
    expect(handlers.injectGuidance).not.toHaveBeenCalled();
    expect(handlers.retryStep).not.toHaveBeenCalled();
    expect(handlers.requestTargetedFix).not.toHaveBeenCalled();
    expect(handlers.requestConfirmation).not.toHaveBeenCalled();
    expect(handlers.executeMergePrAction).not.toHaveBeenCalled();
    expect(handlers.executeDestructiveExternalAction).not.toHaveBeenCalled();
    expect(handlers.recordHumanControlWithheld).not.toHaveBeenCalled();
    expect(controller.getPendingConfirmations("FN-1")).toEqual([]);
  });

  it("holds the guard across every watched stage the seam exposes, not only in-review/merger", async () => {
    for (const stage of WATCHED_STAGES) {
      const handlers = allHandlers();
      const controller = makeController(observation({ stage }), handlers);

      const decision = await controller.tick(task({ userPaused: true }));

      expect(decision, `stage=${stage}`).toBeNull();
      expect(handlers.injectGuidance, `stage=${stage}`).not.toHaveBeenCalled();
      expect(handlers.retryStep, `stage=${stage}`).not.toHaveBeenCalled();
      expect(handlers.requestTargetedFix, `stage=${stage}`).not.toHaveBeenCalled();
      expect(handlers.requestConfirmation, `stage=${stage}`).not.toHaveBeenCalled();
    }
  });

  it("does NOT re-emit recordHumanControlWithheld on repeated ticks for the same still-withheld reason", async () => {
    const handlers = allHandlers();
    const controller = makeController(observation({ stage: "merger" }), handlers);

    await controller.tick(task({ userPaused: true }));
    await controller.tick(task({ userPaused: true }));
    await controller.tick(task({ userPaused: true }));

    expect(handlers.recordHumanControlWithheld).toHaveBeenCalledTimes(1);
  });

  it("re-emits recordHumanControlWithheld when the withheld reason changes", async () => {
    const handlers = allHandlers();
    const controller = makeController(observation({ stage: "merger" }), handlers);

    await controller.tick(task({ userPaused: true }));
    await controller.tick(task({}), { settings: { autoMerge: false } });

    expect(handlers.recordHumanControlWithheld).toHaveBeenCalledTimes(2);
    expect(handlers.recordHumanControlWithheld.mock.calls[0]![1].reason).toBe("user-paused");
    expect(handlers.recordHumanControlWithheld.mock.calls[1]![1].reason).toBe("auto-merge-off-human-review");
  });

  it("still delivers normal oversight for a non-paused, auto-merge-eligible task (guard does not over-block)", async () => {
    const handlers = allHandlers();
    const controller = makeController(observation({ stage: "merger" }), handlers);

    const decision = await controller.tick(task(), { settings: { autoMerge: true } });

    // Not withheld: the normal decidePlannerRecovery path runs.
    expect(handlers.recordHumanControlWithheld).not.toHaveBeenCalled();
    expect(decision).not.toBeNull();
  });

  it("clear(taskId) resets the withheld-reason dedup so a later re-entry re-emits", async () => {
    const handlers = allHandlers();
    const controller = makeController(observation({ stage: "merger" }), handlers);

    await controller.tick(task({ userPaused: true }));
    controller.clear("FN-1");
    await controller.tick(task({ userPaused: true }));

    expect(handlers.recordHumanControlWithheld).toHaveBeenCalledTimes(2);
  });

  it("never throws when recordHumanControlWithheld handler rejects", async () => {
    const handlers = allHandlers();
    handlers.recordHumanControlWithheld = vi.fn().mockRejectedValue(new Error("boom"));
    const controller = makeController(observation({ stage: "merger" }), handlers);

    await expect(controller.tick(task({ userPaused: true }))).resolves.toBeNull();
  });
});
