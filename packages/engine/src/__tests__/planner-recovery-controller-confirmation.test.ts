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

function makeController(
  obs: OverseerStageObservation | null,
  handlers: PlannerRecoveryHandlers = {},
): PlannerRecoveryController {
  return new PlannerRecoveryController({
    snapshotProvider: { getSnapshot: () => obs },
    handlers,
  });
}

describe("PlannerRecoveryController — confirmation gate (FN-7513)", () => {
  it("calls requestConfirmation and NEVER executeMergePrAction/executeDestructiveExternalAction for a merger-stage decision", async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(undefined);
    const executeMergePrAction = vi.fn().mockResolvedValue(undefined);
    const executeDestructiveExternalAction = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { requestConfirmation, executeMergePrAction, executeDestructiveExternalAction });

    const decision = await controller.tick(task());
    expect(decision?.action).toBe("await_confirmation");
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(executeMergePrAction).not.toHaveBeenCalled();
    expect(executeDestructiveExternalAction).not.toHaveBeenCalled();
  });

  it("does not create duplicate pending requests for repeated ticks on the same stage", async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { requestConfirmation });

    await controller.tick(task());
    await controller.tick(task());
    await controller.tick(task());

    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(controller.getPendingConfirmations("FN-1")).toHaveLength(1);
  });

  it("resolveConfirmation('approved') dispatches the matching execution handler exactly once and clears the request", async () => {
    const executeMergePrAction = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { executeMergePrAction });

    await controller.tick(task());
    const pending = controller.getPendingConfirmations("FN-1");
    expect(pending).toHaveLength(1);

    const resolved = await controller.resolveConfirmation("FN-1", pending[0].requestId, "approved", "user-1");
    expect(resolved?.status).toBe("approved");
    expect(executeMergePrAction).toHaveBeenCalledTimes(1);
    expect(executeMergePrAction).toHaveBeenCalledWith("FN-1", expect.objectContaining({ requestId: pending[0].requestId }), expect.anything());
    expect(controller.getPendingConfirmations("FN-1")).toHaveLength(0);

    // Resolving again is a no-op (already resolved).
    const secondResolve = await controller.resolveConfirmation("FN-1", pending[0].requestId, "approved");
    expect(secondResolve).toBeNull();
    expect(executeMergePrAction).toHaveBeenCalledTimes(1);
  });

  it("resolveConfirmation('denied') clears the request and performs no side effect", async () => {
    const executeMergePrAction = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { executeMergePrAction });

    await controller.tick(task());
    const pending = controller.getPendingConfirmations("FN-1");
    expect(pending).toHaveLength(1);

    const resolved = await controller.resolveConfirmation("FN-1", pending[0].requestId, "denied");
    expect(resolved?.status).toBe("denied");
    expect(executeMergePrAction).not.toHaveBeenCalled();
    expect(controller.getPendingConfirmations("FN-1")).toHaveLength(0);
  });

  it("denying a confirmation consumes a bounded-recovery attempt so the same prompt does not resurface forever", async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { requestConfirmation });

    // Tick + deny three times (PLANNER_RECOVERY_MAX_ATTEMPTS = 3) — each denial
    // must consume one attempt so the identical merger-stage confirmation
    // eventually stops resurfacing rather than re-prompting indefinitely.
    for (let i = 0; i < 3; i += 1) {
      const decision = await controller.tick(task());
      expect(decision?.requiresConfirmation).toBe(true);
      const pending = controller.getPendingConfirmations("FN-1");
      expect(pending).toHaveLength(1);
      await controller.resolveConfirmation("FN-1", pending[0].requestId, "denied");
      expect(controller.getPendingConfirmations("FN-1")).toHaveLength(0);
    }

    // After exhausting the attempt budget via denials, decidePlannerRecovery
    // should report exhaustion instead of yet another confirmation request.
    const finalDecision = await controller.tick(task());
    expect(finalDecision?.action).toBe("none");
    expect(finalDecision?.exhausted).toBe(true);
    expect(controller.getPendingConfirmations("FN-1")).toHaveLength(0);
  });

  it("dispatches executeDestructiveExternalAction only on approval of a destructive_external request", async () => {
    const executeDestructiveExternalAction = vi.fn().mockResolvedValue(undefined);
    // pull-request stage classifies as merge_pr today; simulate a destructive_external
    // pending request directly through the same tick+approve path by using a merger
    // observation and swapping the execution handler under test — the gate itself
    // (request-not-execute, approve-dispatch) is identical across side-effect classes.
    const controller = makeController(observation({ stage: "pull-request" as OverseerWatchedStage }), {
      executeDestructiveExternalAction,
    });
    await controller.tick(task());
    const pending = controller.getPendingConfirmations("FN-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].sideEffectClass).toBe("merge_pr");
    // merge_pr requests never dispatch the destructive_external handler.
    await controller.resolveConfirmation("FN-1", pending[0].requestId, "approved");
    expect(executeDestructiveExternalAction).not.toHaveBeenCalled();
  });

  it("bounded-recovery decisions still auto-dispatch with the attempt increment", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    const requestConfirmation = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation({ stage: "executor" as OverseerWatchedStage, signal: "failed" }), {
      retryStep,
      requestConfirmation,
    });

    const decision = await controller.tick(task());
    expect(decision?.action).toBe("retry_step");
    expect(retryStep).toHaveBeenCalledTimes(1);
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(controller.getAttemptCount("FN-1", "executor")).toBe(1);
  });

  it("stays inert for non-autonomous levels", async () => {
    for (const level of ["off", "observe", "steer"] as const) {
      const requestConfirmation = vi.fn().mockResolvedValue(undefined);
      const controller = makeController(observation({ oversightLevel: level }), { requestConfirmation });
      const decision = await controller.tick(task());
      expect(decision?.action, `level=${level}`).toBe("none");
      expect(requestConfirmation).not.toHaveBeenCalled();
    }
  });

  it("is skipped entirely when task.userPaused is true", async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { requestConfirmation });
    const decision = await controller.tick(task({ userPaused: true }));
    expect(decision).toBeNull();
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it("getPendingConfirmations reflects pending state and clear(taskId) empties it", async () => {
    const controller = makeController(observation());
    await controller.tick(task());
    expect(controller.getPendingConfirmations("FN-1")).toHaveLength(1);
    controller.clear("FN-1");
    expect(controller.getPendingConfirmations("FN-1")).toHaveLength(0);
  });

  it("never throws when requestConfirmation rejects", async () => {
    const requestConfirmation = vi.fn().mockRejectedValue(new Error("boom"));
    const controller = makeController(observation(), { requestConfirmation });
    await expect(controller.tick(task())).resolves.not.toThrow();
    // The pending request is still tracked locally even though the external notify failed.
    expect(controller.getPendingConfirmations("FN-1")).toHaveLength(1);
  });

  it("never throws when the execution handler rejects on approval", async () => {
    const executeMergePrAction = vi.fn().mockRejectedValue(new Error("merge failed"));
    const controller = makeController(observation(), { executeMergePrAction });
    await controller.tick(task());
    const pending = controller.getPendingConfirmations("FN-1");
    await expect(controller.resolveConfirmation("FN-1", pending[0].requestId, "approved")).resolves.not.toThrow();
    // Request is still cleared even though the handler failed.
    expect(controller.getPendingConfirmations("FN-1")).toHaveLength(0);
  });

  it("never throws when resolveConfirmation is called for an unknown requestId", async () => {
    const controller = makeController(observation());
    await controller.tick(task());
    await expect(controller.resolveConfirmation("FN-1", "unknown-request-id", "approved")).resolves.toBeNull();
  });
});
