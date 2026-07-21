/*
FNXC:WorkflowTransitionPolicy 2026-07-18-20:05:
U1 / KTD-5 — unit coverage for the pure shared transition validator. The policy
module has no store or engine dependency, so these tests construct trait flags
directly and assert the invariant verdicts in isolation. The "identical across
movers" postcondition (U1 scenario 7) is proven here at the pure-function level:
because every mover funnels through moveTaskInternal → this one policy, identical
facts always yield the identical rejection.
*/
import { describe, expect, it } from "vitest";

import type { TraitFlags } from "../../trait-types.js";
import {
  type TransitionColumnFacts,
  evaluateCapacityRejection,
  evaluateMergeBlockerPostcondition,
  evaluateTerminalReentryPostcondition,
  evaluateTransitionInvariants,
  isHoldToWipBoundary,
  isTerminalColumn,
  isWipColumn,
} from "../../workflow-transition-policy.js";

const facts = (columnId: string, flags: TraitFlags): TransitionColumnFacts => ({ columnId, flags });

const WIP: TraitFlags = { countsTowardWip: true };
const HOLD: TraitFlags = { hold: true };
const COMPLETE: TraitFlags = { complete: true };
const ARCHIVED: TraitFlags = { archived: true };
const HUMAN_REVIEW: TraitFlags = { humanReview: true, mergeBlocker: true };

describe("workflow-transition-policy — merge-blocker on complete-bound entry", () => {
  it("rejects entry into a complete column while a blocker is unresolved", () => {
    const rejection = evaluateMergeBlockerPostcondition({
      taskId: "T1",
      from: facts("in-review", HUMAN_REVIEW),
      to: facts("done", COMPLETE),
      mergeBlockerReason: "task is not merged",
    });
    expect(rejection).not.toBeNull();
    expect(rejection?.code).toBe("merge-blocked");
    expect(rejection?.retryable).toBe(true);
    expect(rejection?.detail).toBe("task is not merged");
  });

  it("allows entry into a complete column when the blocker is clear", () => {
    expect(
      evaluateMergeBlockerPostcondition({
        taskId: "T1",
        from: facts("in-review", HUMAN_REVIEW),
        to: facts("done", COMPLETE),
        mergeBlockerReason: null,
      }),
    ).toBeNull();
  });

  it("does not fire for a non-complete target even with a blocker present", () => {
    expect(
      evaluateMergeBlockerPostcondition({
        taskId: "T1",
        from: facts("in-progress", WIP),
        to: facts("in-review", HUMAN_REVIEW),
        mergeBlockerReason: "still working",
      }),
    ).toBeNull();
  });
});

describe("workflow-transition-policy — terminal → wip re-entry", () => {
  it("rejects moving a completed card back into a wip column", () => {
    const rejection = evaluateTerminalReentryPostcondition({
      taskId: "T2",
      from: facts("done", COMPLETE),
      to: facts("in-progress", WIP),
      mergeBlockerReason: null,
    });
    expect(rejection?.code).toBe("guard-rejected");
    expect(rejection?.retryable).toBe(false);
  });

  it("rejects moving an archived card into a wip column", () => {
    expect(
      evaluateTerminalReentryPostcondition({
        taskId: "T2",
        from: facts("archived", ARCHIVED),
        to: facts("in-progress", WIP),
        mergeBlockerReason: null,
      })?.code,
    ).toBe("guard-rejected");
  });

  it("allows a completed card to reopen into a hold column", () => {
    expect(
      evaluateTerminalReentryPostcondition({
        taskId: "T2",
        from: facts("done", COMPLETE),
        to: facts("todo", HOLD),
        mergeBlockerReason: null,
      }),
    ).toBeNull();
  });

  it("does not fire when the source column is not terminal", () => {
    expect(
      evaluateTerminalReentryPostcondition({
        taskId: "T2",
        from: facts("in-review", HUMAN_REVIEW),
        to: facts("in-progress", WIP),
        mergeBlockerReason: null,
      }),
    ).toBeNull();
  });
});

describe("workflow-transition-policy — capacity decision (KTD-5/KTD-9)", () => {
  it("rejects when occupants reach the finite limit", () => {
    const rejection = evaluateCapacityRejection("in-progress", { limit: 2, occupants: 2 });
    expect(rejection?.code).toBe("capacity-exhausted");
    expect(rejection?.retryable).toBe(true);
    expect(rejection?.detail).toContain("2/2");
  });

  it("allows when there is a free slot", () => {
    expect(evaluateCapacityRejection("in-progress", { limit: 2, occupants: 1 })).toBeNull();
  });

  it("never gates a non-finite limit or absent capacity", () => {
    expect(evaluateCapacityRejection("in-progress", { limit: Infinity, occupants: 99 })).toBeNull();
    expect(evaluateCapacityRejection("in-progress", null)).toBeNull();
    expect(evaluateCapacityRejection("in-progress", undefined)).toBeNull();
  });
});

describe("workflow-transition-policy — combined invariants + classification", () => {
  it("evaluates merge-blocker before terminal re-entry (first rejection wins)", () => {
    // Contrived: a complete-and-wip-ish target would be rejected by trait
    // validation upstream, but the ordering is asserted directly on the policy.
    const decision = evaluateTransitionInvariants({
      taskId: "T3",
      from: facts("done", COMPLETE),
      to: facts("done", { complete: true, countsTowardWip: true }),
      mergeBlockerReason: "blocked",
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.rejection.code).toBe("merge-blocked");
  });

  it("allows a clean success-path boundary", () => {
    expect(
      evaluateTransitionInvariants({
        taskId: "T3",
        from: facts("in-progress", WIP),
        to: facts("in-review", HUMAN_REVIEW),
        mergeBlockerReason: null,
      }).allow,
    ).toBe(true);
  });

  it("yields byte-identical rejections for identical facts (scenario 7: same verdict for every mover)", () => {
    const input = {
      taskId: "T4",
      from: facts("in-review", HUMAN_REVIEW),
      to: facts("done", COMPLETE),
      mergeBlockerReason: "not merged",
    };
    const a = evaluateTransitionInvariants(input);
    const b = evaluateTransitionInvariants(input);
    expect(a).toEqual(b);
    expect(a.allow).toBe(false);
  });

  it("classifies wip / terminal columns and the hold→wip seam (KTD-2)", () => {
    expect(isWipColumn(WIP)).toBe(true);
    expect(isTerminalColumn(COMPLETE)).toBe(true);
    expect(isTerminalColumn(ARCHIVED)).toBe(true);
    expect(isHoldToWipBoundary(HOLD, WIP)).toBe(true);
    expect(isHoldToWipBoundary(WIP, WIP)).toBe(false);
    expect(isHoldToWipBoundary(HOLD, HUMAN_REVIEW)).toBe(false);
  });
});
