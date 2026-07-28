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

/*
FNXC:PlanReviewLease 2026-07-26-21:25:
Node-attributed lease reclaim (FN-8603 follow-up). Liveness used to be judged purely by the staleness
floor, so a lease left behind by THIS node's crashed process was indistinguishable from a peer's
running one and had to age out — ~14 minutes of dead wait after an engine restart. These pin the
narrow widening: only an own-node lease predating our boot reclaims early. Every other shape must
keep the floor, because reclaiming a live lease double-dispatches a reviewer.
*/
describe("classifyReviewLease — node-attributed pre-boot reclaim", () => {
  const BOOT = Date.parse("2026-07-26T18:20:00.000Z");
  const NOW = BOOT + 60_000; // one minute after boot; well inside the 15-minute floor
  const lease = (over: Partial<WorkflowStepResult> = {}): WorkflowStepResult[] => ([{
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    status: "pending",
    startedAt: new Date(BOOT - 34_000).toISOString(), // 34s BEFORE boot — the FN-8603 shape
    leaseOwner: "run-1",
    ...over,
  }]);
  const local = { nodeId: "node-a", processBootAt: BOOT };

  it("reclaims an own-node lease that predates this process boot", () => {
    const d = classifyReviewLease(lease({ leaseNodeId: "node-a" }), "code-review", NOW, undefined, local);
    expect(d.kind).toBe("reclaim");
  });

  it("adopts a peer-node lease of the same age (we cannot prove a peer is dead)", () => {
    const d = classifyReviewLease(lease({ leaseNodeId: "node-b" }), "code-review", NOW, undefined, local);
    expect(d.kind).toBe("adopt");
  });

  it("adopts an unattributed legacy lease of the same age", () => {
    const d = classifyReviewLease(lease(), "code-review", NOW, undefined, local);
    expect(d.kind).toBe("adopt");
  });

  it("adopts an own-node lease taken AFTER boot — that is a live in-process claim", () => {
    const results = lease({ leaseNodeId: "node-a", startedAt: new Date(BOOT + 5_000).toISOString() });
    expect(classifyReviewLease(results, "code-review", NOW, undefined, local).kind).toBe("adopt");
  });

  it("keeps pure floor semantics when no local identity is supplied", () => {
    const d = classifyReviewLease(lease({ leaseNodeId: "node-a" }), "code-review", NOW);
    expect(d.kind).toBe("adopt");
  });
});
