import { describe, expect, it } from "vitest";
import {
  decidePlannerRecovery,
  PLANNER_RECOVERY_MAX_ATTEMPTS,
  type PlannerRecoveryObservation,
} from "../planner-recovery.js";

function observation(overrides: Partial<PlannerRecoveryObservation> = {}): PlannerRecoveryObservation {
  return {
    taskId: "FN-1",
    stage: "executor",
    signal: "progressing",
    oversightLevel: "autonomous",
    sources: [],
    ...overrides,
  };
}

describe("decidePlannerRecovery", () => {
  it("returns none when there is no observation (no watched stage)", () => {
    const decision = decidePlannerRecovery({ snapshot: null });
    expect(decision.action).toBe("none");
    expect(decision.exhausted).toBe(false);
    expect(decision.watchedStage).toBeNull();
  });

  it("returns none for every non-autonomous effective level", () => {
    for (const level of ["off", "observe", "steer"] as const) {
      const decision = decidePlannerRecovery({ snapshot: observation({ oversightLevel: level, signal: "failed" }) });
      expect(decision.action, `level=${level}`).toBe("none");
      expect(decision.exhausted).toBe(false);
    }
  });

  it("yields retry_step for a failed executor stage with no specific error source", () => {
    const decision = decidePlannerRecovery({ snapshot: observation({ stage: "executor", signal: "failed", sources: [] }) });
    expect(decision.action).toBe("retry_step");
    expect(decision.attemptCount).toBe(0);
    expect(decision.attemptLimit).toBe(PLANNER_RECOVERY_MAX_ATTEMPTS);
  });

  it("yields retry_step for a failed workflow-gate stage with no specific error source", () => {
    const decision = decidePlannerRecovery({ snapshot: observation({ stage: "workflow-gate", signal: "failed" }) });
    expect(decision.action).toBe("retry_step");
  });

  it("yields request_targeted_fix for a failed executor stage carrying a specific error source link", () => {
    const decision = decidePlannerRecovery({
      snapshot: observation({
        stage: "executor",
        signal: "failed",
        sources: [{ kind: "failed-check", ref: "check-1", url: "https://example.test/check-1" }],
      }),
      attemptState: { attemptCount: 1 },
    });
    expect(decision.action).toBe("request_targeted_fix");
    expect(decision.attemptCount).toBe(1);
    expect(decision.attemptLimit).toBe(PLANNER_RECOVERY_MAX_ATTEMPTS);
  });

  it("yields inject_guidance for a reviewer stage", () => {
    const decision = decidePlannerRecovery({ snapshot: observation({ stage: "reviewer", signal: "progressing" }) });
    expect(decision.action).toBe("inject_guidance");
  });

  it("yields inject_guidance for a stuck-but-not-failed stage", () => {
    const decision = decidePlannerRecovery({ snapshot: observation({ stage: "executor", signal: "stuck" }) });
    expect(decision.action).toBe("inject_guidance");
  });

  it("gates merger and pull-request stages behind confirmation (FN-7513) instead of none", () => {
    for (const stage of ["merger", "pull-request"] as const) {
      const decision = decidePlannerRecovery({ snapshot: observation({ stage, signal: "failed" }) });
      expect(decision.action, `stage=${stage}`).toBe("await_confirmation");
      expect(decision.requiresConfirmation).toBe(true);
      expect(decision.sideEffectClass).toBe("merge_pr");
      expect(decision.proposedAction).toBeTruthy();
    }
  });

  it("keeps requiresConfirmation false for bounded-recovery decisions", () => {
    const decision = decidePlannerRecovery({ snapshot: observation({ stage: "executor", signal: "failed" }) });
    expect(decision.requiresConfirmation).toBe(false);
    expect(decision.sideEffectClass).toBe("bounded_recovery");
  });

  it("returns none + exhausted true exactly at the attempt limit", () => {
    const decision = decidePlannerRecovery({
      snapshot: observation({ stage: "executor", signal: "failed" }),
      attemptState: { attemptCount: PLANNER_RECOVERY_MAX_ATTEMPTS },
    });
    expect(decision.action).toBe("none");
    expect(decision.exhausted).toBe(true);
  });

  it("still allows action one attempt below the limit", () => {
    const decision = decidePlannerRecovery({
      snapshot: observation({ stage: "executor", signal: "failed" }),
      attemptState: { attemptCount: PLANNER_RECOVERY_MAX_ATTEMPTS - 1 },
    });
    expect(decision.action).not.toBe("none");
    expect(decision.exhausted).toBe(false);
  });

  it("never throws on missing/partial snapshot fields", () => {
    expect(() => decidePlannerRecovery({ snapshot: undefined })).not.toThrow();
    expect(() => decidePlannerRecovery({} as never)).not.toThrow();
    expect(() =>
      decidePlannerRecovery({ snapshot: { taskId: "FN-1" } as unknown as PlannerRecoveryObservation }),
    ).not.toThrow();
    const decision = decidePlannerRecovery({ snapshot: { taskId: "FN-1" } as unknown as PlannerRecoveryObservation });
    expect(decision.action).toBe("none");
  });

  it("respects a custom attemptLimit override", () => {
    const decision = decidePlannerRecovery({
      snapshot: observation({ stage: "executor", signal: "failed" }),
      attemptState: { attemptCount: 1, attemptLimit: 1 },
    });
    expect(decision.action).toBe("none");
    expect(decision.exhausted).toBe(true);
    expect(decision.attemptLimit).toBe(1);
  });
});
