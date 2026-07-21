/*
FNXC:PlanReviewLease 2026-07-19-01:10:
U3 / KTD-4/R5 — pure unit coverage for the review-gate LEASE classifier. A pending
Plan Review result is a lease: a re-entering run adopts a live lease (never
dispatches a second reviewer) and reclaims only past the staleness floor. This is
the mechanism that makes the duplicate-reviewer interleaving impossible; the graph
integration is covered in plan-review-single-owner.test.ts.
*/
import { describe, expect, it } from "vitest";
import type { WorkflowStepResult } from "@fusion/core";
import {
  PLAN_REVIEW_LEASE_STALENESS_MS,
  classifyReviewLease,
  isTerminalStepResult,
  makeReviewLeaseRecord,
} from "@fusion/core";

const STEP = "plan-review";
const T0 = Date.parse("2026-07-19T00:00:00.000Z");

const lease = (over: Partial<WorkflowStepResult> = {}): WorkflowStepResult => ({
  workflowStepId: STEP,
  workflowStepName: "Plan Review",
  status: "pending",
  startedAt: new Date(T0).toISOString(),
  leaseOwner: "run-A",
  ...over,
});

describe("classifyReviewLease (KTD-4)", () => {
  it("claims when no prior result exists", () => {
    expect(classifyReviewLease(undefined, STEP, T0)).toEqual({ kind: "claim" });
    expect(classifyReviewLease([], STEP, T0)).toEqual({ kind: "claim" });
  });

  it("treats a terminal (passed) result as settled — no re-dispatch", () => {
    const results = [lease({ status: "passed", completedAt: new Date(T0).toISOString() })];
    const d = classifyReviewLease(results, STEP, T0 + 1000);
    expect(d.kind).toBe("settled");
  });

  it("adopts a live lease within the staleness floor (no second reviewer)", () => {
    const d = classifyReviewLease([lease()], STEP, T0 + PLAN_REVIEW_LEASE_STALENESS_MS - 1);
    expect(d).toEqual({ kind: "adopt", owner: "run-A" });
  });

  it("adopts a live lease regardless of whether the owner matches (crash/restart honors it)", () => {
    // A restart re-enters with the SAME deterministic run id; within the floor it
    // still adopts (honors), never double-dispatches (U3 scenario 2, first half).
    const d = classifyReviewLease([lease({ leaseOwner: "run-A" })], STEP, T0 + 60_000);
    expect(d.kind).toBe("adopt");
  });

  it("reclaims a lease past the staleness floor (U3 scenario 2, second half)", () => {
    const d = classifyReviewLease([lease()], STEP, T0 + PLAN_REVIEW_LEASE_STALENESS_MS);
    expect(d).toEqual({ kind: "reclaim", priorOwner: "run-A" });
  });

  it("reclaims an ownerless or undated pending record (defensive)", () => {
    expect(classifyReviewLease([lease({ leaseOwner: undefined })], STEP, T0 + 1).kind).toBe("reclaim");
    expect(classifyReviewLease([lease({ startedAt: undefined })], STEP, T0 + 1).kind).toBe("reclaim");
  });

  it("honors a custom staleness floor", () => {
    const results = [lease()];
    expect(classifyReviewLease(results, STEP, T0 + 500, 1000).kind).toBe("adopt");
    expect(classifyReviewLease(results, STEP, T0 + 1000, 1000).kind).toBe("reclaim");
  });
});

describe("isTerminalStepResult", () => {
  it("classifies terminal vs. lease statuses", () => {
    for (const status of ["passed", "failed", "advisory_failure", "skipped"] as const) {
      expect(isTerminalStepResult({ workflowStepId: STEP, workflowStepName: "x", status })).toBe(true);
    }
    expect(isTerminalStepResult({ workflowStepId: STEP, workflowStepName: "x", status: "pending" })).toBe(false);
  });
});

describe("makeReviewLeaseRecord", () => {
  it("builds a pending lease record carrying the owner + clock", () => {
    const rec = makeReviewLeaseRecord({
      stepId: STEP,
      stepName: "Plan Review",
      owner: "run-Z",
      startedAt: new Date(T0).toISOString(),
      phase: "pre-merge",
      source: "optional-group",
    });
    expect(rec).toMatchObject({
      workflowStepId: STEP,
      status: "pending",
      leaseOwner: "run-Z",
      startedAt: new Date(T0).toISOString(),
      phase: "pre-merge",
      source: "optional-group",
    });
    // The record classifies as a live lease immediately after being written.
    expect(classifyReviewLease([rec], STEP, T0 + 1).kind).toBe("adopt");
  });
});
