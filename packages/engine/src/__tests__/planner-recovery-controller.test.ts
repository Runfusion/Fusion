import { describe, expect, it, vi } from "vitest";
import { AWAITING_APPROVAL_PAUSE_REASON, PLANNER_RECOVERY_MAX_ATTEMPTS } from "@fusion/core";
import type { Task } from "@fusion/core";
import { PlannerRecoveryController, type PlannerRecoveryHandlers } from "../overseer/planner-recovery-controller.js";
import type { OverseerStageObservation, OverseerWatchedStage } from "../overseer/planner-overseer.js";

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

describe("PlannerRecoveryController.tick", () => {
  it("dispatches retryStep for a failed executor stage with no error source and increments the attempt count", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { retryStep });

    const decision = await controller.tick(task());
    expect(decision?.action).toBe("retry_step");
    expect(retryStep).toHaveBeenCalledTimes(1);
    expect(controller.getAttemptCount("FN-1", "executor")).toBe(1);
  });

  it("dispatches injectGuidance for a reviewer-stage decision", async () => {
    const injectGuidance = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation({ stage: "reviewer", signal: "progressing" }), { injectGuidance });

    const decision = await controller.tick(task());
    expect(decision?.action).toBe("inject_guidance");
    expect(injectGuidance).toHaveBeenCalledTimes(1);
  });

  it("dispatches requestTargetedFix when the failed observation carries an error source link", async () => {
    const requestTargetedFix = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(
      observation({ sources: [{ kind: "failed-check", ref: "chk-1" }] }),
      { requestTargetedFix },
    );

    const decision = await controller.tick(task());
    expect(decision?.action).toBe("request_targeted_fix");
    expect(requestTargetedFix).toHaveBeenCalledTimes(1);
  });

  it("stops dispatching once the per-stage attempt budget is exhausted", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { retryStep });

    for (let i = 0; i < PLANNER_RECOVERY_MAX_ATTEMPTS; i++) {
      await controller.tick(task());
    }
    expect(retryStep).toHaveBeenCalledTimes(PLANNER_RECOVERY_MAX_ATTEMPTS);

    const exhaustedDecision = await controller.tick(task());
    expect(exhaustedDecision?.action).toBe("none");
    expect(exhaustedDecision?.exhausted).toBe(true);
    expect(retryStep).toHaveBeenCalledTimes(PLANNER_RECOVERY_MAX_ATTEMPTS);
  });

  // FN-7577: a stale recovery attempt must not keep a recovered task badged
  // "recovering" — a healthy/human-wait signal on the next tick clears the
  // per-(taskId, stage) attempt + last-action records, restoring a fresh budget.
  it("clears stale attempt records once the stage reports a healthy signal", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    let current: OverseerStageObservation = observation({ signal: "failed" });
    const controller = new PlannerRecoveryController({
      snapshotProvider: { getSnapshot: () => current },
      handlers: { retryStep },
    });

    await controller.tick(task());
    expect(controller.getAttemptCount("FN-1", "executor")).toBe(1);
    expect(controller.getLastAction("FN-1", "executor")).toBe("retry_step");

    // Task recovers → healthy signal on the next tick clears the registry.
    current = observation({ signal: "progressing" });
    const healthy = await controller.tick(task());
    expect(healthy?.action).toBe("none");
    expect(controller.getAttemptCount("FN-1", "executor")).toBe(0);
    expect(controller.getLastAction("FN-1", "executor")).toBeUndefined();

    // A later genuine failure starts from a fresh budget and dispatches again.
    current = observation({ signal: "failed" });
    await controller.tick(task());
    expect(retryStep).toHaveBeenCalledTimes(2);
    expect(controller.getAttemptCount("FN-1", "executor")).toBe(1);
  });

  it("is inert when effectiveLevel/oversightLevel is off/observe/steer", async () => {
    for (const level of ["off", "observe", "steer"] as const) {
      const retryStep = vi.fn().mockResolvedValue(undefined);
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const controller = makeController(observation({ oversightLevel: level }), { retryStep, injectGuidance });
      const decision = await controller.tick(task());
      expect(decision?.action, `level=${level}`).toBe("none");
      expect(retryStep).not.toHaveBeenCalled();
      expect(injectGuidance).not.toHaveBeenCalled();
    }
  });

  it("is skipped entirely when task.userPaused is true", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { retryStep });
    const decision = await controller.tick(task({ userPaused: true }));
    expect(decision).toBeNull();
    expect(retryStep).not.toHaveBeenCalled();
  });

  it("exposes only the three bounded handlers — no merge/PR/destructive action is invocable", () => {
    const handlers: PlannerRecoveryHandlers = {};
    const allowed = new Set(["injectGuidance", "retryStep", "requestTargetedFix"]);
    // Structural assertion: the handlers interface accepts exactly these three optional members.
    const keys = Object.keys({ injectGuidance: undefined, retryStep: undefined, requestTargetedFix: undefined } satisfies Required<PlannerRecoveryHandlers>);
    for (const key of keys) {
      expect(allowed.has(key)).toBe(true);
    }
    void handlers;
  });

  it("clear(taskId) resets attempt state for that task", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    const controller = makeController(observation(), { retryStep });
    await controller.tick(task());
    expect(controller.getAttemptCount("FN-1", "executor")).toBe(1);
    controller.clear("FN-1");
    expect(controller.getAttemptCount("FN-1", "executor")).toBe(0);
  });

  it("never throws when a handler rejects", async () => {
    const retryStep = vi.fn().mockRejectedValue(new Error("boom"));
    const controller = makeController(observation(), { retryStep });
    await expect(controller.tick(task())).resolves.not.toThrow();
    // Attempt count should not increment on a failed dispatch.
    expect(controller.getAttemptCount("FN-1", "executor")).toBe(0);
  });

  it("never throws when the snapshot is absent, and returns null", async () => {
    const controller = makeController(null, {});
    await expect(controller.tick(task())).resolves.toBeNull();
  });

  it("never throws when the snapshot provider itself throws", async () => {
    const controller = new PlannerRecoveryController({
      snapshotProvider: {
        getSnapshot: () => {
          throw new Error("provider exploded");
        },
      },
    });
    await expect(controller.tick(task())).resolves.toBeNull();
  });

  it("adapts a getObservations()-style source (PlannerOverseerMonitor shape) via its latest observation", async () => {
    const retryStep = vi.fn().mockResolvedValue(undefined);
    const controller = new PlannerRecoveryController({
      snapshotProvider: {
        getObservations: () => [observation({ signal: "progressing" }), observation({ signal: "failed" })],
      },
      handlers: { retryStep },
    });
    const decision = await controller.tick(task());
    expect(decision?.action).toBe("retry_step");
    expect(retryStep).toHaveBeenCalledTimes(1);
  });

  // FN-7743: a `stuck` executor observation (a genuinely hung/idle in-progress
  // task, the FN-7732 symptom) must reach bounded recovery exactly like a
  // `failed`/`blocked` one — `inject_guidance`, dispatched once per tick, with
  // the attempt budget incrementing — and a withheld (user-paused) task must
  // still dispatch nothing even though its stage is `stuck`.
  describe("FN-7743 stuck executor observation", () => {
    it("dispatches inject_guidance exactly once and increments the attempt budget for a stuck executor stage", async () => {
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const controller = makeController(observation({ stage: "executor", signal: "stuck", reason: "Executor stage inactive for over 3h with no execution activity" }), {
        injectGuidance,
      });

      const decision = await controller.tick(task());
      expect(decision?.action).toBe("inject_guidance");
      expect(injectGuidance).toHaveBeenCalledTimes(1);
      expect(controller.getAttemptCount("FN-1", "executor")).toBe(1);
    });

    it("dispatches nothing for a stuck executor stage when the task is user-paused (human-control withhold wins)", async () => {
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const controller = makeController(observation({ stage: "executor", signal: "stuck" }), { injectGuidance });

      const decision = await controller.tick(task({ userPaused: true }));
      expect(decision).toBeNull();
      expect(injectGuidance).not.toHaveBeenCalled();
      expect(controller.getAttemptCount("FN-1", "executor")).toBe(0);
    });

    it("dispatches nothing for a stuck executor stage when the task is approval-blocked (human-control withhold wins)", async () => {
      const injectGuidance = vi.fn().mockResolvedValue(undefined);
      const controller = makeController(observation({ stage: "executor", signal: "stuck" }), { injectGuidance });

      const decision = await controller.tick(task({ paused: true, pausedReason: AWAITING_APPROVAL_PAUSE_REASON }));
      expect(decision).toBeNull();
      expect(injectGuidance).not.toHaveBeenCalled();
    });

    it("is inert for a stuck executor stage when effectiveLevel is off/observe/steer (no autonomous dispatch)", async () => {
      for (const level of ["off", "observe", "steer"] as const) {
        const injectGuidance = vi.fn().mockResolvedValue(undefined);
        const controller = makeController(observation({ stage: "executor", signal: "stuck", oversightLevel: level }), {
          injectGuidance,
        });
        const decision = await controller.tick(task());
        expect(decision?.action, `level=${level}`).toBe("none");
        expect(injectGuidance).not.toHaveBeenCalled();
      }
    });
  });
});
