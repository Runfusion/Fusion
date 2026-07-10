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

  // FN-7577: a healthy or human-wait signal must NOT trigger autonomous
  // steering on the executor/workflow-gate fall-through — steering a task that
  // reports it is progressing flipped every card's badge to "recovering" and
  // burned AI usage via a needless inject_guidance dispatch. Invariant across
  // both fall-through stages and both problem/healthy signal classes.
  it("returns none for healthy/human-wait signals on executor and workflow-gate stages", () => {
    for (const stage of ["executor", "workflow-gate"] as const) {
      for (const signal of ["progressing", "complete", "awaiting-human"] as const) {
        const decision = decidePlannerRecovery({ snapshot: observation({ stage, signal }) });
        expect(decision.action, `stage=${stage} signal=${signal}`).toBe("none");
        expect(decision.exhausted, `stage=${stage} signal=${signal}`).toBe(false);
        expect(decision.requiresConfirmation, `stage=${stage} signal=${signal}`).toBe(false);
      }
    }
  });

  it("still steers on problem signals (stuck/blocked) for executor and workflow-gate stages", () => {
    for (const stage of ["executor", "workflow-gate"] as const) {
      for (const signal of ["stuck", "blocked"] as const) {
        const decision = decidePlannerRecovery({ snapshot: observation({ stage, signal }) });
        expect(decision.action, `stage=${stage} signal=${signal}`).toBe("inject_guidance");
      }
    }
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

  // FN-7692: the `reason` copy must accurately reflect whether the active
  // auto-merge policy will advance the merge/PR unattended (advisory,
  // non-blocking wording) or genuinely requires a human approval (blocking
  // wording) — never the old unconditional "requires explicit confirmation
  // before ... may run" claim, which was false whenever auto-merge would
  // proceed on its own (observed on FN-7689). `action`/`requiresConfirmation`/
  // `sideEffectClass` must stay byte-for-byte identical across all three
  // `autoMergeWillProceed` states — this is messaging-only.
  it("produces accurate advisory copy when auto-merge will proceed unattended, for both merger and pull-request stages", () => {
    for (const stage of ["merger", "pull-request"] as const) {
      const decision = decidePlannerRecovery({
        snapshot: observation({ stage, signal: "failed" }),
        autoMergeWillProceed: true,
      });
      expect(decision.action, `stage=${stage}`).toBe("await_confirmation");
      expect(decision.requiresConfirmation, `stage=${stage}`).toBe(true);
      expect(decision.sideEffectClass, `stage=${stage}`).toBe("merge_pr");
      expect(decision.reason, `stage=${stage}`).not.toMatch(/requires explicit confirmation before .* may run/);
      expect(decision.reason, `stage=${stage}`).toMatch(/automatically/i);
      expect(decision.reason, `stage=${stage}`).toMatch(/advisory/i);
    }
  });

  it("produces accurate blocking copy when auto-merge will NOT proceed unattended, for both merger and pull-request stages", () => {
    for (const stage of ["merger", "pull-request"] as const) {
      const decision = decidePlannerRecovery({
        snapshot: observation({ stage, signal: "failed" }),
        autoMergeWillProceed: false,
      });
      expect(decision.action, `stage=${stage}`).toBe("await_confirmation");
      expect(decision.requiresConfirmation, `stage=${stage}`).toBe(true);
      expect(decision.sideEffectClass, `stage=${stage}`).toBe("merge_pr");
      expect(decision.reason, `stage=${stage}`).toMatch(/will not .* until a human explicitly approves/);
      expect(decision.reason, `stage=${stage}`).not.toMatch(/advisory/i);
    }
  });

  it("uses neutral, non-overclaiming copy when the auto-merge policy is unknown to the caller", () => {
    for (const stage of ["merger", "pull-request"] as const) {
      const decision = decidePlannerRecovery({ snapshot: observation({ stage, signal: "failed" }) });
      expect(decision.reason, `stage=${stage}`).not.toMatch(/requires explicit confirmation before .* may run/);
      expect(decision.reason, `stage=${stage}`).not.toMatch(/automatically/i);
      expect(decision.reason, `stage=${stage}`).not.toMatch(/will not .* until a human explicitly approves/);
    }
  });

  it("keeps action/requiresConfirmation/sideEffectClass byte-for-byte unchanged across autoMergeWillProceed states (messaging-only guard)", () => {
    for (const stage of ["merger", "pull-request"] as const) {
      const base = decidePlannerRecovery({ snapshot: observation({ stage, signal: "failed" }) });
      const proceeds = decidePlannerRecovery({
        snapshot: observation({ stage, signal: "failed" }),
        autoMergeWillProceed: true,
      });
      const blocks = decidePlannerRecovery({
        snapshot: observation({ stage, signal: "failed" }),
        autoMergeWillProceed: false,
      });
      for (const decision of [base, proceeds, blocks]) {
        expect(decision.action, `stage=${stage}`).toBe("await_confirmation");
        expect(decision.requiresConfirmation, `stage=${stage}`).toBe(true);
        expect(decision.sideEffectClass, `stage=${stage}`).toBe("merge_pr");
        expect(decision.proposedAction, `stage=${stage}`).toBe(base.proposedAction);
      }
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

  // FN-7743 invariant lock: a stalled non-paused in-progress task (the FN-7732
  // symptom) is surfaced by the overseer as `stage: "executor", signal: "stuck"`.
  // This asserts the downstream mapping this fix depends on — executor `stuck`
  // → `inject_guidance`, not `none` — already holds and stays locked, so a
  // future regression here is caught even though FN-7743 itself only changes
  // the observation INPUT, never this mapping.
  it("FN-7743: maps an executor stuck signal to inject_guidance (the hung-executor recovery path)", () => {
    const decision = decidePlannerRecovery({ snapshot: observation({ stage: "executor", signal: "stuck" }) });
    expect(decision.action).toBe("inject_guidance");
    expect(decision.requiresConfirmation).toBe(false);
  });
});
