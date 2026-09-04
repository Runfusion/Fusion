import { describe, expect, it } from "vitest";

import {
  ENGINE_BACKWARD_MOVE_REASONS,
  LIFECYCLE_ROLE_RANK,
  classifyLifecycleDirection,
  classifyLifecycleRole,
  evaluateForbiddenLifecyclePath,
  isSanctionedEngineBackwardMove,
  type LifecycleRole,
} from "../workflows/workflow-lifecycle-direction.js";
import { evaluateLifecycleDirectionPostcondition } from "../workflows/workflow-transition-policy.js";

const policyInput = (fromFlags: object, toFlags: object, options: Partial<{ moveSource: "user" | "engine" | "scheduler"; lifecycleReason: string }> = {}) => ({
  taskId: "FN-207",
  from: { columnId: "from", flags: fromFlags },
  to: { columnId: "to", flags: toFlags },
  mergeBlockerReason: null,
  ...options,
});

describe("workflow lifecycle direction", () => {
  it("orders lifecycle roles from intake through archived", () => {
    expect(LIFECYCLE_ROLE_RANK).toEqual({
      intake: 0,
      hold: 1,
      wip: 2,
      review: 3,
      complete: 4,
      archived: 5,
    });
  });

  it("classifies effective column flags with highest-rank precedence", () => {
    expect(classifyLifecycleRole({ intake: true, hold: true })).toBe("hold");
    expect(classifyLifecycleRole({ mergeBlocker: true, humanReview: true, mergeOrchestration: true })).toBe("review");
    expect(classifyLifecycleRole({ archived: true, complete: true, countsTowardWip: true })).toBe("archived");
    expect(classifyLifecycleRole({})).toBeUndefined();
  });

  it("classifies every lifecycle direction without inventing trait-less roles", () => {
    expect(classifyLifecycleDirection("hold", "wip")).toBe("forward");
    expect(classifyLifecycleDirection("review", "wip")).toBe("backward");
    expect(classifyLifecycleDirection("wip", "wip")).toBe("lateral");
    expect(classifyLifecycleDirection(undefined, "wip")).toBe("unknown");
  });

  it("asserts the deny-list verdict for every ordered lifecycle role pair", () => {
    const roles: LifecycleRole[] = ["intake", "hold", "wip", "review", "complete", "archived"];
    const expectedRules: Record<LifecycleRole, Array<"F1" | "F2" | "F3" | "F4" | "F5" | null>> = {
      intake: ["F1", null, null, null, null, null],
      hold: ["F1", null, null, null, null, null],
      wip: ["F1", "F5", null, null, null, null],
      review: ["F1", "F2", null, null, null, "F3"],
      complete: ["F1", "F2", "F2", "F4", null, null],
      archived: ["F1", "F2", "F2", "F2", "F4", null],
    };

    for (const from of roles) {
      for (const [toIndex, to] of roles.entries()) {
        expect(evaluateForbiddenLifecyclePath(from, to)?.rule ?? null, `${from} → ${to}`)
          .toBe(expectedRules[from][toIndex]);
      }
    }

    expect(evaluateForbiddenLifecyclePath("wip", "hold", "plan-review-revise-replan")).toBeNull();
    expect(evaluateForbiddenLifecyclePath(undefined, "hold")).toBeNull();
    expect(evaluateForbiddenLifecyclePath("hold", undefined)).toBeNull();
  });

  it("requires a known reason whose declared role sets include the actual pair", () => {
    expect(isSanctionedEngineBackwardMove("code-review-revise-remediation", "review", "wip")).toBe(true);
    expect(isSanctionedEngineBackwardMove("code-review-revise-remediation", "wip", "hold")).toBe(false);
    expect(isSanctionedEngineBackwardMove("missing", "review", "wip")).toBe(false);
    expect(isSanctionedEngineBackwardMove(undefined, "review", "wip")).toBe(false);
  });

  it("enforces the direction policy only for explicitly automated moves", () => {
    expect(evaluateLifecycleDirectionPostcondition(policyInput({ mergeBlocker: true }, { hold: true }, {
      moveSource: "engine",
      lifecycleReason: "code-review-revise-remediation",
    }))?.messageKey).toBe("transition.rejected.forbiddenLifecyclePath");
    expect(evaluateLifecycleDirectionPostcondition(policyInput({ mergeBlocker: true }, { countsTowardWip: true }, {
      moveSource: "engine",
    }))?.messageKey).toBe("transition.rejected.unsanctionedLifecycleMove");
    expect(evaluateLifecycleDirectionPostcondition(policyInput({ mergeBlocker: true }, { countsTowardWip: true }, {
      moveSource: "scheduler",
      lifecycleReason: "code-review-revise-remediation",
    }))).toBeNull();
    expect(evaluateLifecycleDirectionPostcondition(policyInput({ mergeBlocker: true }, { hold: true }))).toBeNull();
    expect(evaluateLifecycleDirectionPostcondition(policyInput({}, { hold: true }, { moveSource: "engine" }))).toBeNull();
  });

  it("admits every retained reason only for its declared role pairs", () => {
    expect(isSanctionedEngineBackwardMove("plan-review-revise-replan", "wip", "hold")).toBe(true);
    for (const reason of ["code-review-revise-remediation", "verification-failure-remediation", "merge-fix-remediation"]) {
      expect(isSanctionedEngineBackwardMove(reason, "review", "wip")).toBe(true);
      expect(isSanctionedEngineBackwardMove(reason, "wip", "hold")).toBe(false);
    }
    for (const reason of [
      "self-healing-worktree-reclaim",
      "self-healing-stranded-recovery",
      "self-healing-dependency-rebound",
      "self-healing-session-recovery",
      "contamination-recovery",
      "branch-worktree-recovery",
      "capacity-hold-return",
    ]) {
      expect(isSanctionedEngineBackwardMove(reason, "review", "review")).toBe(true);
      expect(isSanctionedEngineBackwardMove(reason, "wip", "wip")).toBe(true);
      expect(isSanctionedEngineBackwardMove(reason, "review", "wip")).toBe(false);
      expect(isSanctionedEngineBackwardMove(reason, "wip", "hold")).toBe(false);
    }
    expect(isSanctionedEngineBackwardMove("merge-failure-rebound", "review", "review")).toBe(true);
    expect(isSanctionedEngineBackwardMove("merge-failure-rebound", "review", "wip")).toBe(false);
  });

  it("rejects every removed reason and graph wildcard as backward authority", () => {
    for (const reason of [
      "workflow-graph-node-column",
      "execution-resume",
      "stale-spec-replan",
      "blocked-exit-replan",
      "missing-required-artifact-recovery",
      "workflow-retry-rehome",
    ]) {
      expect(ENGINE_BACKWARD_MOVE_REASONS).not.toHaveProperty(reason);
      expect(isSanctionedEngineBackwardMove(reason, "review", "wip")).toBe(false);
      expect(isSanctionedEngineBackwardMove(reason, "wip", "hold")).toBe(false);
    }
  });

  it("classifies duplicate WIP lanes and a renamed review lane by traits", () => {
    const firstWip = classifyLifecycleRole({ countsTowardWip: true });
    const secondWip = classifyLifecycleRole({ countsTowardWip: true, hold: true });
    const renamedReview = classifyLifecycleRole({ mergeBlocker: true });
    expect([firstWip, secondWip, renamedReview]).toEqual(["wip", "wip", "review"]);
    expect(evaluateLifecycleDirectionPostcondition(policyInput(
      { mergeBlocker: true },
      { countsTowardWip: true },
      { moveSource: "engine", lifecycleReason: "code-review-revise-remediation" },
    ))).toBeNull();
  });

  it.each([
    ["merge-blocker", { mergeBlocker: true }],
    ["human-review", { humanReview: true }],
    ["merge-orchestration", { mergeOrchestration: true }],
  ])("permits a renamed %s review lane to advance to a trait-derived complete lane", (_trait, reviewFlags) => {
    expect(evaluateLifecycleDirectionPostcondition(policyInput(
      reviewFlags,
      { complete: true },
      { moveSource: "engine" },
    ))).toBeNull();
  });
});
