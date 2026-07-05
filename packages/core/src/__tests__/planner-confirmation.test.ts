import { describe, expect, it } from "vitest";
import { classifyPlannerActionSideEffect, requiresPlannerConfirmation } from "../planner-confirmation.js";
import { decidePlannerRecovery, type PlannerRecoveryObservation } from "../planner-recovery.js";

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

describe("classifyPlannerActionSideEffect", () => {
  it("classifies merger and pull-request stage actions as merge_pr", () => {
    for (const stage of ["merger", "pull-request"] as const) {
      expect(classifyPlannerActionSideEffect({ watchedStage: stage, proposedAction: "advance_merge" })).toBe("merge_pr");
      expect(classifyPlannerActionSideEffect({ watchedStage: stage, proposedAction: "retry_step" })).toBe("merge_pr");
    }
  });

  it("classifies enumerated destructive/external actions as destructive_external regardless of stage", () => {
    const destructiveActions = [
      "delete_branch",
      "delete_worktree",
      "force_push",
      "force_merge",
      "force_delete",
      "push_remote",
      "call_external_service",
      "github_api_call",
      "gitlab_api_call",
      "open_pull_request",
      "merge_pull_request",
      "promote_shared_branch",
    ];
    for (const proposedAction of destructiveActions) {
      expect(classifyPlannerActionSideEffect({ watchedStage: "executor", proposedAction })).toBe("destructive_external");
      expect(classifyPlannerActionSideEffect({ watchedStage: null, proposedAction })).toBe("destructive_external");
    }
  });

  it("classifies bounded recovery actions on non-merge/PR stages as bounded_recovery", () => {
    for (const stage of ["executor", "reviewer", "workflow-gate"] as const) {
      for (const proposedAction of ["inject_guidance", "retry_step", "request_targeted_fix"]) {
        expect(classifyPlannerActionSideEffect({ watchedStage: stage, proposedAction })).toBe("bounded_recovery");
      }
    }
  });

  it("classifies no watched stage / empty action as bounded_recovery", () => {
    expect(classifyPlannerActionSideEffect({ watchedStage: null, proposedAction: "none" })).toBe("bounded_recovery");
    expect(classifyPlannerActionSideEffect({ watchedStage: undefined, proposedAction: undefined })).toBe("bounded_recovery");
  });

  it("fails closed (destructive_external) for an unknown non-bounded action on a non-merge/PR stage", () => {
    expect(classifyPlannerActionSideEffect({ watchedStage: "executor", proposedAction: "mystery_action" })).toBe(
      "destructive_external",
    );
  });

  it("never throws on malformed input", () => {
    expect(() => classifyPlannerActionSideEffect(undefined as never)).not.toThrow();
    expect(() => classifyPlannerActionSideEffect(null as never)).not.toThrow();
    expect(() => classifyPlannerActionSideEffect({} as never)).not.toThrow();
  });
});

describe("requiresPlannerConfirmation", () => {
  it("is true for merge_pr and destructive_external", () => {
    expect(requiresPlannerConfirmation("merge_pr")).toBe(true);
    expect(requiresPlannerConfirmation("destructive_external")).toBe(true);
  });

  it("is false for bounded_recovery and for null/undefined", () => {
    expect(requiresPlannerConfirmation("bounded_recovery")).toBe(false);
    expect(requiresPlannerConfirmation(null)).toBe(false);
    expect(requiresPlannerConfirmation(undefined)).toBe(false);
  });
});

describe("decidePlannerRecovery — confirmation gating (FN-7513)", () => {
  it("returns await_confirmation + requiresConfirmation for merger/pull-request stages", () => {
    for (const stage of ["merger", "pull-request"] as const) {
      const decision = decidePlannerRecovery({ snapshot: observation({ stage, signal: "failed" }) });
      expect(decision.action, `stage=${stage}`).toBe("await_confirmation");
      expect(decision.requiresConfirmation).toBe(true);
      expect(decision.sideEffectClass).toBe("merge_pr");
    }
  });

  it("keeps bounded-recovery decisions requiresConfirmation: false", () => {
    const decision = decidePlannerRecovery({ snapshot: observation({ stage: "reviewer", signal: "progressing" }) });
    expect(decision.action).toBe("inject_guidance");
    expect(decision.requiresConfirmation).toBe(false);
    expect(decision.sideEffectClass).toBe("bounded_recovery");
  });

  it("preserves the autonomous-only gate for confirmation-eligible stages", () => {
    for (const level of ["off", "observe", "steer"] as const) {
      const decision = decidePlannerRecovery({ snapshot: observation({ stage: "merger", oversightLevel: level, signal: "failed" }) });
      expect(decision.action, `level=${level}`).toBe("none");
      expect(decision.requiresConfirmation).toBe(false);
    }
  });

  it("preserves the attempt bound and exhaustion behavior for merger/pull-request stages", () => {
    const decision = decidePlannerRecovery({
      snapshot: observation({ stage: "merger", signal: "failed" }),
      attemptState: { attemptCount: 3, attemptLimit: 3 },
    });
    expect(decision.action).toBe("none");
    expect(decision.exhausted).toBe(true);
    expect(decision.requiresConfirmation).toBe(false);
  });

  it("never throws on partial snapshots and always carries a sideEffectClass", () => {
    const decision = decidePlannerRecovery({ snapshot: { taskId: "FN-1" } as unknown as PlannerRecoveryObservation });
    expect(decision.action).toBe("none");
    expect(decision.sideEffectClass).toBe("bounded_recovery");
    expect(decision.requiresConfirmation).toBe(false);
  });
});
